// Incremental Server-Sent Events parser. Feed decoded text with push(); each event's
// `data:` lines are joined and parsed as JSON. Handles \n\n and \r\n\r\n separators,
// events split across network chunks, comments, malformed JSON and `data: [DONE]`.

export function createSSEParser(onData) {
  let buf = '';
  const block = b => {
    const data = b.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let ev; try { ev = JSON.parse(data); } catch { return; }
    onData(ev);
  };
  return {
    push(text) {
      buf += text;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) { const b = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); block(b); }
    },
    end() { if (buf.trim()) block(buf); buf = ''; }
  };
}
