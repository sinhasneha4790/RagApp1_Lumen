// Small HTTP helpers shared by the Vercel Functions and the local dev server.
// They only use res.statusCode / setHeader / end, so they work with both.

import { LIMITS } from './config.js';

/** Removes anything that looks like an API key before a message is logged. */
export function redact(text, keys = [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY, process.env.GROQ_API_KEY]) {
  let t = String(text);
  for (const k of keys) if (k && k.length >= 8) t = t.split(k).join('[redacted]');
  return t.replace(/AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{20,}/g, '[redacted]');
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Returns the parsed JSON body. Uses req.body when the platform (Vercel) already
 * parsed it; otherwise reads the stream. Rejects non-JSON with 400 and bodies
 * over `limit` bytes with 413.
 */
export async function readJson(req, limit = LIMITS.bodyMaxBytes) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.includes('application/json')) throw new HttpError(400, 'Request body must be JSON (Content-Type: application/json)');
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, 'Request too large');

  let pre;
  try { pre = req.body; } catch { throw new HttpError(400, 'Invalid JSON'); } // Vercel's getter throws on bad JSON
  if (pre !== undefined && pre !== null) {
    if (Buffer.isBuffer(pre) || typeof pre === 'string') return parse(String(pre), limit);
    if (Buffer.byteLength(JSON.stringify(pre)) > limit) throw new HttpError(413, 'Request too large');
    return pre;
  }

  let size = 0; const parts = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    parts.push(c);
  }
  return parse(Buffer.concat(parts).toString('utf8'), limit);
}

function parse(text, limit) {
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Request too large');
  let v;
  try { v = JSON.parse(text || 'null'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Request body must be a JSON object');
  return v;
}

export function applyCors(res, allowOrigin) {
  if (!allowOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

export function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export const sendError = (res, status, message) => sendJson(res, status, { error: message });

/** Logs method, path, status, duration and upstream status only — never bodies or keys. */
export function logRequest(req, res) {
  const t0 = Date.now();
  res.on('finish', () => {
    const path = String(req.url || '').split('?')[0];
    const up = res.upstreamStatus ? ` upstream=${res.upstreamStatus}` : '';
    console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms${up}`);
  });
}

/* Best-effort in-memory rate limit (per instance; not durable on serverless). */
const buckets = new Map();
export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || '') || req.socket?.remoteAddress || 'unknown';
}
/** Returns 0 when allowed, otherwise the seconds until the caller may retry. */
export function rateLimited(req, name, perMinute, now = Date.now()) {
  const key = name + '|' + clientIp(req);
  let b = buckets.get(key);
  if (!b || now - b.start >= 60_000) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.start >= 60_000) buckets.delete(k);
  return b.n > perMinute ? Math.max(1, Math.ceil((b.start + 60_000 - now) / 1000)) : 0;
}

/** Sends a 429 with Retry-After (seconds) when known. */
export function sendTooMany(res, message, retryAfter) {
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  sendError(res, 429, message);
}
export function resetRateLimits() { buckets.clear(); }

/**
 * Common preamble: logging, CORS, OPTIONS, method check.
 * Returns false when the request has already been answered.
 */
export function preflight(req, res, cfg, method) {
  logRequest(req, res);
  applyCors(res, cfg.allowOrigin);
  if (req.method === 'OPTIONS') {
    res.statusCode = cfg.allowOrigin ? 204 : 405; res.end(); return false;
  }
  if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
    res.setHeader('Allow', method);
    sendError(res, 405, `Use ${method}`); return false;
  }
  return true;
}
