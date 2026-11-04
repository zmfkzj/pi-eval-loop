export class LruCache {
  constructor(capacity, { ttlMs, now = Date.now } = {}) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    return entry?.value;
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    this.map.set(key, { value, at: this.now() });
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
    return this;
  }
  delete(key) {
    return this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
  keys() {
    return [...this.map.keys()];
  }
}
