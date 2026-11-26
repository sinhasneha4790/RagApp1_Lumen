// Reads and validates environment variables. Read at call time so tests (and the
// local dev server) can change process.env without re-importing modules.
//
// Answers come from Groq (Chat Completions). Embeddings come from Gemini, because
// Groq offers no embeddings API.

export const THINKING_LEVELS = ['low', 'medium', 'high']; // GPT-OSS reasoning_effort values

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
  const thinking = (env.GROQ_REASONING_EFFORT || 'low').toLowerCase();
  let dim = Number(env.GEMINI_EMBED_DIM || 768);
  if (!Number.isInteger(dim) || dim < 128 || dim > 3072) dim = 768;
  let maxTokens = Number(env.GROQ_MAX_TOKENS || 4096);
  if (!Number.isInteger(maxTokens) || maxTokens < 256) maxTokens = 4096;
  return {
    // Chat: Groq
    groqKey: env.GROQ_API_KEY || '',
    chatModel: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    groqBaseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    thinking: THINKING_LEVELS.includes(thinking) ? thinking : 'low',
    maxTokens,
    // Embeddings: Gemini. GOOGLE_API_KEY takes precedence, matching the Google SDKs.
    apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '',
    embedModel: env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
    embedDim: dim,
    baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    allowOrigin: env.ALLOW_ORIGIN || '',
    port: Number(env.PORT || 3000)
  };
}

export const MISSING_KEY = 'GEMINI_API_KEY is not set on the server';
export const MISSING_GROQ_KEY = 'GROQ_API_KEY is not set on the server';
