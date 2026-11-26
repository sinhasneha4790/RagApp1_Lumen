# Lumen — Technical Specification

**Product:** Lumen, a "chat with your documents" app built on retrieval-augmented generation (RAG)
**LLM providers:** Groq for answers (Chat Completions API), Google Gemini for embeddings (Gemini Embedding)
**Hosting:** Vercel (static front end + Node.js Vercel Functions)
**Source control:** https://github.com/sinhasneha4790/RagApp1_Lumen (branch `main`)
**Spec version:** 1.1, 26 Nov 2026. Changes from 1.0 are listed in **section 17**.

---

## 0. Instructions for Claude Code (read first)

Lumen v1 is built and deployed. This spec describes the system as it runs today and is the reference for future changes.

| File | What it is | How to use it |
|---|---|---|
| `public/index.html` | The approved front-end design: one HTML file with inline CSS and an ES-module script. | **Source of truth for look and behaviour.** Keep the markup, CSS, layout, colours, copy and interactions as they are, apart from the changes recorded in section 17. |
| `public/lib/*.js` | The chunker and retrieval code, shared by the page and the tests. | The only copy of that logic. Don't duplicate it. |

**Working rules**

1. Work in the repository above, on `main`, which is the default branch and Vercel's production branch. Read the existing code before changing anything.
2. Commit each logical change with a clear message. Run `npm test` before every push; all tests must pass.
3. **Never commit secrets.** `GROQ_API_KEY` and `GEMINI_API_KEY` live only in `.env.local` (git-ignored) and in Vercel environment variables.
4. Use plain JavaScript (ES modules) and Node 22 or newer. Add no front-end framework and no build step. The server side has **no runtime npm dependencies**: use built-in `fetch`.
5. When this spec conflicts with `index.html`, the HTML wins for visual matters and this spec wins for API and security matters. Record any conflict you resolve in the commit message and in section 17.
6. If Groq or Gemini returns errors suggesting that a model name, endpoint or parameter differs from this spec, make the value configurable (most already are, through environment variables), report what you saw, and ask the owner before changing defaults.
7. Ask the owner before deploying anything other than a fix they requested. Every push to `main` deploys to production.

---

## 1. Product overview

Lumen lets a user upload documents and ask questions about them. Answers come **only** from the uploaded content and cite numbered sources.

### 1.1 Core user flow

1. The user opens the app. A sample document ("Sample – returns policy.txt") is preloaded so the app can be tried at once.
2. The user drops or browses for files: PDF, DOCX, TXT, MD, CSV, TSV, JSON, HTML, XML, YAML, LOG, RTF or source code. **The maximum is 10 MB per file.**
3. For each file the browser:
   1. **reads** the text (pdf.js for PDF, mammoth for DOCX, the File API for text formats),
   2. **chunks** it into overlapping passages,
   3. **embeds** the chunks by calling `/api/embed`, which calls Gemini `gemini-embedding-001` with `RETRIEVAL_DOCUMENT`,
   4. **indexes** the chunk vectors in memory, plus a TF-IDF keyword index.
4. The user asks a question. The app:
   1. embeds the question (`/api/embed`, `RETRIEVAL_QUERY`),
   2. ranks chunks by a hybrid score (80% cosine similarity + 20% keyword TF-IDF) and takes the top-k (default 5),
   3. sends the question, the top-k passages and recent chat history to `/api/chat`, which calls **Groq** (`openai/gpt-oss-120b`),
   4. streams the model's reasoning and answer back, rendering `[n]` citations as clickable chips linked to source cards.
5. Every answer shows a **trace** of the four pipeline steps (embed, retrieve, think, answer), with model names, timings and token usage. The trace collapses to a one-line summary when the answer is finished, or shows a failed state if a step fails.

### 1.2 In scope (v1)

- File upload, parsing, chunking, embedding and retrieval as described above.
- Streaming chat with Groq, citations, source cards, a "Read passage" modal and a "View chunks" modal.
- A **Models** panel: connection status, the chat and embedding models, and a thinking-level selector (Low, Medium or High), remembered in `localStorage`.
- Retrieval settings: chunk size, overlap, top-k and "Re-chunk all files".
- Responsive layout (desktop, tablet and phone) as in `index.html`.
- Deployment to Vercel from GitHub.

### 1.3 Out of scope (v1). Do not build these unless asked.

- User accounts and logins.
- Persisting documents or vectors across page reloads. The index lives in browser memory. **No storage (Vercel Blob, databases) is needed.**
- A server-side vector database.
- OCR for scanned PDFs. Show the existing error: "No readable text (scanned PDFs need OCR)".
- Uploading original files to the server.

---

## 2. Architecture

```
┌──────────────────────────── Browser (public/index.html) ─────────────────────────────┐
│ Upload (≤10 MB) → Read (pdf.js / mammoth / File API) → Chunk → [batches of ≤50 texts] │
│ In-memory index: chunks[{text, page, tf, vec(TF-IDF), emb(Float32Array 768-d)}]       │
│ Ask → embed query → hybrid rank → top-k → POST /api/chat → render SSE stream          │
└───────────────┬────────────────────────────┬─────────────────────────┬───────────────┘
                │ GET /api/health            │ POST /api/embed         │ POST /api/chat (SSE)
┌───────────────▼────────────────────────────▼─────────────────────────▼───────────────┐
│ Vercel Functions (Node.js runtime, api/*.js) — hold GROQ_API_KEY and GEMINI_API_KEY   │
│ lib/gemini.js: embed()      lib/groq.js: openChat(), pipeChat()      lib/sse.js       │
└───────────────┬──────────────────────────────────────────────────────┬───────────────┘
                │ :batchEmbedContents                                  │ /openai/v1/chat/completions (stream)
     ┌──────────▼────────────────────────┐              ┌──────────────▼──────────────┐
     │ generativelanguage.googleapis.com │              │ api.groq.com                │
     └───────────────────────────────────┘              └─────────────────────────────┘
```

### 2.1 Why the work is split this way

- **The API keys must stay on the server.** Neither provider's key may reach the browser. The Vercel Functions are the backend proxy.
- **Two providers.** Groq has no embeddings API, so embeddings stay on Gemini, whose embedding calls work on the free tier. Answers moved to Groq because Gemini's chat models kept returning 503 "high demand" to the free-tier key (section 17).
- **Vercel's 4.5 MB body limit.** Vercel Functions reject request bodies over 4.5 MB (`413 FUNCTION_PAYLOAD_TOO_LARGE`). Streamed responses are exempt. A 10 MB file therefore must **never** be sent to a function as a whole. Files are parsed and chunked in the browser, and only chunk **text** goes to `/api/embed`, in batches of at most 50 chunks (about 50–150 KB per request).
- **Function duration.** `maxDuration` is 60 s for `api/chat` and `api/embed` and 10 s for `api/health`.

---

## 3. Repository structure

```
/
├─ public/
│  ├─ index.html            ← the design; script is type="module"
│  └─ lib/
│     ├─ chunker.js         ← chunkText()
│     └─ retrieval.js       ← tokens, TF-IDF index, hybrid rank()
├─ api/
│  ├─ health.js             ← GET  /api/health
│  ├─ embed.js              ← POST /api/embed   (Gemini)
│  └─ chat.js               ← POST /api/chat    (Groq, Server-Sent Events)
├─ lib/
│  ├─ config.js             ← reads env vars, exports constants and limits
│  ├─ gemini.js             ← embed(), embedRequests(), normalize(), geminiError()
│  ├─ groq.js               ← buildChatBody(), openChat(), pipeChat(), groqError()
│  ├─ sse.js                ← createSSEParser()
│  ├─ prompt.js             ← buildSystemInstruction(context)
│  └─ http.js               ← readJson(), sendJson(), CORS, logging, rate limit, redact()
├─ scripts/
│  └─ dev-server.js         ← local dev server that mounts api/* and serves public/
├─ test/
│  ├─ mock-gemini.js        ← local mock of Gemini embeddings and Groq chat (section 12)
│  ├─ chunker.test.js
│  ├─ retrieval.test.js
│  ├─ sse.test.js
│  └─ api.test.js
├─ .env.example
├─ .gitignore               ← node_modules, .env, .env.local, .vercel
├─ package.json
├─ vercel.json
├─ README.md
└─ TECHNICAL_SPEC.md        ← this file
```

`package.json` has `"type": "module"`, `"engines": { "node": ">=22" }`, and these scripts:

```json
{
  "scripts": {
    "dev": "node scripts/dev-server.js",
    "start": "node scripts/dev-server.js",
    "dev:mock": "node test/mock-gemini.js & GEMINI_BASE_URL=http://localhost:4999 GEMINI_API_KEY=test GOOGLE_API_KEY= GROQ_BASE_URL=http://localhost:4999/openai/v1 GROQ_API_KEY=test node scripts/dev-server.js",
    "test": "node --test \"test/*.test.js\""
  }
}
```

The dev server reads `.env.local`, then `.env`. Real environment variables take precedence over both.

---

## 4. Configuration (environment variables)

All variables are read in `lib/config.js` at call time.

| Variable | Default | Notes |
|---|---|---|
| `GROQ_API_KEY` | — | **Required for answers.** |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Chat model. `openai/gpt-oss-20b` is the faster alternative. The thinking levels assume a GPT-OSS model. |
| `GROQ_REASONING_EFFORT` | `low` | Server default thinking level: `low`, `medium` or `high` |
| `GROQ_MAX_TOKENS` | `4096` | Sent as `max_completion_tokens`; covers reasoning and answer. Minimum 256. |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Overridden in tests to point at the mock |
| `GEMINI_API_KEY` | — | **Required for embeddings.** `GOOGLE_API_KEY` is also accepted and takes precedence if both are set. Without it, search falls back to keywords only. |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Or `gemini-embedding-2` (see 7.2) |
| `GEMINI_EMBED_DIM` | `768` | 128–3072. Google recommends 768, 1536 or 3072. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Overridden in tests to point at the mock |
| `ALLOW_ORIGIN` | *(empty)* | Set only if the UI is served from a different origin |
| `PORT` | `3000` | Local dev server only |

`.env.example` lists these with empty `GROQ_API_KEY=` and `GEMINI_API_KEY=` lines.

---

## 5. Front end (public/index.html)

### 5.1 Layout and visual design (do not change)

- **Theme:** plum-black ground (`#1a0f1f`) in both light and dark modes, rose accent `#ff8fa3`, dusk support `#8f7aa8`, white ink.
- **Fonts:** Inter Tight (300, 500, 600) for headings and Inter for UI text, from Google Fonts.
- **Layout:** a 320 px library rail on the left (logo, drop zone, library, Models panel, retrieval settings) and the chat on the right (header pills, thread, composer).
- **Breakpoints:** at ≤860 px the chat comes first, the rail moves below it, and the composer is sticky. At ≤600 px avatars are hidden and wide pills collapse.
- **Welcome view:** headline, an animated SVG pipeline scene (pages → chunks → vector constellation → answer bubble), four labelled steps that use the model names from `/api/health`, and example question chips. The text reads "Groq answers only from the passages it finds in your files…".
- **Motion:** one flowing-dash animation, step spinners and a typing indicator. All are disabled under `prefers-reduced-motion`.

### 5.2 Upload rules

| Rule | Value / behaviour |
|---|---|
| Max size | **10 MB per file** (`MAX_FILE_BYTES = 10 * 1024 * 1024`). Larger files get a library card in an error state reading "<size> is over the 10 MB limit". Nothing is read or sent. |
| Empty file | Error card: "File is empty" |
| Accepted | `.pdf .docx .txt .md .markdown .csv .tsv .json .html .htm .xml .log .yaml .yml .rtf` and common code extensions, plus `text/*` |
| Multiple files | Allowed. Each file is processed independently. |
| Drag and drop | The whole window accepts drops. The drop zone highlights while a file is dragged over it. |
| Binary or unknown | If the decoded text has NUL bytes in its first 2,000 characters, show "This format isn't supported". |

### 5.3 File parsing (browser)

- **PDF:** pdf.js `3.11.174` from cdnjs, with `GlobalWorkerOptions.workerSrc` set. Extract text page by page and keep page numbers for citations.
- **DOCX:** mammoth `1.6.0` from cdnjs, using `extractRawText`.
- **HTML:** parse with `DOMParser`, remove `script` and `style`, use `innerText`.
- **JSON:** pretty-print it so it chunks cleanly.
- **RTF:** strip control words.

### 5.4 Chunking (`public/lib/chunker.js`)

- Defaults: `size = 900` characters, `overlap = 150` characters. Slider ranges: 300–3000 and 0–600. Overlap is clamped to `size − 50`.
- Collapse runs of spaces and more than two newlines.
- Prefer to break at the last paragraph break or sentence end (`. ` `? ` `! `) found in the final 40% of the window. Then step back by `overlap` and snap forward to a word boundary.
- Drop chunks of 20 characters or fewer.
- Each chunk records `{doc, docId, idx (1-based), page|null, text}`.
- "Re-chunk all files" re-runs chunking **and embedding** for every file with the current settings. A file removed or re-chunked mid-embedding stops sending batches.

### 5.5 Embedding and indexing (browser side)

- After chunking, call `POST /api/embed` with `{texts, kind: "document"}` in batches of **50**, with **at most 3 requests in flight page-wide**. Question embeddings jump the queue. The file card shows "Embedding with Gemini n/total…".
- Store each returned vector as a `Float32Array` in `chunk.emb`. Vectors are already L2-normalised by the server.
- Always build the TF-IDF index too (`tokens()`, stop words, light stemming, `idf = ln((N+1)/(df+0.5))`).
- **On a 429**, document batches pause page-wide until `Retry-After` (default 5 s, at most 60 s), then retry, up to 10 times per batch. Question embeddings don't wait; they fall back to keywords.
- If embedding still fails, keep the file with keyword search only and show "· keyword search only" in red on its card, with the error as a tooltip. Once one batch fails, the remaining batches for that file are not sent.
- Show a warning in the library when the total exceeds **20,000 chunks**.

### 5.6 Retrieval (`public/lib/retrieval.js`)

```
qe    = embed(question, kind: "query")          // skipped if no chunk has .emb
score = qe && chunk.emb ? 0.8 * dot(qe, chunk.emb) + 0.2 * tfidfCosine
                        : tfidfCosine
hits  = top-k by score, score > 0
```

- Default `k = 5` (slider 1–12).
- **Follow-up questions:** if fewer than k hits are found and there is a previous question, run a second retrieval on `previousQuestion + " " + question` and merge the new hits.
- Source cards show the match bar relative to the top hit (100% = best).

### 5.7 Chat and trace

- Request: `POST /api/chat` with `{question, context:[{n, doc, page, text}], history: last 8 turns [{role:"user"|"assistant", content}], thinking: "low"|"medium"|"high"}`.
- Read the SSE stream (section 6.3) and render events as they arrive:
  - `th` → append to the reasoning box in the Think step.
  - first `t` → mark Think done (time = request start → first token), start Answer, show the answer bubble.
  - `t` → append to the answer and re-render the markdown subset (paragraphs, `-` / `1.` lists, `**bold**`, `` `code` ``, and `[n]` citation chips).
  - `usage` → show reasoning tokens, output tokens and total tokens.
  - `error` → mark the running step red and show the message under any partial answer.
- **The trace has four rows:**
  1. Embed your question: `<embedModel> · RETRIEVAL_QUERY · <dim>-dimensional vector`, with time
  2. Find matching passages: `<n> of <total> chunks · 80% cosine similarity + 20% keyword · best <score>`, with time
  3. Think: `Thinking level: <level> · <n> reasoning tokens`, plus the streamed reasoning text or "no reasoning returned"
  4. Write the answer: `Groq · <chatModel> · Chat Completions, streamed · <n> output tokens`, with time
- **When the answer is done,** collapse the trace to: `Embedded → N passages → thought X s → answered in Y s · Z tokens`.
- **When a step fails,** the summary reads `Failed at <step> after <time>` in the error colour with a red dot, and the failed step is marked red. It must not keep showing "Working…".
- **Citations:** clicking `[n]` scrolls to source card n and highlights it for 1.5 s. "Read passage" opens the full chunk in a modal.
- Only successful turns are added to `history`. "New chat" clears the history and returns to the welcome view.

### 5.8 Models panel and header

- On load, call `GET /api/health`.
- **Header pill:** `Groq · <chatModel>` with a green dot when `ok` is true. Otherwise "Groq not connected", or "Gemini embeddings not connected" when only the Gemini key is missing. The tooltip shows the error.
- **Models panel** (titled "Models"), one row each:
  - Chat: `Groq · <chatModel>`
  - Embeddings: `Gemini · <embedModel> · <dim>-d`
  - API: `Groq · Chat Completions`
  - Model IDs never wrap mid-name.
- **Thinking level** segmented control with three options, **Low, Medium and High**, each with a one-line note. A saved value that is no longer offered (such as `minimal`) falls back to Low.
- If the server can't be reached, show "Server not reachable." In local dev (`location.hostname === 'localhost'`) add "Start it with npm start.".

### 5.9 Front-end rules

1. The "npm start" hints, in the health message and in the chat error "Can't reach the Lumen server…", appear only on `localhost`. Production shows neutral text.
2. `API` (`window.LUMEN_API`) defaults to same-origin.
3. Escape all user, document and model text with `esc()` before inserting HTML.
4. Do not add analytics, trackers or third-party scripts.

---

## 6. HTTP API

All endpoints are same-origin, JSON in and JSON out, except the `/api/chat` stream. Errors use the shape `{ "error": "<human-readable message>" }` with a suitable status code. Every 429 carries a `Retry-After` header (seconds) when the wait is known.

### 6.1 `GET /api/health`

```json
200 { "ok": true, "chatProvider": "Groq", "chatModel": "openai/gpt-oss-120b",
      "embedProvider": "Gemini", "embedModel": "gemini-embedding-001", "dim": 768,
      "thinking": "low", "thinkingLevels": ["low", "medium", "high"],
      "chatReady": true, "embedReady": true }
```

- `ok` is true only when **both** keys are set. `chatReady` and `embedReady` report each key separately.
- If a key is missing, `error` names it: `"GROQ_API_KEY is not set on the server"` and/or `"GEMINI_API_KEY is not set on the server"`, joined with `; `.
- The health check only checks that the keys are set. It does not call Groq or Gemini. Never echo a key or any part of it.

### 6.2 `POST /api/embed` (Gemini)

Request: `{ "texts": string[], "kind": "document" | "query" }`

- Validate: `texts` is a non-empty array of at most **100** strings, none empty. Each is coerced to a string and trimmed to 20,000 characters. `kind` defaults to `"document"`; any other value is a 400. The total body stays under 4 MB; anything larger is a 413.
- Needs `GEMINI_API_KEY`; without it, return 500 with the message above.
- Response: `200 { "vectors": number[][], "dim": 768, "model": "gemini-embedding-001" }`, one vector per text, in order and L2-normalised.
- Errors: 400 for validation, 413 for size, 429 when rate-limited by Lumen or upstream, 502 for other upstream failures.
- Per-IP limit: 120 requests per minute.

### 6.3 `POST /api/chat` (Groq, Server-Sent Events)

Request:

```json
{ "question": "How long do I have to return an item?",
  "context": [ { "n": 1, "doc": "policy.pdf", "page": 2, "text": "…" } ],
  "history": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ],
  "thinking": "low" }
```

Validation: `question` is required, at most 4,000 characters. `context` has at most 12 items, with `text` of at most 20,000 characters each. `history` is limited to the last 8 items. `thinking` must be `low`, `medium` or `high`; otherwise the server default is used. Needs `GROQ_API_KEY` only; without it, return 500. Per-IP limit: 60 requests per minute.

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

Each event is one line, `data: <json>`, followed by a blank line. Event payloads:

| Payload | Meaning |
|---|---|
| `{"step":"thought"}` / `{"step":"model_output"}` | Reasoning or answer text started (informational) |
| `{"th":"…"}` | A piece of the model's reasoning |
| `{"t":"…"}` | A piece of the answer text |
| `{"usage":{"total_input_tokens":…, "total_output_tokens":…, "total_thought_tokens":…, "total_tokens":…}}` | Token usage, sent once at the end |
| `{"error":"…"}` | An upstream or stream error. The client stops. |
| `{"done":true}` | Stream finished |

Errors before the stream starts are returned as normal JSON errors with a status code. Errors after the stream starts are sent as an `{"error"}` event, and then the stream ends without `done`.

---

## 7. Upstream integrations

### 7.1 Authentication

- **Groq:** `Authorization: Bearer <GROQ_API_KEY>` on every chat request.
- **Gemini:** `x-goog-api-key: <GEMINI_API_KEY>` on every embedding request.

### 7.2 Embeddings (Gemini, `lib/gemini.js`)

`POST {GEMINI_BASE_URL}/v1beta/models/{EMBED_MODEL}:batchEmbedContents`

```json
{ "requests": [
  { "model": "models/gemini-embedding-001",
    "content": { "parts": [ { "text": "<chunk text>" } ] },
    "taskType": "RETRIEVAL_DOCUMENT",
    "outputDimensionality": 768 } ] }
```

- Use `taskType: RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions.
- The response is `{ "embeddings": [ { "values": [...] } ] }`. **L2-normalise each vector**, because gemini-embedding-001 needs manual normalisation at any size other than 3072.
- Send at most 100 requests per batch call. Check that the number of vectors returned equals the number of inputs.
- **Retry once, after 800 ms, on 429 or 5xx.** On a 429, pass the wait on as `Retry-After`, taken from Gemini's `Retry-After` header or its `google.rpc.RetryInfo.retryDelay`.
- **If `EMBED_MODEL` starts with `gemini-embedding-2`,** omit `taskType` and prefix the text instead: queries become `task: search result | query: <text>` and documents become `title: none | text: <text>`. The two models' vectors are **not comparable**, so the user must reload and re-upload after switching.

### 7.3 Chat (Groq Chat Completions, streamed, `lib/groq.js`)

`POST {GROQ_BASE_URL}/chat/completions`

```json
{
  "model": "openai/gpt-oss-120b",
  "messages": [
    { "role": "system",    "content": "<built by prompt.js, see section 8>" },
    { "role": "user",      "content": "<earlier question>" },
    { "role": "assistant", "content": "<earlier answer>" },
    { "role": "user",      "content": "<current question>" }
  ],
  "stream": true,
  "reasoning_effort": "low",
  "include_reasoning": true,
  "max_completion_tokens": 4096
}
```

- `reasoning_effort` takes `low`, `medium` or `high` for the GPT-OSS models. Groq's docs list other values for other models; for example, Qwen also accepts `none` and `default`, and Muse Spark Open accepts `xhigh`.
- With GPT-OSS, `reasoning_format` is not supported; reasoning is returned in the `reasoning` field, controlled by `include_reasoning`. The two parameters are mutually exclusive.

**Stream handling.** The response is data-only Server-Sent Events, ended by `data: [DONE]`. Parse blocks separated by a blank line (`lib/sse.js`) and map each chunk:

| Upstream chunk | Action |
|---|---|
| `choices[0].delta.reasoning` (non-empty string) | Emit `{step:"thought"}` once, then `{th}` |
| `choices[0].delta.content` (non-empty string) | Emit `{step:"model_output"}` once, then `{t}` |
| `usage` or `x_groq.usage` on a chunk | Remember it; at the end emit `{usage}`, mapped as `prompt_tokens → total_input_tokens`, `completion_tokens → total_output_tokens`, `total_tokens → total_tokens`, `completion_tokens_details.reasoning_tokens → total_thought_tokens` |
| `{ "error": { "message": … } }` | Emit `{error: message}` and stop forwarding |
| `data: [DONE]`, comments, malformed JSON | Ignore |

**Fallback:** if the upstream `Content-Type` is `application/json` (not streamed), emit `choices[0].message.reasoning` as `{th}`, the joined `message.content` as `{t}`, then `{usage}` and `{done:true}`.

**Cancellation:** create an `AbortController` per request and abort the upstream fetch when the client disconnects (`res.on('close')`). Chat requests are not retried.

### 7.4 Error mapping

| Upstream status | Return to client | Message |
|---|---|---|
| 400 (and other 4xx) | 502 | The provider's `error.message` |
| 401 / 403 | 502 | Provider message plus "check that GROQ_API_KEY is a valid Groq API key" (Groq) or "check that your API key is valid and restricted to the Gemini API" (Gemini) |
| 429 | 429 | Provider message plus "rate limit reached, try again shortly", with `Retry-After` when known |
| 5xx / network | 502 | "Groq is unavailable, try again" or "Gemini is unavailable, try again" |

Groq's error body is `{ "error": { "message": "…", "type": "…" } }`. Groq sends `retry-after` (seconds) only on 429.

---

## 8. Prompt (lib/prompt.js)

Use this text exactly. `<passages>` is the context items joined with `\n\n---\n\n`, each formatted as `[n] (doc[, page p])\n<text>`, or `(no matching passages were found)` when there are none. It is sent as the Groq **system** message.

```
You are a document question-answering assistant in a retrieval-augmented (RAG) app. Answer the user's question using ONLY the numbered context passages below, which were retrieved from files the user uploaded.
Rules:
- Cite the passage numbers you used in square brackets right after each claim, like [1] or [2][3].
- If the passages do not contain the answer, say plainly that the uploaded documents don't cover it, and suggest what to ask or upload instead. Do not use outside knowledge to fill gaps.
- Be concise and direct. Use short paragraphs or a bulleted list. Plain text with **bold** allowed; no headings.

CONTEXT PASSAGES:
<passages>
```

Treat document text as data. Never let it change server behaviour.

---

## 9. Vercel Functions implementation notes

- Use the Node.js runtime with the classic handler signature `export default async function handler(req, res)` in `api/*.js`. Share logic through `lib/`.
- Vercel parses JSON bodies into `req.body`. Use it when present; otherwise read the stream with `readJson` (needed for the local dev server). Reject non-JSON content types with 400.
- **Streaming:** set the SSE headers, call `res.flushHeaders()`, then `res.write()` each event and `res.end()` at the end. Don't buffer the whole answer.
- `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "outputDirectory": "public",
  "functions": {
    "api/chat.js":  { "maxDuration": 60 },
    "api/embed.js": { "maxDuration": 60 },
    "api/health.js": { "maxDuration": 10 }
  },
  "headers": [
    { "source": "/api/(.*)", "headers": [ { "key": "Cache-Control", "value": "no-store" } ] },
    { "source": "/(.*)", "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
    ] }
  ]
}
```

- Project preset **Other**, no build command, output directory `public`.
- **Local dev:** `scripts/dev-server.js` uses `node:http` to serve `public/` (with path-traversal protection) and route `/api/health`, `/api/embed` and `/api/chat` to the same handler modules, adding `status()`/`json()` shims.

---

## 10. Security and privacy

- The API keys are read only from environment variables on the server. They are never sent to the client, put in an error message, or logged.
- **Logging.** Each request logs the method, path, status, duration and upstream status. When an upstream call fails, the log also gets the provider's own error message as `groq upstream <status>: …` or `gemini upstream <status>: …`, capped at 300 characters, with anything that looks like a key removed (the configured keys, `AIza…` and `gsk_…` patterns). Request bodies, document text and answers are never logged.
- Use same-origin only by default. Add CORS headers only when `ALLOW_ORIGIN` is set.
- Validate input sizes on every endpoint (section 6). Reject non-JSON with a 400.
- Basic abuse protection: an in-memory per-IP limit of 60 requests per minute on `/api/chat` and 120 per minute on `/api/embed`, returning 429 with `Retry-After`. This is best-effort on serverless and documented in the README as non-durable.
- In the README, recommend restricting the Gemini key to the Gemini API in AI Studio and setting billing alerts with both providers.
- The front end escapes all text before inserting HTML. Keep it that way, and never use `innerHTML` with unescaped document or model text.

---

## 11. Performance targets

| Metric | Target |
|---|---|
| Time to interactive (desktop, broadband) | < 1.5 s |
| Embedding a 10 MB text file (~14,000 chunks at 900 characters, ~280 requests) | Progress shown throughout, no UI freeze, about 2–3 min. The 120-per-minute embed limit and the 429 wait-and-retry set this. |
| Question → first answer token (Low thinking) | < 3 s typical |
| Memory | Warn in the library when the total exceeds 20,000 chunks. Several 10 MB files can exhaust a browser tab; this is a documented limit. |

**Groq rate limits.** Groq's docs disagree on the numbers for `openai/gpt-oss-120b`: the rate-limits page lists 30 requests a minute, 1,000 a day, 8,000 tokens a minute and 200,000 tokens a day as "base limits for the Developer plan", while the models page lists 1,000 requests and 250,000 tokens a minute under "Developer plan". Neither page names a free tier. The account's real limits are on https://console.groq.com/settings/limits. With the lower numbers, several quick questions in a row can hit the per-minute token limit; the answer then shows a rate-limit message.

---

## 12. Testing

### 12.1 Unit and API tests (`npm test`, Node's built-in runner)

- `chunker.test.js`: respects size and overlap, prefers sentence and paragraph breaks, drops tiny chunks, keeps page numbers, collapses whitespace.
- `retrieval.test.js`: the hybrid score ranks a semantically closer chunk above a keyword-only match, falls back to keywords when there are no embeddings, and respects k.
- `sse.test.js`: parses Groq stream chunks, including chunks split across network reads at every offset, `\r\n` line endings, `[DONE]`, comments and malformed JSON; usage from `usage` or `x_groq.usage`; mid-stream errors; the JSON fallback; the chat request body; Groq and Gemini error mapping and log redaction; embedding request formats; normalisation.
- `api.test.js`: health for both providers and missing keys; embed and chat validation (400/413); missing keys (500); the section 7.4 error mapping; the embed retry; chat streaming, headers and request shape; `GROQ_MODEL` and reasoning-effort fallbacks; CORS; rate limiting and `Retry-After`; static file serving.

### 12.2 Mock (`test/mock-gemini.js`)

A small `node:http` server on port 4999 (`MOCK_PORT` to change) that:

- answers `:batchEmbedContents` with deterministic vectors (each word hashed into one dimension), requiring `x-goog-api-key`,
- streams for `/openai/v1/chat/completions` (requires `Authorization: Bearer …`): two `delta.reasoning` chunks, then 4–5 `delta.content` chunks including `[1]`, then a final chunk with `x_groq.usage` (including `completion_tokens_details.reasoning_tokens`) and `data: [DONE]`,
- records requests for tests (`GET /__requests`), can fail the next calls (`POST /__fail {status, message, count}`), and resets (`POST /__reset`),
- logs what it received, with keys shown only as present or missing.

`npm run dev:mock` runs the whole app against the mock with no real keys.

### 12.3 Manual acceptance on production

1. `/api/health` returns `"ok": true` and `"chatModel": "openai/gpt-oss-120b"`.
2. The sample question gets an answer citing `[1]`, and the trace summary reads `Embedded → … answered in … · N tokens`.
3. Upload a 2–5 MB PDF and a DOCX. Both reach "Ready", and an answer about a specific page cites that page.
4. Ask something the documents don't cover. The answer says the documents don't cover it.
5. Switch thinking to High. Reasoning text appears in the Think step, with more reasoning tokens.
6. Upload an 11 MB file. It is rejected with the 10 MB message and nothing is sent to the server.
7. Block `/api/embed` in devtools. Files fall back to "keyword search only" and chat still works.

---

## 13. Build history

| # | Milestone | Commit |
|---|---|---|
| 1 | Scaffold | `chore: scaffold Lumen project` |
| 2 | Gemini client and SSE parsing | `feat: Gemini embeddings and streaming client` |
| 3 | API routes and dev server | `feat: health, embed and chat endpoints` |
| 4 | Mock and API tests | `test: mock Gemini and API tests` |
| 5 | Front-end production tweaks | `feat: front-end production tweaks` |
| 6 | README | `docs: README and deployment guide` |
| 7 | 429 wait-and-retry | `fix: wait and retry on 429 so large files embed fully` |
| 8 | Upstream error logging | `chore: log Gemini's error text for failed upstream calls` |
| 9 | Failed trace state | `fix: show a failed state in the answer trace` |
| 10 | Answers via Groq | `feat: answer with Groq instead of Gemini chat` |

---

## 14. GitHub and Vercel

### 14.1 GitHub

- Repository: https://github.com/sinhasneha4790/RagApp1_Lumen. `main` is the default branch and the only long-lived branch.
- Run `npm test` before pushing. Do not force-push.

### 14.2 Vercel

- Project `ragapp1_lumen`, production URL https://ragapp1lumen.vercel.app, production branch `main`. Every push to `main` deploys to production.
- Settings: Framework Preset **Other**, no build command, Output Directory `public`.
- **Environment variables (Production and Preview):** `GROQ_API_KEY` and `GEMINI_API_KEY`. Optional overrides are listed in section 4. Changing a variable needs a redeploy to take effect.
- **Never** ask the owner to paste an API key into a chat or a commit. They enter it directly in Vercel.
- After a deployment, check that `/api/health` returns `ok: true`, then run section 12.3.

---

## 15. Acceptance criteria (definition of done)

- [x] The UI matches the approved design on desktop (1360 px) and phone (390 px), apart from the changes in section 17.
- [x] Files over 10 MB are rejected in the browser with the specified message. No request body sent to any function exceeds 4.5 MB.
- [x] Chunks are embedded with Gemini (`RETRIEVAL_DOCUMENT`), and questions use `RETRIEVAL_QUERY`. Vectors are 768-d and normalised.
- [x] Answers stream from Groq with reasoning, citations, source cards and the four-step trace showing real timings and token usage.
- [ ] The thinking level selected in the UI is sent and honoured (Low, Medium, High). *Sent and covered by tests; High on production not yet checked.*
- [x] Neither API key appears in client code, network responses, logs or git history.
- [x] `npm test` passes, and `npm run dev:mock` works without real keys.
- [x] The code is on `main` on GitHub, the Vercel project is linked to it, and production returns `ok: true` and answers questions.
- [x] The README documents setup, environment variables, local dev, deployment and known limits (in-memory index, no OCR, non-durable rate limiting, Groq rate limits).

---

## 16. Roadmap (after v1, for reference only)

1. Persist documents and vectors: Vercel Blob for files and Postgres + pgvector (or Qdrant) for vectors, with server-side chunking.
2. Accounts (for example Auth.js) with per-user libraries.
3. OCR for scanned PDFs.
4. Re-ranking the top 20 passages to a top 5 using the chat model.
5. Thinking levels that follow the configured model (for example `xhigh` for models that support it), read from `/api/health` `thinkingLevels`.
6. Exporting answers with their citations.

---

## 17. Changes from spec 1.0

| Area | 1.0 | 1.1 (current) | Why |
|---|---|---|---|
| Chat provider | Gemini Interactions API, `gemini-3.8-flash` | Groq Chat Completions, `openai/gpt-oss-120b` | Gemini chat returned 503 "high demand" for days to the free-tier key, also when called directly (outside Lumen), and also for `gemini-4-hydrogen`. Embeddings kept working. |
| Embeddings | Gemini | Gemini (unchanged) | Groq has no embeddings API |
| Env vars | `GEMINI_MODEL`, `GEMINI_API_VERSION`, `GEMINI_API_REVISION`, `GEMINI_THINKING_LEVEL` | Removed. Added `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_REASONING_EFFORT`, `GROQ_MAX_TOKENS`, `GROQ_BASE_URL` | Provider switch |
| Thinking levels | Minimal, Low, Medium, High | Low, Medium, High | GPT-OSS supports `low`/`medium`/`high` only |
| UI labels | "Gemini" panel, pill and copy | "Models" panel; Groq for answers, Gemini for embeddings | Provider switch |
| `/api/health` | `{ok, chatModel, embedModel, dim, apiVersion, thinking}` | Adds providers, `thinkingLevels`, `chatReady`, `embedReady`; `ok` needs both keys | Two providers |
| Test script | `node --test test/` | `node --test "test/*.test.js"` | Node 22 treats a directory argument as a file; the glob also keeps `mock-gemini.js` from running as a test |
| `dev:mock` | Sets Gemini vars | Also sets `GOOGLE_API_KEY=` and the Groq vars | Stops a real key in `.env` being sent to the mock |
| Code layout | Chunker and retrieval inline | `public/lib/chunker.js` and `retrieval.js`, page script `type="module"` | Single source of truth for page and tests |
| Vectors in browser | Plain arrays | `Float32Array` | Halves memory |
| Embedding concurrency | Not specified | 3 in flight page-wide; queries jump the queue | Spec 11 asked for at most 3 parallel batches |
| Embed rate limit vs large files | Conflict: 120/min vs ~280 requests per 10 MB file | All 429s carry `Retry-After`; the page pauses and retries document batches | Large files fell back to keyword search |
| Logging | Status codes only | Also the provider's error message (300 chars, keys redacted) on upstream failures | Needed to diagnose the Gemini 503s; approved by the owner |
| Trace after an error | Kept showing "Working…" | "Failed at <step> after <time>" | It looked like it was still running |
| "npm start" hints | Chat error only | Health message and chat error, localhost only | Owner's choice |

---

## Appendix A — Reference: Groq stream mapping on the server

```js
const mapper = createChunkMapper();          // lib/groq.js
const parser = createSSEParser(ev => {       // lib/sse.js: splits on blank lines, skips [DONE]
  for (const out of mapper.map(ev)) send(out);
});
for await (const chunk of upstream.body) parser.push(decoder.decode(chunk, { stream: true }));
parser.end();
if (mapper.usage()) send({ usage: mapper.usage() });
emit({ done: true });                         // only if no error was sent

// mapper.map(ev):
//   ev.error                         → [{ error: ev.error.message }]
//   ev.choices[0].delta.reasoning    → [{ step: 'thought' } (first time), { th }]
//   ev.choices[0].delta.content      → [{ step: 'model_output' } (first time), { t }]
//   ev.usage || ev.x_groq?.usage     → remembered, mapped to total_* names
```

## Appendix B — Reference: client reading the stream

```js
const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true }); let i;
  while ((i = buf.indexOf('\n\n')) > -1) {
    const ev = JSON.parse(buf.slice(0, i).replace(/^data:\s?/, '')); buf = buf.slice(i + 2);
    if (ev.error) throw new Error(ev.error);
    if (ev.th) onReasoning(ev.th);
    if (ev.usage) onUsage(ev.usage);
    if (ev.t) onText(ev.t);
  }
}
```

## Appendix C — Sources consulted

- Groq models: https://console.groq.com/docs/models
- Groq reasoning (`reasoning_effort`, `include_reasoning`, `reasoning_format`): https://console.groq.com/docs/reasoning
- Groq Chat Completions and streaming: https://console.groq.com/docs/api-reference, https://console.groq.com/docs/text-chat
- Groq rate limits and `retry-after`: https://console.groq.com/docs/rate-limits
- Groq error format: https://console.groq.com/docs/errors
- Gemini API keys: https://aistudio.google.com/docs/api-key
- Gemini embeddings: https://ai.google.dev/gemini-api/docs/embeddings
- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel 4.5 MB body limit: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- Vercel Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
