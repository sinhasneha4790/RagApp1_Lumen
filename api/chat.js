// POST /api/chat — streams Server-Sent Events: {step} {th} {t} {usage} {error} {done}
import { getConfig, LIMITS, MISSING_KEY, THINKING_LEVELS } from '../lib/config.js';
import { HttpError, preflight, rateLimited, readJson, sendError } from '../lib/http.js';
import { openInteraction, pipeInteraction } from '../lib/gemini.js';

export function validateChat(body, cfg) {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new HttpError(400, 'Missing question');
  if (question.length > LIMITS.questionMaxChars) throw new HttpError(400, `question must be at most ${LIMITS.questionMaxChars} characters`);

  const rawCtx = body.context ?? [];
  if (!Array.isArray(rawCtx)) throw new HttpError(400, 'context must be an array');
  if (rawCtx.length > LIMITS.contextMaxItems) throw new HttpError(400, `context must have at most ${LIMITS.contextMaxItems} items`);
  const context = rawCtx.map((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string') throw new HttpError(400, 'each context item needs a text string');
    if (c.text.length > LIMITS.contextMaxChars) throw new HttpError(400, `context text must be at most ${LIMITS.contextMaxChars} characters`);
    const page = Number.isInteger(c.page) && c.page > 0 ? c.page : null;
    return { n: Number.isInteger(c.n) ? c.n : i + 1, doc: String(c.doc ?? 'document').slice(0, 300), page, text: c.text };
  });

  const rawHist = Array.isArray(body.history) ? body.history.slice(-LIMITS.historyMaxItems) : [];
  const history = rawHist
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, LIMITS.historyMaxChars) }));

  const thinking = THINKING_LEVELS.includes(body.thinking) ? body.thinking : cfg.thinking;
  return { question, context, history, thinking };
}

export default async function handler(req, res) {
  const cfg = getConfig();
  if (!preflight(req, res, cfg, 'POST')) return;
  if (rateLimited(req, 'chat', LIMITS.rateChatPerMin)) return sendError(res, 429, 'Too many requests, try again in a minute');
  if (!cfg.apiKey) return sendError(res, 500, MISSING_KEY);

  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  let upstream;
  try {
    const payload = validateChat(await readJson(req, LIMITS.bodyMaxBytes), cfg);
    upstream = await openInteraction(payload, { cfg, signal: ctrl.signal });
    res.upstreamStatus = upstream.status;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    res.upstreamStatus = e.upstreamStatus;
    if (!e.status) console.error('chat failed before stream:', e.name);
    return sendError(res, e.status || 500, e.status ? e.message : 'Server error');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  try {
    await pipeInteraction(upstream, emit);
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error('chat stream failed:', e.name); emit({ error: 'The answer stream was interrupted, try again' }); }
  }
  if (!res.writableEnded) res.end();
}
