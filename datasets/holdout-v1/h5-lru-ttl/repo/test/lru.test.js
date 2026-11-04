import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/lru.js";

test("stores and evicts the oldest insertion", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});
