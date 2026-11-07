import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("package manifest", () => assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name, "billing-kit"));
