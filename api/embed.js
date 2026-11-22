// POST /api/embed — { texts: string[], kind: "document" | "query" } → { vectors, dim, model }
import { getConfig, LIMITS, MISSING_KEY } from '../lib/config.js';
import { HttpError, preflight, rateLimited, readJson, sendError, sendJson } from '../lib/http.js';
import { embed } from '../lib/gemini.js';

export default async function handler(req, res) {
  const cfg = getConfig();
  if (!preflight(req, res, cfg, 'POST')) return;
  if (rateLimited(req, 'embed', LIMITS.rateEmbedPerMin)) return sendError(res, 429, 'Too many requests, try again in a minute');
  if (!cfg.apiKey) return sendError(res, 500, MISSING_KEY);
  try {
    const body = await readJson(req, LIMITS.bodyMaxBytes);
    const { texts } = body;
    const kind = body.kind ?? 'document';
    if (!Array.isArray(texts) || !texts.length || texts.length > LIMITS.embedMaxTexts)
      throw new HttpError(400, `texts must be an array of 1–${LIMITS.embedMaxTexts} strings`);
    if (kind !== 'document' && kind !== 'query') throw new HttpError(400, 'kind must be "document" or "query"');
    const clean = texts.map(t => String(t ?? '').slice(0, LIMITS.embedMaxChars));
    if (clean.some(t => !t.trim())) throw new HttpError(400, 'texts must not contain empty strings');
    const meta = {};
    try {
      const vectors = await embed(clean, kind, { cfg, meta });
      sendJson(res, 200, { vectors, dim: cfg.embedDim, model: cfg.embedModel });
    } finally { res.upstreamStatus = meta.upstreamStatus; } // read by the 'finish' logger
  } catch (e) {
    sendError(res, e.status || 500, e.status ? e.message : 'Server error');
    if (!e.status) console.error('embed failed:', e.name);
  }
}
