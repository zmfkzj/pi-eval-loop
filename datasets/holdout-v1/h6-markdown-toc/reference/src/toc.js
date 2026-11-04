const slugOf = (title) => title.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");

export function toc(markdown) {
  const lines = [];
  const seen = new Map();
  let fence = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^ {0,3}(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{2,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!match || /^#/.test(match[2])) continue;
    const title = match[2].replace(/`/g, "").trim();
    if (!title) continue;
    const base = slugOf(title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count ? `${base}-${count}` : base;
    lines.push(`${match[1].length === 3 ? "  " : ""}- [${title}](#${slug})`);
  }
  return lines.join("\n");
}
