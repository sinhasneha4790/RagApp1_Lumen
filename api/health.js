// GET /api/health — reports configuration (never the keys).
// Answers: Groq. Embeddings: Gemini. ok is true only when both keys are set.
import { getConfig, MISSING_GROQ_KEY, MISSING_KEY, THINKING_LEVELS } from '../lib/config.js';
import { preflight, sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  const cfg = getConfig();
  if (!preflight(req, res, cfg, 'GET')) return;
  const missing = [!cfg.groqKey && MISSING_GROQ_KEY, !cfg.apiKey && MISSING_KEY].filter(Boolean);
  const body = {
    ok: !missing.length,
    chatProvider: 'Groq',
    chatModel: cfg.chatModel,
    embedProvider: 'Gemini',
    embedModel: cfg.embedModel,
    dim: cfg.embedDim,
    thinking: cfg.thinking,
    thinkingLevels: THINKING_LEVELS,
    chatReady: !!cfg.groqKey,
    embedReady: !!cfg.apiKey
  };
  if (missing.length) body.error = missing.join('; ');
  sendJson(res, 200, body);
}
