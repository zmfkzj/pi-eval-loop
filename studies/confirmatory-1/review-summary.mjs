#!/usr/bin/env node
// Non-secret summary of every cross-provider review session (confirmatory-1, 2026-11-07; model-free): per task the triage
// classes, per session the role, requested route, response models, provider, request/token counts, list-price cost, denial-probe
// result and verdict - no task content. Also the totals of reviewer calls (reported apart from target-model calibration calls).
//   node studies/confirmatory-1/review-summary.mjs --reviews DIR [--out FILE]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/**
 * Identity of one review session: its Pi session id + start time when recorded, else the sha256 of its review.json. A session
 * directory copied to another task version (same record) is the SAME session: listed under both tasks (duplicateOf), counted
 * once in the totals (2026-11-07: one copied lockerbill review was billed twice before).
 */
export function sessionKey(r, raw) { return r?.session?.id && r?.startedAt ? `${r.session.id}@${r.startedAt}` : createHash("sha256").update(raw).digest("hex"); }

/** @param {string | string[]} roots review directories (e.g. reviews-v2 and reviews-v3) */
export function summarize(roots) {
  roots = [roots].flat();
  const tasks = {}; const totals = { sessions: 0, failedSessions: 0, duplicateListings: 0, forwarded: 0, completed: 0, inputTokens: 0, outputTokens: 0, listPriceUSD: 0, byModel: {}, unpriced: { sessions: 0, forwarded: 0, inputTokens: 0, outputTokens: 0, models: [] } };
  const seen = new Map();
  for (const reviews of roots) for (const id of readdirSync(reviews).filter(n => n.startsWith("cf1-") && statSync(join(reviews, n)).isDirectory()).sort()) {
    const sessions = [];
    for (const s of readdirSync(join(reviews, id)).filter(n => statSync(join(reviews, id, n)).isDirectory()).sort()) {
      let raw; try { raw = readFileSync(join(reviews, id, s, "review.json")); } catch { continue; }
      const r = readJson(join(reviews, id, s, "review.json")); if (!r) continue;
      const key = sessionKey(r, raw);
      const dup = seen.get(key);
      const m = readJson(join(reviews, id, s, "mechanical.json")) ?? {};
      const probe = r.access?.denialProbe ?? [];
      const verdict = r.role === "adversarial" ? m.verdict?.verdict ?? null : r.role === "adjudicate" ? m.adjudication?.verdict ?? null : null;
      const ok = r.run.completed > 2 && r.run.providerErrors === 0;
      sessions.push({ session: s, role: r.role, route: r.reviewer.route, provider: r.reviewer.provider, responseModels: r.reviewer.responseModels, startedAt: r.startedAt, forwarded: r.run.forwarded, completed: r.run.completed, providerErrors: r.run.providerErrors, tokens: r.run.tokens, listPriceUSD: r.run.listPriceUSD, probe: { withheld: probe.length, visible: probe.filter(p => p.visible).length, unchecked: probe.filter(p => !p.checked).length }, complete: ok, verdict, ...(dup ? { duplicateOf: dup } : {}), ...(r.role === "blind-tests" ? { blindTests: m.blindTests ?? 0, referencePasses: m.referencePasses ?? null, discriminates: m.discriminates ?? null } : {}), ...(r.role === "adversarial" ? { mutants: (m.mutants ?? []).length, acceptedByHidden: (m.mutants ?? []).filter(u => u.hiddenAccepts).length, referencePassesHidden: m.referencePassesHidden ?? null } : {}), ...(r.role === "adjudicate" ? { scope: m.scope, remedy: m.adjudication?.remedy ?? null, violations: (m.adjudication?.mutants ?? []).filter(u => u.resolution === "violation").length, notViolations: (m.adjudication?.mutants ?? []).filter(u => u.resolution === "not-a-violation").length } : {}) });
      if (dup) { totals.duplicateListings++; continue; }
      seen.set(key, `${id}/${s}`);
      totals.sessions++; if (!ok) totals.failedSessions++;
      if (!(r.run.listPriceUSD > 0) && (r.run.forwarded ?? 0) > 0) { totals.unpriced.sessions++; totals.unpriced.forwarded += r.run.forwarded ?? 0; totals.unpriced.inputTokens += r.run.tokens?.input ?? 0; totals.unpriced.outputTokens += r.run.tokens?.output ?? 0; if (!totals.unpriced.models.includes(r.reviewer.route)) totals.unpriced.models.push(r.reviewer.route); }
      totals.forwarded += r.run.forwarded ?? 0; totals.completed += r.run.completed ?? 0; totals.inputTokens += r.run.tokens?.input ?? 0; totals.outputTokens += r.run.tokens?.output ?? 0; totals.listPriceUSD += r.run.listPriceUSD ?? 0;
      const k = r.reviewer.route; totals.byModel[k] ??= { sessions: 0, forwarded: 0, inputTokens: 0, outputTokens: 0, listPriceUSD: 0 };
      totals.byModel[k].sessions++; totals.byModel[k].forwarded += r.run.forwarded ?? 0; totals.byModel[k].inputTokens += r.run.tokens?.input ?? 0; totals.byModel[k].outputTokens += r.run.tokens?.output ?? 0; totals.byModel[k].listPriceUSD += r.run.listPriceUSD ?? 0;
    }
    const triage = readJson(join(reviews, id, "triage.json"));
    if (tasks[id]) { tasks[id].sessions.push(...sessions); continue; }
    tasks[id] = { classes: triage?.classes ?? null, mutants: triage?.mutants?.map(u => ({ name: u.name, hiddenAccepts: u.hiddenAccepts, blindRejects: u.blindRejects })) ?? null, sessions };
  }
  totals.listPriceUSD = Math.round(totals.listPriceUSD * 100) / 100;
  return { schema: "pi-eval-loop/confirmatory-1-review-summary@1", generatedAt: new Date().toISOString(), note: "reviewer/adjudicator calls of non-target models through the local gateway; list prices from the gateway catalog (0 = catalog has no price, not free of charge: see totals.unpriced); a session copied to another task version is listed there with duplicateOf and counted once; NOT target-model calibration requests", roots, totals, tasks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { reviews: { type: "string", multiple: true }, out: { type: "string" } } });
  const text = `${JSON.stringify(summarize(values.reviews.map(r => resolve(r))), null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
