#!/usr/bin/env node
// Headless CLI of pi-eval-loop (implementation: src/cli.mjs; machine contract: src/contract.mjs and README "Unattended operation
// contract"). Never asks questions; lock-taking modes end with one JSON outcome line and a documented exit code.
//   eval-loop --once | --resume | --daemon [--max-cycles N] | --rollback [--reason R] | --verify-stable --tasks <sealed dataset dir>
//             | --ablation   options: --state <dir> (default pi-eval-loop/state/default)  --protocol <override.json>
//             --strategy pareto|greedy  --require-state (refuse to initialize when no loop state exists)
//   eval-loop --status [--summary] | --report | --doctor | --selftest   (read-only, no lock)
import { main } from "../src/cli.mjs";

process.exit(await main(process.argv.slice(2)));
