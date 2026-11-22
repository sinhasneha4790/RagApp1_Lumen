// System instruction for the chat model (spec section 8). Text is used exactly.
// Document text is only ever placed inside this instruction as data.

export function formatPassages(context) {
  if (!context || !context.length) return '(no matching passages were found)';
  return context
    .map(c => `[${c.n}] (${c.doc}${c.page ? ', page ' + c.page : ''})\n${c.text}`)
    .join('\n\n---\n\n');
}

export function buildSystemInstruction(context) {
  return `You are a document question-answering assistant in a retrieval-augmented (RAG) app. Answer the user's question using ONLY the numbered context passages below, which were retrieved from files the user uploaded.
Rules:
- Cite the passage numbers you used in square brackets right after each claim, like [1] or [2][3].
- If the passages do not contain the answer, say plainly that the uploaded documents don't cover it, and suggest what to ask or upload instead. Do not use outside knowledge to fill gaps.
- Be concise and direct. Use short paragraphs or a bulleted list. Plain text with **bold** allowed; no headings.

CONTEXT PASSAGES:
${formatPassages(context)}`;
}
