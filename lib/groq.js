// Groq client: streamed answers through the OpenAI-compatible Chat Completions API.
// POST {GROQ_BASE_URL}/chat/completions with Authorization: Bearer <GROQ_API_KEY>.
// Uses built-in fetch only; the key is never logged or echoed.

import { getConfig } from './config.js';
import { buildSystemInstruction } from './prompt.js';
import { redact } from './http.js';
import { createSSEParser } from './sse.js';

export class GroqError extends Error {
  constructor(status, message, upstreamStatus, retryAfter) {
    super(message); this.status = status; this.upstreamStatus = upstreamStatus; this.retryAfter = retryAfter;
  }
}

const UNAVAILABLE = 'Groq is unavailable, try again';

/** Maps an upstream HTTP error to the status/message we return, and logs Groq's own text. */
export async function groqError(r) {
  const s = r.status;
  let msg = `Groq API error ${s}`, j, raw = '';
  try { raw = await r.text(); } catch {}
  try { j = JSON.parse(raw); msg = j?.error?.message || j?.message || msg; } catch {}
  const detail = j?.error ? [j.error.type || j.error.code, j.error.message].filter(Boolean).join(': ') : raw;
  console.warn(`groq upstream ${s}: ${redact(detail || '(empty body)').replace(/\s+/g, ' ').slice(0, 300)}`);
  if (s >= 500) return new GroqError(502, UNAVAILABLE, s);
  if (s === 401 || s === 403) return new GroqError(502, `${msg} — check that GROQ_API_KEY is a valid Groq API key`, s);
  if (s === 429) {
    const ra = Number(r.headers?.get?.('retry-after'));
    return new GroqError(429, `${msg} — rate limit reached, try again shortly`, s, ra > 0 ? Math.ceil(ra) : undefined);
  }
  return new GroqError(502, msg, s);
}

export function buildChatBody({ question, context, history, thinking }, cfg = getConfig()) {
  return {
    model: cfg.chatModel,
    messages: [
      { role: 'system', content: buildSystemInstruction(context) },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: question }
    ],
    stream: true,
    reasoning_effort: thinking,   // GPT-OSS: low | medium | high
    include_reasoning: true,      // reasoning text arrives in delta.reasoning
    max_completion_tokens: cfg.maxTokens
  };
}

/** Starts the upstream completion. Throws GroqError before any streaming starts. */
export async function openChat(payload, { cfg = getConfig(), signal } = {}) {
  let r;
  try {
    r = await fetch(`${cfg.groqBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.groqKey}` },
      body: JSON.stringify(buildChatBody(payload, cfg)),
      signal
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new GroqError(502, UNAVAILABLE);
  }
  if (!r.ok) throw await groqError(r);
  return r;
}

/** Converts Groq/OpenAI usage to the field names the page shows. */
export function mapUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {
    total_input_tokens: u.prompt_tokens,
    total_output_tokens: u.completion_tokens,
    total_tokens: u.total_tokens
  };
  const rt = u.completion_tokens_details?.reasoning_tokens;
  if (rt != null) out.total_thought_tokens = rt;
  return out;
}

/**
 * Turns parsed stream chunks into client events: {step} {th} {t} {usage} {error}.
 * Stateful so each {step} is emitted once, when reasoning or answer text first appears.
 */
export function createChunkMapper() {
  const seen = new Set();
  let usage = null;
  return {
    map(ev) {
      if (!ev || typeof ev !== 'object') return [];
      if (ev.error) return [{ error: ev.error.message || 'Groq returned an error' }];
      const out = [];
      const d = ev.choices?.[0]?.delta || {};
      if (typeof d.reasoning === 'string' && d.reasoning) {
        if (!seen.has('thought')) { seen.add('thought'); out.push({ step: 'thought' }); }
        out.push({ th: d.reasoning });
      }
      if (typeof d.content === 'string' && d.content) {
        if (!seen.has('model_output')) { seen.add('model_output'); out.push({ step: 'model_output' }); }
        out.push({ t: d.content });
      }
      // Usage may arrive as `usage` or `x_groq.usage` on the final chunk.
      const u = mapUsage(ev.usage || ev.x_groq?.usage);
      if (u) usage = u;
      return out;
    },
    usage: () => usage
  };
}

/** Text of a non-streamed completion (fallback if a proxy returns plain JSON). */
export const textFromCompletion = j => (j?.choices || []).map(c => c?.message?.content || '').join('');

/**
 * Pipes an upstream completion to `emit`. Stops forwarding after the first error.
 * Emits {usage} once at the end, then {done:true}. Returns true if an error was emitted.
 */
export async function pipeChat(upstream, emit) {
  let failed = false;
  const send = ev => { if (failed) return; if (ev.error) failed = true; emit(ev); };
  const mapper = createChunkMapper();
  if ((upstream.headers.get('content-type') || '').includes('application/json')) {
    const j = await upstream.json();
    const r = j?.choices?.[0]?.message?.reasoning;
    if (r) send({ th: r });
    const text = textFromCompletion(j);
    if (text) send({ t: text });
    const u = mapUsage(j?.usage); if (u) send({ usage: u });
  } else {
    const dec = new TextDecoder();
    const p = createSSEParser(ev => { for (const out of mapper.map(ev)) send(out); });
    for await (const chunk of upstream.body) p.push(dec.decode(chunk, { stream: true }));
    p.push(dec.decode()); p.end();
    if (mapper.usage()) send({ usage: mapper.usage() });
  }
  if (!failed) emit({ done: true });
  return failed;
}
