export function parseCsv(text) {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n").map(line => line.split(","));
}
