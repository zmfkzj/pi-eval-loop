const slug = (title) => title.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

export function toc(markdown) {
  const lines = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{2,3}) (.+)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length === 3 ? "  " : "";
    lines.push(`${indent}- [${match[2]}](#${slug(match[2])})`);
  }
  return lines.join("\n");
}
