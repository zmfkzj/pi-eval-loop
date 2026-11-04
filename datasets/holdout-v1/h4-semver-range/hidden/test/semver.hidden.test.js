import test from "node:test";
import assert from "node:assert/strict";
import { compare, satisfies } from "../src/semver.js";

test("comparators, sets and alternatives", () => {
  assert.equal(satisfies("1.5.0", ">=1.2.0 <2.0.0"), true);
  assert.equal(satisfies("2.0.0", ">=1.2.0 <2.0.0"), false);
  assert.equal(satisfies("0.9.0", "<1.0.0 || >=3.0.0"), true);
  assert.equal(satisfies("3.1.0", "<1.0.0 || >=3.0.0"), true);
  assert.equal(satisfies("2.0.0", "<1.0.0 || >=3.0.0"), false);
  assert.equal(satisfies("1.2.0", ">= 1.2.0   <=  1.2.0"), true);
  assert.equal(satisfies("1.2.1", ">1.2.0"), true);
  assert.equal(satisfies("1.2.0", "=1.2.0"), true);
});
test("caret ranges", () => {
  assert.equal(satisfies("1.9.9", "^1.2.3"), true);
  assert.equal(satisfies("2.0.0", "^1.2.3"), false);
  assert.equal(satisfies("1.2.2", "^1.2.3"), false);
  assert.equal(satisfies("0.2.9", "^0.2.3"), true);
  assert.equal(satisfies("0.3.0", "^0.2.3"), false);
  assert.equal(satisfies("0.0.3", "^0.0.3"), true);
  assert.equal(satisfies("0.0.4", "^0.0.3"), false);
});
test("tilde ranges", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.equal(satisfies("1.2.2", "~1.2.3"), false);
});
test("pre-release precedence", () => {
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compare("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compare("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compare("1.0.0-rc.1", "1.0.0-beta.11"), 1);
  assert.equal(compare("2.0.0", "2.0.0"), 0);
  assert.equal(satisfies("2.0.0-rc.1", "<2.0.0"), true);
  assert.equal(satisfies("1.0.0-beta", ">=1.0.0-alpha <1.0.0"), true);
});
test("invalid input throws TypeError", () => {
  assert.throws(() => satisfies("1.2", ">=1.0.0"), TypeError);
  assert.throws(() => satisfies("1.2.3", ">>1.0.0"), TypeError);
  assert.throws(() => satisfies("1.2.3", "^1.x"), TypeError);
  assert.throws(() => compare("a.b.c", "1.0.0"), TypeError);
});
