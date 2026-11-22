// Reads and validates environment variables. Read at call time so tests (and the
// local dev server) can change process.env without re-importing modules.

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];

export const LIMITS = {
  embedMaxTexts: 100,          // per /api/embed request
  embedMaxChars: 20_000,       // each text is trimmed to this
  bodyMaxBytes: 4 * 1024 * 1024, // stay under Vercel's 4.5 MB request limit
  geminiBatch: 100,            // per :batchEmbedContents call
  questionMaxChars: 4_000,
  contextMaxItems: 12,
  contextMaxChars: 20_000,
  historyMaxItems: 8,
  historyMaxChars: 20_000,
  rateChatPerMin: 60,
  rateEmbedPerMin: 120
};

export function getConfig(env = process.env) {
  // GOOGLE_API_KEY takes precedence when both are set, matching the Google SDKs.
  const apiKey = env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '';
  const thinking = (env.GEMINI_THINKING_LEVEL || 'low').toLowerCase();
  let dim = Number(env.GEMINI_EMBED_DIM || 768);
  if (!Number.isInteger(dim) || dim < 128 || dim > 3072) dim = 768;
  return {
    apiKey,
    chatModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    apiVersion: env.GEMINI_API_VERSION || 'v1beta',
    // An explicitly empty GEMINI_API_REVISION omits the header.
    apiRevision: env.GEMINI_API_REVISION ?? '2026-05-20',
    thinking: THINKING_LEVELS.includes(thinking) ? thinking : 'low',
    embedModel: env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
    embedDim: dim,
    baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    allowOrigin: env.ALLOW_ORIGIN || '',
    port: Number(env.PORT || 3000)
  };
}

export const MISSING_KEY = 'GEMINI_API_KEY is not set on the server';
