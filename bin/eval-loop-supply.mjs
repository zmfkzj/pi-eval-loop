#!/usr/bin/env node
// Public-source holdout supply (implementation: src/supply.mjs; see docs/design.md "Holdout supply"). Model-free.
//   eval-loop-supply collect --pool DIR [--config FILE] [--repos owner/name,...] [--max-cases-per-repo N] [--no-seal]
//   eval-loop-supply seal    --pool DIR [--config FILE] [--protocol FILE]
//   eval-loop-supply status  --pool DIR [--protocol FILE]
// stdout: one JSON summary (non-secret: ids, URLs, counts, reason codes). Logs on stderr. Exit 0 ok, 2 blocked, 1 error, 64 usage.
import { main } from "../src/supply-cli.mjs";

process.exit(await main(process.argv.slice(2)));
