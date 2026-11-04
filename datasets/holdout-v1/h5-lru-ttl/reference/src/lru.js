export class LruCache {
  constructor(capacity, { ttlMs, now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }
  expired(entry) {
    return this.ttlMs !== undefined && this.now() - entry.at >= this.ttlMs;
  }
  prune() {
    for (const [key, entry] of this.map) if (this.expired(entry)) this.map.delete(key);
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.expired(entry)) { this.map.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  has(key) {
    const entry = this.map.get(key);
    return !!entry && !this.expired(entry);
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    this.prune();
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
    return this;
  }
  delete(key) {
    const live = this.has(key);
    this.map.delete(key);
    return live;
  }
  get size() {
    this.prune();
    return this.map.size;
  }
  keys() {
    this.prune();
    return [...this.map.keys()];
  }
}
