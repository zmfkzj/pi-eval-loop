import test from "node:test";
import assert from "node:assert/strict";
import { toc } from "../src/toc.js";

test("level 2 and 3 headings", () => {
  assert.equal(toc("# Title\n## Install\n### From npm\n## Usage"), "- [Install](#install)\n  - [From npm](#from-npm)\n- [Usage](#usage)");
});
