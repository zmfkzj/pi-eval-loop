#!/usr/bin/env node
// Adjudication of open cross-provider review disputes (confirmatory-1, 2026-11-07). For each task whose triage is not "ok", a
// fresh reviewer session of a non-author provider decides from the instruction: accepted mutants (violation or not), blind tests
// the reference fails (reference defect, blind-test error, ambiguity) and blocker/major findings; it may write remedy tests for a
// confirmed test gap. The adjudicator's provider is chosen so that it authored NEITHER side of the dispute it judges: blind-test
// disputes (xAI tests vs Anthropic reference) go to Google, mutant/finding disputes (Google mutants vs Anthropic tests) to xAI;
// a task with both is adjudicated twice, each session only on its own dispute kind.
//
//   node studies/confirmatory-1/adjudicate.mjs --reviews DIR --task DIR [--task DIR ...] [--xai grok-4.7] [--google gemini-3-flash]
//        [--budget-ledger L --budget-limit N --budget-scope S [--max-requests 80] [--gateway-config CFG] [--require-attempt-bound]]
// Shared series ledger (2026-11-13, budget policy shared-total-only): with the three ledger flags every adjudication session is
// charged like a review (chargedReview: off-gate route "review", worst case reserved before the session, settled at the forwarded
// count or kept in full on a failure); a refused reservation runs nothing. --max-requests is the per-session request limit (a
// termination bound of one session, also its reservation size), not a separate allowance.
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, ensureDir } from "../../src/util.mjs";
import { reviewSession } from "./review.mjs";

/** Which adjudications a triage needs: [{ provider, scope }]. */
export function adjudicationsFor(triage) {
  const out = [];
  if (triage.blind && triage.blind.referencePasses === false) out.push({ provider: "google", scope: "blind" });
  const mutants = (triage.mutants ?? []).some(u => u.hiddenAccepts);
  const finding = triage.adversarial && triage.adversarial.verdict !== "accept";
  if (mutants || finding) out.push({ provider: "xai", scope: "adversarial" });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { reviews: { type: "string" }, task: { type: "string", multiple: true }, xai: { type: "string", default: "grok-4.7" }, google: { type: "string", default: "gemini-3-flash" }, scratch: { type: "string" }, parallel: { type: "string", default: "3" }, withhold: { type: "string", multiple: true, default: [] }, "budget-ledger": { type: "string" }, "budget-limit": { type: "string" }, "budget-scope": { type: "string" }, "max-requests": { type: "string", default: "80" }, "gateway-config": { type: "string" }, "require-attempt-bound": { type: "boolean" } } });
  const ledgerArgs = ["budget-ledger", "budget-limit", "budget-scope"].filter(k => values[k] !== undefined);
  if (ledgerArgs.length && ledgerArgs.length !== 3) { process.stderr.write("--budget-ledger, --budget-limit and --budget-scope go together\n"); process.exit(64); }
  const maxRequests = Number(values["max-requests"]);
  if (!(Number.isInteger(maxRequests) && maxRequests > 0)) { process.stderr.write("--max-requests must be a positive integer (per-session request limit)\n"); process.exit(64); }
  const { RequestBudget, gatewayAttemptBound } = await import("../../src/request-budget.mjs");
  const { chargedReview } = await import("./review.mjs");
  const budget = ledgerArgs.length ? new RequestBudget({ path: resolve(values["budget-ledger"]), limit: Number(values["budget-limit"]), scope: values["budget-scope"] }) : null;
  const { hostEnvironment } = await import("../../src/sandbox.mjs");
  const { loadLocal } = await import("../../src/datasets.mjs");
  const env = hostEnvironment();
  const reviews = resolve(values.reviews);
  const scratchRoot = ensureDir(resolve(values.scratch ?? join(reviews, "..", "scratch")));
  const jobs = [];
  for (const d of values.task ?? []) {
    const dir = resolve(d); const task = loadLocal(resolve(dir, "..")).find(x => x.dir === dir);
    const triPath = join(reviews, task.id, "triage.json");
    if (!existsSync(triPath)) continue;
    const triage = JSON.parse(readFileSync(triPath, "utf8"));
    if (triage.classes.includes("incomplete")) continue;
    for (const a of adjudicationsFor(triage)) jobs.push({ task, triage, ...a });
  }
  let next = 0; const results = [];
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const { task, triage } = job;
      const model = job.provider === "google" ? values.google : values.xai;
      const ctx = ensureDir(join(scratchRoot, `adj-${task.id}-${randomBytes(3).toString("hex")}`));
      // Only the material of the dispute this session judges (scope) is placed in its bundle.
      const verdict = join(triage.adversarial.dir, "output", "verdict.json");
      if (job.scope === "adversarial" && existsSync(verdict)) cpSync(verdict, join(ctx, "verdict.json"));
      atomicWriteJson(join(ctx, "crosscheck.json"), job.scope === "blind" ? { scope: "blind", blind: triage.blind && { referencePasses: triage.blind.referencePasses, referenceFailing: triage.blind.referenceFailing } } : { scope: "adversarial", mutants: triage.mutants, findings: triage.adversarial.findings });
      const extra = { review: ctx, ...(job.scope === "blind" ? { blind: join(triage.blind.dir, "output", "tests") } : { mutants: join(triage.adversarial.dir, "output", "mutants"), blind: join(triage.blind.dir, "output", "tests") }) };
      const out = join(reviews, task.id, `adjudicate-${job.scope}-${model}-${new Date().toISOString().replace(/[:.]/g, "")}`);
      try {
        const bound = values["gateway-config"] ? () => gatewayAttemptBound({ config: resolve(values["gateway-config"]), model }) : null;
        const rec = await chargedReview({ budget, maxRequests, bound, requireBound: values["require-attempt-bound"] === true, meta: { task: task.id, role: "adjudicate", model, out } },
          () => reviewSession({ task, role: "adjudicate", route: { provider: "cliproxyapi", model, effort: "high" }, out, env, maxRequests, withheld: values.withhold, scratchRoot, extra }));
        let adjudication = null; try { adjudication = JSON.parse(readFileSync(join(out, "output", "adjudication.json"), "utf8")); } catch { /* missing */ }
        atomicWriteJson(join(out, "mechanical.json"), { scope: job.scope, adjudication });
        results.push({ task: task.id, scope: job.scope, model, completed: rec.run.completed, verdict: adjudication?.verdict ?? null, remedy: adjudication?.remedy ?? null });
        process.stderr.write(`[adjudicate] ${task.id} ${job.scope} ${adjudication?.verdict ?? "no verdict"}\n`);
      } catch (error) { results.push({ task: task.id, scope: job.scope, error: String(error?.message ?? error).slice(0, 200) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
}
