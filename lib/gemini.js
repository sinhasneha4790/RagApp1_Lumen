// Gemini client: embeddings only (batchEmbedContents). Answers come from Groq (lib/groq.js).
// Uses built-in fetch only. The API key is sent as a header and never logged or echoed.

import { getConfig, LIMITS } from './config.js';
import { redact } from './http.js';

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

/**
 * Maps an upstream HTTP error to the status/message we return (spec 7.4).
 * Also logs Gemini's own error text (max 300 chars, keys redacted) so failures can be
 * diagnosed from the logs; clients still get the mapped message only.
 */
export async function geminiError(r) {
  const s = r.status;
  let msg = `Gemini API error ${s}`, j, raw = '';
  try { raw = await r.text(); } catch {}
  try { j = JSON.parse(raw); msg = j?.error?.message || j?.message || msg; } catch {}
  const detail = j?.error ? [j.error.status, j.error.message].filter(Boolean).join(': ') : raw;
  console.warn(`gemini upstream ${s}: ${redact(detail || '(empty body)').replace(/\s+/g, ' ').slice(0, 300)}`);
  if (s >= 500) return new GeminiError(502, UNAVAILABLE, s);
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
