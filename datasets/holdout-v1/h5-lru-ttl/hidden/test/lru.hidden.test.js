import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/lru.js";

test("get refreshes recency, has does not", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["a", "c"]);
  assert.equal(cache.has("a"), true);
  cache.set("d", 4);
  assert.deepEqual(cache.keys(), ["c", "d"]);
});
test("replacing a key refreshes it and does not grow the cache", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2).set("a", 10).set("c", 3);
  assert.deepEqual(cache.keys(), ["a", "c"]);
  assert.equal(cache.get("a"), 10);
});
test("expiry: not returned, not counted, removed before evicting live entries", () => {
  let t = 0;
  const cache = new LruCache(2, { ttlMs: 100, now: () => t });
  cache.set("a", 1); t = 50; cache.set("b", 2);
  t = 100;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.size, 1);
  cache.set("c", 3);
  assert.deepEqual(cache.keys(), ["b", "c"]);
  t = 149; assert.equal(cache.get("b"), 2);
  t = 150; assert.equal(cache.get("b"), undefined);
  assert.equal(cache.delete("b"), false);
  assert.deepEqual(cache.keys(), ["c"]);
});
test("replacement restarts the time-to-live", () => {
  let t = 0;
  const cache = new LruCache(3, { ttlMs: 10, now: () => t });
  cache.set("a", 1); t = 8; cache.set("a", 2); t = 15;
  assert.equal(cache.get("a"), 2);
});
test("delete and capacity validation", () => {
  const cache = new LruCache(1);
  cache.set("a", 1);
  assert.equal(cache.delete("a"), true);
  assert.equal(cache.delete("a"), false);
  assert.throws(() => new LruCache(0), RangeError);
  assert.throws(() => new LruCache(1.5), RangeError);
});
