const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parse(version) {
  const match = VERSION.exec(String(version).trim());
  if (!match) throw new TypeError(`invalid version ${version}`);
  return { nums: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
}

const comparePre = (a, b) => {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (nx) return -1;
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

function comparators(token) {
  if (token.startsWith("^")) {
    const { nums: [maj, min, pat] } = parse(token.slice(1));
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    return [[">=", token.slice(1)], ["<", `${upper}-0`]];
  }
  if (token.startsWith("~")) {
    const { nums: [maj, min] } = parse(token.slice(1));
    return [[">=", token.slice(1)], ["<", `${maj}.${min + 1}.0-0`]];
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!match) throw new TypeError(`invalid comparator ${token}`);
  parse(match[2]);
  return [[match[1] ?? "=", match[2]]];
}

const test = (version, [op, target]) => {
  const c = compare(version, target);
  return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
};

export function satisfies(version, range) {
  parse(version);
  const sets = String(range).split("||").map(set => set.trim().replace(/(>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean));
  if (sets.some(set => !set.length)) throw new TypeError(`invalid range ${range}`);
  const parsed = sets.map(set => set.flatMap(comparators));
  return parsed.some(set => set.every(comp => test(version, comp)));
}
