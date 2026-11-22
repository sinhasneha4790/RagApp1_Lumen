// Gemini client: embeddings (batchEmbedContents) and streamed chat (Interactions API).
// Uses built-in fetch only. The API key is sent as a header and never logged or echoed.

import { getConfig, LIMITS } from './config.js';
import { buildSystemInstruction } from './prompt.js';

export class GeminiError extends Error {
  constructor(status, message, upstreamStatus, retryAfter) {
    super(message); this.status = status; this.upstreamStatus = upstreamStatus; this.retryAfter = retryAfter;
  }
}

/** Seconds to wait from an upstream 429: Retry-After header, else google.rpc.RetryInfo retryDelay. */
function retryAfterOf(r, j) {
  const h = Number(r.headers?.get?.('retry-after'));
  if (h > 0) return Math.ceil(h);
  for (const d of j?.error?.details || []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay || '');
    if (m) return Math.max(1, Math.ceil(Number(m[1])));
  }
  return undefined;
}

const UNAVAILABLE = 'Gemini is unavailable, try again';

/** Maps an upstream HTTP error to the status/message we return (spec 7.4). */
export async function geminiError(r) {
  const s = r.status;
  if (s >= 500) return new GeminiError(502, UNAVAILABLE, s);
  let msg = `Gemini API error ${s}`, j;
  try { j = await r.json(); msg = j?.error?.message || j?.message || msg; } catch {}
  if (s === 401 || s === 403) return new GeminiError(502, `${msg} — check that your API key is valid and restricted to the Gemini API`, s);
  if (s === 429) return new GeminiError(429, `${msg} — rate limit reached, try again shortly`, s, retryAfterOf(r, j));
  return new GeminiError(502, msg, s);
}

export function normalize(v) {
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Builds the :batchEmbedContents request items for one batch. */
export function embedRequests(texts, kind, cfg = getConfig()) {
  const isV2 = cfg.embedModel.startsWith('gemini-embedding-2');
  return texts.map(t => {
    const text = isV2 ? (kind === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}`) : t;
    const r = { model: `models/${cfg.embedModel}`, content: { parts: [{ text }] }, outputDimensionality: cfg.embedDim };
    if (!isV2) r.taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    return r;
  });
}

/**
 * Embeds texts; returns L2-normalised vectors in input order.
 * Retries once after 800 ms on 429 or 5xx (embeddings only).
 * `meta.upstreamStatus` receives the last upstream HTTP status (for logs).
 */
export async function embed(texts, kind, { cfg = getConfig(), retryDelay = 800, meta = {} } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += LIMITS.geminiBatch) {
    const batch = texts.slice(i, i + LIMITS.geminiBatch);
    const body = JSON.stringify({ requests: embedRequests(batch, kind, cfg) });
    const url = `${cfg.baseUrl}/v1beta/models/${cfg.embedModel}:batchEmbedContents`;
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey }, body });
      } catch {
        throw new GeminiError(502, UNAVAILABLE);
      }
      meta.upstreamStatus = r.status;
      if ((r.status === 429 || r.status >= 500) && attempt === 0) { await r.body?.cancel().catch(() => {}); await sleep(retryDelay); continue; }
      break;
    }
    if (!r.ok) throw await geminiError(r);
    let j;
    try { j = await r.json(); } catch { throw new GeminiError(502, 'Gemini returned an invalid embeddings response'); }
    const embs = j.embeddings || [];
    if (embs.length !== batch.length) throw new GeminiError(502, 'Embedding count mismatch from Gemini');
    for (const e of embs) {
      if (!Array.isArray(e?.values)) throw new GeminiError(502, 'Gemini returned an invalid embeddings response');
      out.push(normalize(e.values));
    }
  }
  return out;
}

/* ---------------- Chat ---------------- */

export function buildInteractionBody({ question, context, history, thinking }, cfg = getConfig()) {
  const input = [
    ...history.map(m => ({ type: m.role === 'assistant' ? 'model_output' : 'user_input', content: [{ type: 'text', text: m.content }] })),
    { type: 'user_input', content: [{ type: 'text', text: question }] }
  ];
  return {
    model: cfg.chatModel,
    system_instruction: buildSystemInstruction(context),
    input,
    stream: true,
    store: false,
    generation_config: { thinking_level: thinking, thinking_summaries: 'auto' }
  };
}

/** Starts the upstream interaction. Throws GeminiError before any streaming starts. */
export async function openInteraction(payload, { cfg = getConfig(), signal } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey };
  if (cfg.apiRevision) headers['Api-Revision'] = cfg.apiRevision;
  let r;
  try {
    r = await fetch(`${cfg.baseUrl}/${cfg.apiVersion}/interactions?alt=sse`, {
      method: 'POST', headers, body: JSON.stringify(buildInteractionBody(payload, cfg)), signal
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new GeminiError(502, UNAVAILABLE);
  }
  if (!r.ok) throw await geminiError(r);
  return r;
}

/** Maps one parsed upstream event to zero or more client events (spec 7.3). */
export function mapEvent(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const t = ev.event_type;
  if (t === 'step.start') return ev.step?.type ? [{ step: ev.step.type }] : [];
  if (t === 'step.delta') {
    const d = ev.delta || {};
    if (d.type === 'text') return d.text ? [{ t: d.text }] : [];
    if (d.type === 'thought_summary') { const th = d.content?.text ?? d.text; return th ? [{ th }] : []; }
    return [];
  }
  if (t === 'error' || ev.error) return [{ error: ev.error?.message || 'Gemini returned an error' }];
  if (t === 'interaction.completed') {
    const out = [];
    if (ev.interaction?.usage) out.push({ usage: ev.interaction.usage });
    const st = ev.interaction?.status;
    if (st && st !== 'completed') out.push({ error: `Generation ended with status "${st}"` });
    return out;
  }
  return [];
}

/** Incremental SSE parser. Feed decoded text with push(); handles \n\n and \r\n\r\n separators. */
export function createSSEParser(onEvent) {
  let buf = '';
  const block = b => {
    const data = b.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let ev; try { ev = JSON.parse(data); } catch { return; }
    for (const out of mapEvent(ev)) onEvent(out);
  };
  return {
    push(text) {
      buf += text;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) { const b = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); block(b); }
    },
    end() { if (buf.trim()) block(buf); buf = ''; }
  };
}

/** Joins the text of model_output steps from a non-streamed interaction. */
export function textFromInteraction(j) {
  const steps = Array.isArray(j?.steps) ? j.steps : [];
  return steps.filter(s => s?.type === 'model_output')
    .flatMap(s => Array.isArray(s.content) ? s.content : [])
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text).join('');
}

/**
 * Pipes an upstream interaction response to `emit`. Stops forwarding after the first
 * error event. Returns true if an error was emitted.
 */
export async function pipeInteraction(upstream, emit) {
  let failed = false;
  const send = ev => { if (failed) return; if (ev.error) failed = true; emit(ev); };
  if ((upstream.headers.get('content-type') || '').includes('application/json')) {
    const j = await upstream.json();
    const text = textFromInteraction(j);
    if (j?.status && j.status !== 'completed') send({ error: `Generation ended with status "${j.status}"` });
    else if (text) send({ t: text });
    if (j?.usage) send({ usage: j.usage });
  } else {
    const dec = new TextDecoder();
    const p = createSSEParser(send);
    for await (const chunk of upstream.body) p.push(dec.decode(chunk, { stream: true }));
    p.push(dec.decode()); p.end();
  }
  if (!failed) emit({ done: true });
  return failed;
}
