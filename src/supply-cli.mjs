// CLI of the holdout supply (bin/eval-loop-supply.mjs). Never runs a model; prints one non-secret JSON summary on stdout.
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadProtocol } from "./protocol.mjs";
import { atomicWriteJson, ensureDir } from "./util.mjs";
import { collect, mergeSupply, poolPath, poolStatus, sealBatch, validateCase } from "./supply.mjs";

const USAGE = "usage: eval-loop-supply collect|collect-exercism|seal|status --pool DIR [--config FILE] [--protocol FILE] [--repos owner/name,...] [--max-cases-per-repo N] [--no-seal]";

export async function main(argv) {
  let values, positionals;
  try { ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { pool: { type: "string" }, config: { type: "string" }, protocol: { type: "string" }, repos: { type: "string" }, "max-cases-per-repo": { type: "string" }, "no-seal": { type: "boolean" } } })); }
  catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); return 64; }
  const cmd = positionals[0];
  if (!["collect", "collect-exercism", "seal", "status"].includes(cmd) || !values.pool) { process.stderr.write(`${USAGE}\n`); return 64; }
  const log = (s) => process.stderr.write(`[supply] ${s}\n`);
  const pool = poolPath(values.pool);
  const cfg = mergeSupply(values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {});
  const protocol = loadProtocol(values.protocol);
  const minima = { minTasks: protocol.holdout.minTasks, minFamilies: protocol.holdout.minFamilies, requireHard: protocol.adoption.requireHardStratum, hardBasis: protocol.holdout.hardBasis };
  const { ORCHE, hostEnvironment } = await import("./sandbox.mjs");
  const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (cmd === "status") { print(poolStatus(pool, protocol, { orcheDir: ORCHE })); return 0; }
  /** @type {any} */ let summary = {};
  if (cmd === "collect" || cmd === "collect-exercism") {
    const { gradeWorkspace } = await import("./grader.mjs");
    const env = hostEnvironment();
    const tmpRoot = ensureDir(join(pool, "tmp"));
    const validate = (dir, opts = {}) => validateCase(dir, { env, scratch: mkdtempSync(join(tmpRoot, "v-")), repeats: cfg.validation.repeats, timeoutMs: cfg.validation.timeoutMs, gradeWorkspace, ...opts });
    if (cmd === "collect-exercism") {
      const { collectExercism } = await import("./supply-exercism.mjs");
      summary = await collectExercism({ pool, cfg, orcheDir: ORCHE, log, validate });
    } else {
      const repos = values.repos ? values.repos.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).map(slug => ({ slug, url: `https://github.com/${slug}.git` })) : undefined;
      summary = await collect({ pool, cfg, repos, env, orcheDir: ORCHE, log, validate, maxCasesPerRepo: values["max-cases-per-repo"] ? Number(values["max-cases-per-repo"]) : Infinity });
    }
  }
  let sealed;
  if (cmd === "seal" || (cmd.startsWith("collect") && !values["no-seal"])) {
    sealed = sealBatch({ pool, cfg, minima });
    summary.batch = sealed.blocked ? { blocked: sealed.blocked, coverage: sealed.coverage, eligible: sealed.eligible } : { batch: sealed.batch, coverage: sealed.coverage, seal: sealed.seal };
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  atomicWriteJson(join(pool, "reports", `${cmd}-${stamp}.json`), summary);
  print(summary);
  return sealed?.blocked ? 2 : 0;
}
