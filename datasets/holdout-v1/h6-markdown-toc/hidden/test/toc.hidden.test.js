import test from "node:test";
import assert from "node:assert/strict";
import { toc } from "../src/toc.js";

test("fenced code blocks are skipped", () => {
  const md = ["## A", "```sh", "## not a heading", "~~~", "## still code", "```", "## B", "~~~", "### code", "~~~", "### C"].join("\n");
  assert.equal(toc(md), "- [A](#a)\n- [B](#b)\n  - [C](#c)");
});
test("duplicate slugs are numbered in order", () => {
  assert.equal(toc("## Setup\n### Setup\n## Setup"), "- [Setup](#setup)\n  - [Setup](#setup-1)\n- [Setup](#setup-2)");
});
test("closing hashes, inline code, punctuation and unicode", () => {
  assert.equal(toc("## Options ##\n## The `run()` API!\n##   Über Café?"), "- [Options](#options)\n- [The run() API!](#the-run-api)\n- [Über Café?](#über-café)");
});
test("leading spaces and empty input", () => {
  assert.equal(toc("   ## Indented\n    ## too deep"), "- [Indented](#indented)");
  assert.equal(toc("no headings here"), "");
});
