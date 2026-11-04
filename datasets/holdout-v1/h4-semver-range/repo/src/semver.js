export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new TypeError(`invalid version ${version}`);
  return match.slice(1).map(Number);
}

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function satisfies(version, range) {
  return compare(version, range.trim()) === 0;
}
