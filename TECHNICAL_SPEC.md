# Lumen — Technical Specification

**Product:** Lumen, a "chat with your documents" app built on retrieval-augmented generation (RAG)
**LLM provider:** Google Gemini (Interactions API + Gemini Embedding)
**Hosting:** Vercel (static front end + Node.js Vercel Functions)
**Source control:** the GitHub repository this file sits in
**Spec version:** 1.0, 20 Nov 2026

---

## 0. Instructions for Claude Code (read first)

You are implementing Lumen from this spec. Two files come with it:

| Attachment | What it is | How to use it |
|---|---|---|
| `index.html` | The finished, approved front-end design: a single HTML file with inline CSS and JS. | **This is the source of truth for look and behaviour.** Keep the markup, CSS, layout, colours, copy and interactions as they are. Move it to `public/index.html`. Only change it where this spec says so. |
| `server.js` (if attached) | A working zero-dependency Node reference server. | Use its Gemini request and streaming code as a reference. Port that logic into Vercel Functions (section 7). Do not deploy `server.js` itself to Vercel. |

**Working rules**

1. Work in the current GitHub repository. Before changing anything, run `git status`, `git remote -v` and `git branch --show-current`, and read the existing contents. If the repo already contains unrelated code, put Lumen in the repo root only if it is empty or holds only a README or licence. Otherwise ask the user where it should go.
2. Follow the build order in section 13. Commit after each milestone with a clear message.
3. **Never commit secrets.** `GEMINI_API_KEY` lives only in `.env.local` (git-ignored) and in Vercel environment variables.
4. Use plain JavaScript (ES modules) and Node 22 or newer. Add no front-end framework and no build step. The server side needs **no runtime npm dependencies**: use built-in `fetch`. Dev dependencies for tests are fine.
5. When something in this spec conflicts with the attached `index.html`, the HTML wins for visual matters and this spec wins for API and security matters. Note any conflict you resolve in the pull request or commit message.
6. If the Gemini API returns errors that suggest a model name, API version or header differs from this spec, make the value configurable (it already is, through environment variables), report what you saw, and ask the user before changing defaults.
7. Finish with section 14 (GitHub push and Vercel deployment) and the acceptance checklist in section 15.

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
   3. sends the question, the top-k passages and recent chat history to `/api/chat`,
   4. streams Gemini's thought summary and answer back, rendering `[n]` citations as clickable chips linked to source cards.
5. Every answer shows a **trace** of the four pipeline steps (embed, retrieve, think, answer), with model names, timings and token usage. The trace collapses to a one-line summary when the answer is finished.

### 1.2 In scope (v1)

- File upload, parsing, chunking, embedding and retrieval as described above.
- Streaming chat with Gemini, citations, source cards, a "Read passage" modal and a "View chunks" modal.
- A Gemini panel: connection status, model info and a thinking-level selector (Minimal, Low, Medium or High), remembered in `localStorage`.
- Retrieval settings: chunk size, overlap, top-k and "Re-chunk all files".
- Responsive layout (desktop, tablet and phone) as in `index.html`.
- Deployment to Vercel from GitHub.

### 1.3 Out of scope (v1). Do not build these unless asked.

- User accounts and logins.
- Persisting documents or vectors across page reloads. The index lives in browser memory.
- A server-side vector database.
- OCR for scanned PDFs. Show the existing error: "No readable text (scanned PDFs need OCR)".
- Uploading original files to the server.

---

## 2. Architecture

```
┌──────────────────────────── Browser (public/index.html) ─────────────────────────────┐
│ Upload (≤10 MB) → Read (pdf.js / mammoth / File API) → Chunk → [batches of ≤50 texts] │
│ In-memory index: chunks[{text, page, tf, vec(TF-IDF), emb(768-d)}]                    │
│ Ask → embed query → hybrid rank → top-k → POST /api/chat → render SSE stream          │
└───────────────┬────────────────────────────┬─────────────────────────┬───────────────┘
                │ GET /api/health            │ POST /api/embed         │ POST /api/chat (SSE)
┌───────────────▼────────────────────────────▼─────────────────────────▼───────────────┐
│ Vercel Functions (Node.js runtime, api/*.js)  — holds GEMINI_API_KEY                  │
│ lib/gemini.js: embed(), streamInteraction(), buildSystemInstruction(), parse SSE      │
└───────────────┬────────────────────────────┬─────────────────────────────────────────┘
                │ :batchEmbedContents        │ /v1beta/interactions?alt=sse (stream)
          ┌─────▼────────────────────────────▼─────┐
          │  generativelanguage.googleapis.com     │
          └────────────────────────────────────────┘
```

### 2.1 Why the work is split this way

- **The API key must stay on the server.** Google's API key guidance says not to hardcode keys in web or mobile apps and to use a backend proxy. The Vercel Functions are that proxy.
- **Vercel's 4.5 MB body limit.** Vercel Functions reject request bodies over 4.5 MB (`413 FUNCTION_PAYLOAD_TOO_LARGE`). Streamed responses are exempt. A 10 MB file therefore must **never** be sent to a function as a whole. Files are parsed and chunked in the browser, and only chunk **text** goes to `/api/embed`, in batches of at most 50 chunks (about 50–150 KB per request).
- **Function duration.** On Vercel's Hobby plan functions default to, and are capped at, 300 seconds. Answers stream well inside that. Set `maxDuration: 60` for `api/chat` and `api/embed`.

---

## 3. Repository structure

```
/
├─ public/
│  └─ index.html            ← the attached design, with the changes in section 5.9
├─ api/
│  ├─ health.js             ← GET  /api/health
│  ├─ embed.js              ← POST /api/embed
│  └─ chat.js               ← POST /api/chat  (Server-Sent Events)
├─ lib/
│  ├─ config.js             ← reads and validates env vars, exports constants
│  ├─ gemini.js             ← embed(), streamChat(), parseSSE(), errors
│  ├─ prompt.js             ← buildSystemInstruction(context)
│  └─ http.js               ← readJson(req, limit), sendJson(), sendError()
├─ scripts/
│  └─ dev-server.js         ← local dev server that mounts api/* and serves public/
├─ test/
│  ├─ mock-gemini.js        ← local mock of the Gemini endpoints (section 12)
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

`package.json` must include `"type": "module"`, `"engines": { "node": ">=22" }`, and these scripts:

```json
{
  "scripts": {
    "dev": "node scripts/dev-server.js",
    "dev:mock": "node test/mock-gemini.js & GEMINI_BASE_URL=http://localhost:4999 GEMINI_API_KEY=test node scripts/dev-server.js",
    "test": "node --test test/"
  }
}
```

---

## 4. Configuration (environment variables)

All variables are read in `lib/config.js`. Only `GEMINI_API_KEY` is required.

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** `GOOGLE_API_KEY` is also accepted and takes precedence if both are set, matching the Google SDKs. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Chat model |
| `GEMINI_API_VERSION` | `v1beta` | Path segment for the Interactions endpoint (`v1` is also documented) |
| `GEMINI_API_REVISION` | `2026-05-20` | Sent as the `Api-Revision` header. An empty value omits the header. |
| `GEMINI_THINKING_LEVEL` | `low` | Server default: `minimal`, `low`, `medium` or `high` |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Or `gemini-embedding-2` (see 7.2) |
| `GEMINI_EMBED_DIM` | `768` | 128–3072. Google recommends 768, 1536 or 3072. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Overridden in tests to point at the mock |
| `ALLOW_ORIGIN` | *(empty)* | Set only if the UI is served from a different origin |
| `PORT` | `3000` | Local dev server only |

`.env.example` lists these with an empty `GEMINI_API_KEY=` line.

---

## 5. Front end (public/index.html)

The attached file already implements everything in this section. Keep it working; the changes required are listed in **5.9**.

### 5.1 Layout and visual design (do not change)

- **Theme:** plum-black ground (`#1a0f1f`) in both light and dark modes, rose accent `#ff8fa3`, dusk support `#8f7aa8`, white ink.
- **Fonts:** Inter Tight (300, 500, 600) for headings and Inter for UI text, from Google Fonts.
- **Layout:** a 320 px library rail on the left (logo, drop zone, library, Gemini panel, retrieval settings) and the chat on the right (header pills, thread, composer).
- **Breakpoints:** at ≤860 px the chat comes first, the rail moves below it, and the composer is sticky. At ≤600 px avatars are hidden and wide pills collapse.
- **Welcome view:** headline, an animated SVG pipeline scene (pages → chunks → vector constellation → answer bubble), four labelled steps that use the model names from `/api/health`, and example question chips.
- **Motion:** one flowing-dash animation, step spinners and a typing indicator. All are disabled under `prefers-reduced-motion`.

### 5.2 Upload rules

| Rule | Value / behaviour |
|---|---|
| Max size | **10 MB per file** (`MAX_FILE_BYTES = 10 * 1024 * 1024`). Larger files get a library card in an error state reading "<size> is over the 10 MB limit". Nothing is read. |
| Empty file | Error card: "File is empty" |
| Accepted | `.pdf .docx .txt .md .markdown .csv .tsv .json .html .htm .xml .log .yaml .yml .rtf` and common code extensions, plus `text/*` |
| Multiple files | Allowed. Each file is processed independently. |
| Drag and drop | The whole window accepts drops. The drop zone highlights while a file is dragged over it. |
| Binary or unknown | If the decoded text has NUL bytes in its first 2,000 characters, show "This format isn't supported". |

The drop zone shows the pill "Up to 10 MB per file".

### 5.3 File parsing (browser)

- **PDF:** pdf.js `3.11.174` from cdnjs, with `GlobalWorkerOptions.workerSrc` set. Extract text page by page and keep page numbers for citations.
- **DOCX:** mammoth `1.6.0` from cdnjs, using `extractRawText`.
- **HTML:** parse with `DOMParser`, remove `script` and `style`, use `innerText`.
- **JSON:** pretty-print it so it chunks cleanly.
- **RTF:** strip control words.
- Pin CDN versions exactly. Adding SRI `integrity` attributes is optional.

### 5.4 Chunking

`chunkText(pages, size, overlap)`, already implemented:

- Defaults: `size = 900` characters, `overlap = 150` characters. Slider ranges: 300–3000 and 0–600. Overlap is clamped to `size − 50`.
- Collapse runs of spaces and more than two newlines.
- Prefer to break at the last paragraph break or sentence end (`. ` `? ` `! `) found in the final 40% of the window. Then step back by `overlap` and snap forward to a word boundary.
- Drop chunks of 20 characters or fewer.
- Each chunk records `{doc, docId, idx (1-based), page|null, text}`.
- "Re-chunk all files" re-runs chunking **and embedding** for every file with the current settings.

### 5.5 Embedding and indexing (browser side)

- After chunking, call `POST /api/embed` with `{texts, kind: "document"}` in batches of **50**. Update the file card to "Embedding with Gemini n/total…".
- Store each returned 768-d vector as `chunk.emb`. Vectors are already L2-normalised by the server.
- Always build the TF-IDF index too (`tokens()`, stop words, light stemming, `idf = ln((N+1)/(df+0.5))`).
- If embedding fails, keep the file with keyword search only and show "· keyword search only" in red on its card. The tooltip carries the error.

### 5.6 Retrieval

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

- Request: `POST /api/chat` with `{question, context:[{n, doc, page, text}], history: last 8 turns [{role:"user"|"assistant", content}], thinking: "minimal"|"low"|"medium"|"high"}`.
- Read the SSE stream (section 6.3) and render events as they arrive:
  - `th` → append to the thought-summary box in the Think step.
  - first `t` → mark Think done (time = request start → first token), start Answer, show the answer bubble.
  - `t` → append to the answer and re-render the markdown subset (paragraphs, `-` / `1.` lists, `**bold**`, `` `code` ``, and `[n]` citation chips).
  - `usage` → show thought tokens, output tokens and total tokens.
  - `error` → mark the running step red and show the message under any partial answer.
- **The trace has four rows:**
  1. Embed your question: `<embedModel> · RETRIEVAL_QUERY · <dim>-dimensional vector`, with time
  2. Find matching passages: `<n> of <total> chunks · 80% cosine similarity + 20% keyword · best <score>`, with time
  3. Think: `Thinking level: <level> · <n> thought tokens`, plus the streamed thought summary or "no summary returned"
  4. Write the answer: `<chatModel> · Interactions API, streamed · <n> output tokens`, with time
- **When the answer is done,** collapse the trace to: `Embedded → N passages → thought X s → answered in Y s · Z tokens`.
- **Citations:** clicking `[n]` scrolls to source card n and highlights it for 1.5 s. "Read passage" opens the full chunk in a modal.
- Only successful turns are added to `history`. "New chat" clears the history and returns to the welcome view.

### 5.8 Gemini panel and header

- On load, call `GET /api/health`. The header pill shows `Gemini · <chatModel>` with a green dot, or "Gemini not connected". The panel lists the chat model, the embeddings model and dimensions, and the API version, plus the thinking-level segmented control with a one-line note for each level.
- If the server can't be reached, show "Server not reachable. Start it with npm start." Change this copy to "Server not reachable." for production.

### 5.9 Changes required to the attached index.html

1. Change the error copy that says "Make sure it's running (npm start)" to a neutral message in production. Show the npm hint only when `location.hostname === 'localhost'`.
2. Leave `API` (`window.LUMEN_API`) defaulting to same-origin. No other changes are needed for Vercel.
3. Escape all user and document text with `esc()`. This is already done everywhere; keep it that way.
4. Do not add analytics, trackers or third-party scripts.

---

## 6. HTTP API

All endpoints are same-origin, JSON in and JSON out, except the `/api/chat` stream. Errors use the shape `{ "error": "<human-readable message>" }` with a suitable status code.

### 6.1 `GET /api/health`

```json
200 { "ok": true, "chatModel": "gemini-3.8-flash", "embedModel": "gemini-embedding-001",
      "dim": 768, "apiVersion": "v1beta", "thinking": "low" }
```
If the key is missing, return `ok: false` and `error: "GEMINI_API_KEY is not set on the server"`. Never echo the key or any part of it.

### 6.2 `POST /api/embed`

Request: `{ "texts": string[], "kind": "document" | "query" }`

- Validate: `texts` is a non-empty array of at most **100** strings. Each is coerced to a string and trimmed to 20,000 characters. The total body stays under 4 MB, so reject anything larger with a 413.
- Response: `200 { "vectors": number[][], "dim": 768, "model": "gemini-embedding-001" }`, one vector per text, in order and L2-normalised.
- Errors: 400 for validation, 413 for size, 429 when rate-limited upstream (pass it through), 502 for other upstream failures.

### 6.3 `POST /api/chat` (Server-Sent Events)

Request:

```json
{ "question": "How long do I have to return an item?",
  "context": [ { "n": 1, "doc": "policy.pdf", "page": 2, "text": "…" } ],
  "history": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ],
  "thinking": "low" }
```

Validation: `question` is required, at most 4,000 characters. `context` has at most 12 items with `text` of at most 20,000 characters each. `history` is limited to the last 8 items. `thinking` must be a valid level; otherwise use the server default.

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.

Each event is one line, `data: <json>`, followed by a blank line. Event payloads:

| Payload | Meaning |
|---|---|
| `{"step":"thought"}` / `{"step":"model_output"}` | A Gemini step started (informational) |
| `{"th":"…"}` | A piece of the thought summary |
| `{"t":"…"}` | A piece of the answer text |
| `{"usage":{"total_input_tokens":…, "total_output_tokens":…, "total_thought_tokens":…, "total_tokens":…}}` | Usage from `interaction.completed` |
| `{"error":"…"}` | An upstream or stream error. The client stops. |
| `{"done":true}` | Stream finished |

Errors before the stream starts are returned as normal JSON errors with a status code. Errors after the stream starts are sent as an `{"error"}` event, and then the stream ends.

---

## 7. Gemini integration (lib/gemini.js)

### 7.1 Authentication

Send the header `x-goog-api-key: <key>` on every request. For Interactions requests, also send `Api-Revision: <GEMINI_API_REVISION>` unless it is empty.

### 7.2 Embeddings

`POST {BASE}/v1beta/models/{EMBED_MODEL}:batchEmbedContents`

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
- **If `EMBED_MODEL` starts with `gemini-embedding-2`,** omit `taskType` and prefix the text instead: queries become `task: search result | query: <text>` and documents become `title: none | text: <text>`. The two models' vectors are **not comparable**, so the user must re-embed after switching (in v1 that means reloading the page).
- Input limit: 2,048 tokens for gemini-embedding-001. A 3,000-character chunk is well under it.

### 7.3 Chat (Interactions API, streamed)

`POST {BASE}/{API_VERSION}/interactions?alt=sse`

```json
{
  "model": "gemini-3.8-flash",
  "system_instruction": "<built by prompt.js, see section 8>",
  "input": [
    { "type": "user_input",   "content": [ { "type": "text", "text": "<earlier question>" } ] },
    { "type": "model_output", "content": [ { "type": "text", "text": "<earlier answer>" } ] },
    { "type": "user_input",   "content": [ { "type": "text", "text": "<current question>" } ] }
  ],
  "stream": true,
  "store": false,
  "generation_config": { "thinking_level": "low", "thinking_summaries": "auto" }
}
```

**Streaming events to handle.** Parse SSE blocks separated by a blank line and read the `data:` lines as JSON:

| Upstream event | Shape | Action |
|---|---|---|
| `step.start` | `{"event_type":"step.start","index":0,"step":{"type":"thought"\|"model_output"}}` | emit `{step}` |
| `step.delta` (text) | `{"event_type":"step.delta","delta":{"type":"text","text":"…"}}` | emit `{t}` |
| `step.delta` (thought) | `{"event_type":"step.delta","delta":{"type":"thought_summary","content":{"type":"text","text":"…"}}}` | emit `{th}` (also accept `delta.text`) |
| `interaction.completed` | `{"event_type":"interaction.completed","interaction":{"status":"completed","usage":{…}}}` | emit `{usage}`. If `status` is not `completed`, emit an error. |
| `error` | `{"event_type":"error","error":{"code":"…","message":"…"}}` | emit `{error: message}` |
| `data: [DONE]` | — | ignore |

Ignore any other event types, such as `interaction.created`, `interaction.status_update`, `step.stop` and `thought_signature` deltas.

**Fallback:** if the upstream `Content-Type` is `application/json` (not streamed), read `steps[]`, join the `text` items of `model_output` steps, emit them as a single `{t}`, then emit `{done:true}`.

**Cancellation:** create an `AbortController` per request and abort the upstream fetch when the client disconnects (`res.on('close')`).

### 7.4 Error mapping

| Upstream status | Return to client | Message hint |
|---|---|---|
| 400 | 502 | Pass on Gemini's `error.message` |
| 401 / 403 | 502 | Append: "check that your API key is valid and restricted to the Gemini API" |
| 429 | 429 | Append: "rate limit reached, try again shortly" |
| 5xx / network | 502 | "Gemini is unavailable, try again" |

Retry once, after 800 ms, on 429 or 5xx for `/api/embed` only. Do not retry chat streams.

---

## 8. Prompt (lib/prompt.js)

Use this text exactly. `<passages>` is the context items joined with `\n\n---\n\n`, each formatted as `[n] (doc[, page p])\n<text>`, or `(no matching passages were found)` when there are none.

```
You are a document question-answering assistant in a retrieval-augmented (RAG) app. Answer the user's question using ONLY the numbered context passages below, which were retrieved from files the user uploaded.
Rules:
- Cite the passage numbers you used in square brackets right after each claim, like [1] or [2][3].
- If the passages do not contain the answer, say plainly that the uploaded documents don't cover it, and suggest what to ask or upload instead. Do not use outside knowledge to fill gaps.
- Be concise and direct. Use short paragraphs or a bulleted list. Plain text with **bold** allowed; no headings.

CONTEXT PASSAGES:
<passages>
```

The passages are wrapped in `system_instruction`. Treat document text as data. Never let it change server behaviour.

---

## 9. Vercel Functions implementation notes

- Use the Node.js runtime with the classic handler signature `export default async function handler(req, res)` in `api/*.js`. Share logic through `lib/`.
- Vercel parses JSON bodies into `req.body`. Use it when it is present; otherwise fall back to reading the stream with `readJson` (needed for the local dev server).
- **Streaming:** call `res.setHeader(...)` for the SSE headers, then `res.write()` for each event and `res.end()` at the end. Don't buffer the whole answer.
- Export a config for duration, or set it in `vercel.json`:

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

- Run `vercel build` locally (or check the first preview deployment) to confirm that `/` serves `public/index.html` and that `/api/*` routes to the functions. Adjust `outputDirectory` if the project's framework preset differs. Use **Other** as the preset, with no build command.
- **Local dev:** `scripts/dev-server.js` uses `node:http` to serve `public/` and to route `/api/health`, `/api/embed` and `/api/chat` to the same handler modules, giving them a `res` that supports `status()`/`json()` shims. `vercel dev` is an alternative if the user is logged in to the Vercel CLI.

---

## 10. Security and privacy

- The API key is read only from environment variables on the server. It is never sent to the client, never logged and never put in an error message.
- Don't log request bodies, document text or answers. Log only the method, path, status, duration and upstream status codes.
- Use same-origin only by default. Add CORS headers only when `ALLOW_ORIGIN` is set.
- Validate input sizes on every endpoint (section 6). Reject non-JSON with a 400.
- Basic abuse protection: an in-memory per-IP limit of 60 requests per minute on `/api/chat` and 120 per minute on `/api/embed`, returning 429. This is best-effort on serverless; note it in the README as non-durable.
- In the README, recommend that the user restricts the key to the Gemini API in AI Studio and sets billing alerts in Google Cloud.
- Rendering: the front end escapes all text before inserting HTML. Keep it that way, and never use `innerHTML` with unescaped document or model text.

---

## 11. Performance targets

| Metric | Target |
|---|---|
| Time to interactive (desktop, broadband) | < 1.5 s |
| Embedding a 10 MB text file (~11,000 chunks at 900 characters) | Progress shown throughout, no UI freeze, < 3 min |
| Question → first answer token (Low thinking) | < 3 s typical |
| Memory | Must handle 10 files of 10 MB in one session without crashing. Warn in the library when the total exceeds 20,000 chunks. |

For very large files, let the browser keep rendering between embed batches (`await` per batch is enough), and send at most 3 batches in parallel.

---

## 12. Testing

### 12.1 Unit tests (`node --test`)

- `chunker.test.js`: respects size and overlap, prefers sentence breaks, drops tiny chunks, keeps page numbers.
- `retrieval.test.js`: the hybrid score orders a semantically closer chunk above a keyword-only match, and falls back to keywords when there are no embeddings.
- `sse.test.js`: parses the upstream examples in section 7.3, including events split across network chunks, `\r\n` line endings and `[DONE]`.
- `api.test.js`: validation errors (400/413), a missing key (500 with a clear message), and the error mapping in section 7.4.

To make the chunker and retrieval testable, move them into `public/lib/*.js` ES modules that `index.html` imports with `<script type="module">`, or copy them into `lib/` for tests. Keep a single source of truth.

### 12.2 Mock Gemini (`test/mock-gemini.js`)

A small `node:http` server on port 4999 that:

- answers `:batchEmbedContents` with deterministic 768-d vectors (hash each word into a dimension),
- streams for `/v1beta/interactions`: `interaction.created` → a `thought` step with two `thought_summary` deltas (content.text form) → a `model_output` step with 4–5 `text` deltas, including `[1]` → `interaction.completed` with usage,
- logs the received headers and body, so tests can assert `x-goog-api-key`, `Api-Revision`, `generation_config.thinking_level` and `thinking_summaries: "auto"`.

`npm run dev:mock` runs the whole app against the mock with no real key.

### 12.3 Manual acceptance against real Gemini

Run this after the user adds a real key, locally and on the Vercel preview:

1. Upload a 2–5 MB PDF and a DOCX. Both reach "Ready" without errors.
2. Ask a question answered on a specific page. The answer cites `[n]`, and the source card shows that page.
3. Ask something the documents don't cover. Gemini says the documents don't cover it.
4. Switch thinking to High. The thought summary appears, and the thought tokens are higher.
5. Upload an 11 MB file. It is rejected with the 10 MB message and nothing is sent to the server.
6. Use the browser's devtools to block `/api/embed`. Files fall back to "keyword search only" and chat still works.

---

## 13. Build order (milestones; commit after each)

1. **Scaffold.** Folder structure, `package.json`, `.gitignore`, `.env.example`, `vercel.json`, and the attached `index.html` moved to `public/`.
   Commit: `chore: scaffold Lumen project`
2. **Server library.** `lib/config.js`, `lib/http.js`, `lib/prompt.js` and `lib/gemini.js`, with unit tests for SSE parsing and normalisation.
   Commit: `feat: Gemini embeddings and streaming client`
3. **API routes.** `api/health.js`, `api/embed.js` and `api/chat.js`, plus `scripts/dev-server.js`.
   Commit: `feat: health, embed and chat endpoints`
4. **Mock and integration tests.** `test/mock-gemini.js` and `api.test.js`, and an end-to-end check with `npm run dev:mock`.
   Commit: `test: mock Gemini and API tests`
5. **Front-end polish.** The section 5.9 edits; the chunker and retrieval extracted to modules if needed; parallel embedding (3 batches); the chunk-count warning.
   Commit: `feat: front-end production tweaks`
6. **Docs.** README with setup, environment variables, local dev, deployment and limits.
   Commit: `docs: README and deployment guide`
7. **Push and deploy** (section 14).

---

## 14. GitHub push and Vercel deployment

### 14.1 Push to the current GitHub repository

1. Confirm the remote: `git remote -v` should show the user's GitHub repo. If there is no remote, stop and ask the user for the repository URL.
2. Make sure nothing secret is staged: `git status`. Check that `.env` and `.env.local` are git-ignored.
3. Run the tests: `npm test`. All must pass before pushing.
4. Push:
   - Work on a branch `feat/lumen-gemini-rag`, then push it: `git push -u origin feat/lumen-gemini-rag`.
   - Merge into the default branch (usually `main`) so that Vercel deploys it to production. If the default branch is protected, open a pull request with `gh pr create --fill`, give the user its link and ask them to merge. Otherwise merge with a fast-forward and push `main`.
   - Do not force-push.
5. Report the commit SHA and the GitHub URL to the user.

### 14.2 Create a new Vercel project linked to the repo

Vercel deploys automatically on every push once the project is linked to the GitHub repo. Use **one** of these two paths; the CLI path is preferred if the user is logged in.

**A. Vercel CLI (run from the repo root)**

```bash
npx vercel@latest login          # the user completes the login in the browser
npx vercel@latest link           # choose "Link to existing project? No" → create new project, name: lumen
npx vercel@latest git connect    # connects the project to this GitHub repo (if not done in link)
npx vercel@latest env add GEMINI_API_KEY production   # the user pastes the key when prompted
npx vercel@latest env add GEMINI_API_KEY preview
npx vercel@latest --prod         # first production deployment
```

**B. Vercel dashboard (if the CLI isn't available)**

Give the user these steps: **Add New… → Project → Import Git Repository**, pick this repo, set **Framework Preset: Other**, leave the build command empty, set **Output Directory: `public`**, add `GEMINI_API_KEY` under **Environment Variables**, then click **Deploy**.

**Notes**

- **Never** ask the user to paste the API key into the chat or a commit. They enter it directly in the Vercel prompt or dashboard.
- Pin the Node version through `package.json` `engines.node` (`>=22`). Vercel uses the latest LTS by default.
- After deployment: open the production URL, check that `/api/health` returns `ok: true`, run the section 12.3 checklist on production, and give the user the URL.

---

## 15. Acceptance criteria (definition of done)

- [ ] The UI matches the attached `index.html` pixel-for-pixel apart from the section 5.9 edits, on desktop (1360 px) and on a phone (390 px).
- [ ] Files over 10 MB are rejected in the browser with the specified message. No request body sent to any function exceeds 4.5 MB.
- [ ] Chunks are embedded with Gemini (`RETRIEVAL_DOCUMENT`), and questions use `RETRIEVAL_QUERY`. Vectors are 768-d and normalised.
- [ ] Answers stream through the Interactions API, with the thought summary, citations, source cards and the four-step trace showing real timings and token usage.
- [ ] The thinking level selected in the UI is sent and honoured.
- [ ] The API key never appears in client code, network responses, logs or git history.
- [ ] `npm test` passes, and `npm run dev:mock` works without a real key.
- [ ] The code is pushed to the current GitHub repo, the Vercel project `lumen` is linked to it, and the production URL works with `/api/health` returning `ok: true`.
- [ ] The README documents setup, environment variables, local dev, deployment and known limits (in-memory index, no OCR, non-durable rate limiting).

---

## 16. Roadmap (after v1, for reference only)

1. Persist documents and vectors: Vercel Blob for files and Postgres + pgvector (or Qdrant) for vectors, with server-side chunking.
2. Accounts (for example Auth.js) with per-user libraries.
3. OCR for scanned PDFs, or sending the PDF straight to Gemini for multimodal understanding.
4. Re-ranking the top 20 passages to a top 5 using Gemini.
5. Conversation memory using `previous_interaction_id` with `store: true`.
6. Exporting answers with their citations.

---

## Appendix A — Reference: SSE parsing on the server

```js
const decoder = new TextDecoder(); let buf = '';
for await (const chunk of upstream.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.search(/\r?\n\r?\n/)) > -1) {
    const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:'))
                      .map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.event_type === 'step.start' && ev.step?.type) emit({ step: ev.step.type });
    else if (ev.event_type === 'step.delta' && ev.delta?.type === 'text' && ev.delta.text) emit({ t: ev.delta.text });
    else if (ev.event_type === 'step.delta' && ev.delta?.type === 'thought_summary') {
      const th = ev.delta.content?.text ?? ev.delta.text; if (th) emit({ th });
    }
    else if (ev.event_type === 'error' || ev.error) emit({ error: ev.error?.message || 'Gemini returned an error' });
    else if (ev.event_type === 'interaction.completed') {
      if (ev.interaction?.usage) emit({ usage: ev.interaction.usage });
      if (ev.interaction?.status && ev.interaction.status !== 'completed')
        emit({ error: `Generation ended with status "${ev.interaction.status}"` });
    }
  }
}
emit({ done: true });
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
    if (ev.th) onThought(ev.th);
    if (ev.usage) onUsage(ev.usage);
    if (ev.t) onText(ev.t);
  }
}
```

## Appendix C — Sources consulted

- Gemini API keys: https://aistudio.google.com/docs/api-key
- Interactions API reference: https://ai.google.dev/api/interactions-api
- Streaming interactions: https://ai.google.dev/gemini-api/docs/streaming
- Thinking: https://ai.google.dev/gemini-api/docs/thinking
- Embeddings: https://ai.google.dev/gemini-api/docs/embeddings
- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel 4.5 MB body limit: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- Vercel Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
