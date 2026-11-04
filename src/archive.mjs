// Candidate archive: lineage, hypotheses, diffs, every screening/development result and decision. Records are never deleted;
// the Pareto front is recomputed from ALL development-evaluated candidates (dominated ones stay as possible parents).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, ensureDir, readJson, sha256 } from "./util.mjs";

export const STATUSES = ["created", "build_failed", "rejected_patch", "duplicate", "screening", "promoted", "rejected", "inconclusive", "dev_qualified", "dev_rejected", "selected", "holdout_kept_stable", "holdout_blocked", "adopted", "rolled_back", "baseline"];

/** Normalized patch hash: ignores index lines, hunk offsets and whitespace-only differences. */
export function patchKey(patch) {
  const lines = String(patch).split("\n").filter(line => !/^(index |@@ |diff --git )/.test(line)).map(line => line.replace(/\s+/g, " ").trimEnd()).filter(Boolean);
  return sha256(lines.join("\n"));
}
const tokens = (text) => new Set(String(text).toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").split(" ").filter(word => word.length > 2));
export function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Non-dominated points among {id, overall, hard, consistency} (missing hard compares as equal). */
export function paretoFront(points) {
  const keys = ["overall", "hard", "consistency"];
  const value = (p, k) => (Number.isFinite(p[k]) ? p[k] : 0);
  const dominates = (p, q) => keys.every(k => value(p, k) >= value(q, k)) && keys.some(k => value(p, k) > value(q, k));
  return points.filter(q => !points.some(p => p !== q && dominates(p, q)));
}

export class Archive {
  constructor(stateDir) { this.dir = ensureDir(join(stateDir, "candidates")); }
  path(id) { return join(this.dir, id, "candidate.json"); }
  get(id) { return existsSync(this.path(id)) ? readJson(this.path(id)) : undefined; }
  all() { return existsSync(this.dir) ? readdirSync(this.dir).filter(id => existsSync(this.path(id))).sort().map(id => this.get(id)) : []; }
  put(candidate) { candidate.updatedAt = new Date().toISOString(); atomicWriteJson(this.path(candidate.id), candidate); return candidate; }
  create(fields) {
    const id = fields.id;
    if (this.get(id)) throw new Error(`candidate ${id} exists`);
    ensureDir(join(this.dir, id));
    return this.put({ status: "created", decisions: [], children: [], createdAt: new Date().toISOString(), ...fields });
  }
  decide(id, status, reason, extra = {}) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
    const c = this.get(id);
    c.status = status;
    c.decisions.push({ at: new Date().toISOString(), status, reason });
    Object.assign(c, extra);
    return this.put(c);
  }
  nextId(prefix = "c") { const n = this.all().filter(c => c.id.startsWith(prefix)).length; return `${prefix}${String(n + 1).padStart(3, "0")}`; }

  /** Development-evaluated candidates with their dev point estimates (never removed). */
  developmentSet() { return this.all().filter(c => c.development?.point && (c.status === "baseline" || c.development.qualified)); }
  front() { return paretoFront(this.developmentSet().map(c => ({ id: c.id, ...c.development.point }))).map(p => p.id); }
  /** Is `id`'s development point weakly dominated (>= on every objective, ties included) by ANOTHER development-set member? */
  weaklyDominated(id) {
    const value = (p, k) => (Number.isFinite(p[k]) ? p[k] : 0);
    const me = this.get(id)?.development?.point;
    if (!me) return true;
    return this.developmentSet().some(c => c.id !== id && ["overall", "hard", "consistency"].every(k => value(c.development.point, k) >= value(me, k)));
  }

  /** Duplicate guard: same normalized patch, or a hypothesis close to an earlier failed one for the same failure class. */
  duplicateOf(patch, hypothesis, threshold) {
    const key = patchKey(patch);
    for (const c of this.all()) {
      if (c.patchKey && c.patchKey === key) return { id: c.id, why: "identical normalized patch" };
      const failed = ["rejected", "rejected_patch", "build_failed", "dev_rejected", "duplicate"].includes(c.status);
      if (failed && c.hypothesis && hypothesis && c.hypothesis.targetFailureClass === hypothesis.targetFailureClass && similarity(c.hypothesis.text, hypothesis.text) >= threshold) return { id: c.id, why: `hypothesis similar (>= ${threshold}) to failed ${c.id}` };
    }
    return undefined;
  }
  /** Failed proposals per target failure class (to stop retrying a class that keeps failing). */
  failuresByClass() {
    const out = {};
    for (const c of this.all()) if (c.hypothesis?.targetFailureClass && ["rejected", "rejected_patch", "build_failed", "dev_rejected", "duplicate"].includes(c.status)) out[c.hypothesis.targetFailureClass] = (out[c.hypothesis.targetFailureClass] ?? 0) + 1;
    return out;
  }
  childFailures(parentId) { return this.all().filter(c => c.parent === parentId && ["rejected", "rejected_patch", "build_failed", "dev_rejected", "duplicate", "inconclusive"].includes(c.status)).length; }
}

/**
 * Next parent: a Pareto-front member (strategy "pareto") or the single current best (strategy "greedy", quality-only ablation);
 * parents that produced too many failed children are skipped while another exists. Deterministic given the rng.
 */
export function selectParent(archive, { strategy, rng, maxChildFailures, current }) {
  if (strategy === "greedy") return current;
  const front = archive.front();
  const usable = front.filter(id => archive.childFailures(id) < maxChildFailures);
  const pool = usable.length ? usable : front;
  if (!pool.length) return current;
  return rng.pick(pool);
}
