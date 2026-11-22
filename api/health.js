// GET /api/health — reports configuration (never the key).
import { getConfig, MISSING_KEY } from '../lib/config.js';
import { preflight, sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  const cfg = getConfig();
  if (!preflight(req, res, cfg, 'GET')) return;
  const body = {
    ok: !!cfg.apiKey,
    chatModel: cfg.chatModel,
    embedModel: cfg.embedModel,
    dim: cfg.embedDim,
    apiVersion: cfg.apiVersion,
    thinking: cfg.thinking
  };
  if (!cfg.apiKey) body.error = MISSING_KEY;
  sendJson(res, 200, body);
}
