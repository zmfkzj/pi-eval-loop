export function mergeIntervals(list) {
  for (const [start, end] of list) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new RangeError(`invalid interval [${start}, ${end}]`);
  }
  const sorted = list.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const pair of sorted) {
    const last = out[out.length - 1];
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
    else out.push(pair);
  }
  return out;
}
