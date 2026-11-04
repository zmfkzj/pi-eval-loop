export function parseCsv(text) {
  const rows = [];
  if (text === "") return rows;
  let row = [], field = "", i = 0, quoted = false, afterQuote = false;
  const endField = () => { row.push(field); field = ""; quoted = false; afterQuote = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; afterQuote = true; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      endRow(); i += ch === "\r" ? 2 : 1;
      continue;
    }
    if (afterQuote) throw new SyntaxError(`unexpected character after closing quote at ${i}`);
    if (ch === '"') {
      if (field !== "") throw new SyntaxError(`quote inside an unquoted field at ${i}`);
      quoted = true; i++; continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new SyntaxError("unterminated quoted field");
  const endsWithBreak = text.endsWith("\n");
  if (!endsWithBreak) endRow();
  return rows;
}
