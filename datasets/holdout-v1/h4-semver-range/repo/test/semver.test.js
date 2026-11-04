import test from "node:test";
import assert from "node:assert/strict";
import { compare, satisfies } from "../src/semver.js";

test("exact versions", () => {
  assert.equal(satisfies("1.2.3", "1.2.3"), true);
  assert.equal(satisfies("1.2.4", "1.2.3"), false);
  assert.equal(compare("1.10.0", "1.9.9"), 1);
});
