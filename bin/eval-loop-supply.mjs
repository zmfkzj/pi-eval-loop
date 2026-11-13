#!/usr/bin/env node
// Public-source holdout supply (implementation: src/supply.mjs; see docs/design.md "Holdout supply"). Model-free.
//   eval-loop-supply collect          --pool DIR [--config FILE] [--repos owner/name,...] [--max-cases-per-repo N] [--no-seal]
//   eval-loop-supply collect-exercism --pool DIR [--config FILE] [--track owner/name] [--no-seal]   (default: every configured track)
//   eval-loop-supply seal             --pool DIR [--config FILE] [--protocol FILE]
//   eval-loop-supply status           --pool DIR [--config FILE] [--protocol FILE]   (includes the supply outlook)
//   eval-loop-supply refresh          --pool DIR [--protocol FILE] [--skip-commits] [--max-batches N]   (unattended pass: all sources + seal)
// stdout: one JSON summary (non-secret: ids, URLs, counts, reason codes). Logs on stderr. Exit 0 ok (refresh: an eligible unused
// batch is available), 2 blocked (refresh: none available), 3 refresh already running, 1 error, 64 usage.
import { main } from "../src/supply-cli.mjs";

process.exit(await main(process.argv.slice(2)));
