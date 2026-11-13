// Global, durable, fail-closed request budget for chargeable target-model runs (calibration; docs/design.md "Request budget").
//
// The budget is ONE hash-chained ledger (util.mjs Ledger) shared by every run, resume and rerun that names it; its ceiling is
// fixed by the first record (`init`) and can never be raised by a later process. Accounting unit = one model request that leaves
// the metered boundary (a POST the unit's route proxy forwards upstream: nested agent turns, retries, failures and timeouts all
// pass that proxy and all count). Before an attempt is dispatched, its WORST CASE (the per-attempt proxy cap, which the proxy
// enforces by refusing the next POST) is reserved atomically under an exclusive lock:
//
//   charged = sum over reservations of (settled ? used : amount)     (an unsettled reservation counts in full, forever, until
//                                                                     its owner settles it: a crash never lowers the count)
//   admit iff charged + amount <= limit  AND  every external meter + open reserved amounts + amount <= limit - meterMargin
//
// so the ceiling holds whatever happens to the controller afterwards (crash, kill, concurrent processes, restarts). An
// unreadable or edited ledger, a ledger whose init differs from the caller's limit/scope, a lock that cannot be taken, or a
// required meter that cannot be read REFUSES the reservation (fail closed). External meters (e.g. the gateway's own usage
// database, gatewayUsageMeter below) count provider-side events for the target model since the budget was created; they include
// gateway-internal credential retries the proxy cannot see and any other client of the same model (over-attribution only makes
// the check stricter).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Ledger, LockBusyError, acquireLock, atomicWriteJson, sha256, sleep } from "./util.mjs";

export const BUDGET_SCHEMA = "pi-eval-loop/request-budget@1";

export class BudgetError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) { super(message); this.code = code; }
}

/** Charged/settled/open totals of a budget ledger's records (pure). */
export function budgetTotals(records) {
  const init = records.find(r => r.type === "init");
  /** @type {Map<string, any>} */ const res = new Map();
  const problems = [];
  for (const r of records) {
    if (r.type === "reserve") { if (res.has(r.id)) problems.push(`reservation ${r.id} appears twice`); res.set(r.id, { ...r, settled: false }); }
    else if (r.type === "settle") {
      const x = res.get(r.id);
      if (!x) { problems.push(`settlement of unknown reservation ${r.id}`); continue; }
      if (x.settled) { problems.push(`reservation ${r.id} settled twice`); continue; }
      x.settled = true; x.used = r.used;
      if (!(Number.isInteger(r.used) && r.used >= 0)) problems.push(`reservation ${r.id}: used ${r.used} is not a count`);
      else if (r.used > x.amount) problems.push(`reservation ${r.id}: used ${r.used} exceeds its reserved worst case ${x.amount} (per-attempt cap breached)`);
    }
  }
  let charged = 0, settledUsed = 0, open = 0, openAmount = 0;
  for (const x of res.values()) {
    // An overrun (used > amount) is charged at what was used: the ledger never under-counts.
    if (x.settled) { charged += Math.max(x.used ?? x.amount, 0); settledUsed += x.used ?? 0; }
    else { charged += x.amount; open++; openAmount += x.amount; }
  }
  // Outbound attempts admitted by the attempt gate (src/outbound-gate.mjs): each one is an actual provider attempt that the gate
  // let leave the isolated runtime. Invariant (checked by the gate before every admission, kept by settle's floor): attempts never
  // exceed what the ledger charges, so the charged total is a conservative bound on actual attempts at every moment.
  const attempts = records.filter(r => r.type === "attempt").length;
  if (attempts > charged) problems.push(`outbound attempts ${attempts} exceed the charged total ${charged} (an attempt left without a covering reservation)`);
  const limit = init?.limit ?? null;
  return { limit, charged, settledUsed, openReservations: open, openAmount, reservations: res.size, attempts, remaining: limit === null ? null : limit - charged, problems };
}

/**
 * Durable request budget. `meters`: [{ name, read(): number, required?: boolean }] counted since the ledger's init time.
 * @param {{ path: string, limit: number, scope: string, meters?: Array<{ name: string, read: (sinceMs: number) => number, required?: boolean }>, meterMargin?: number, lockWaitMs?: number, now?: () => number }} options
 */
export class RequestBudget {
  constructor({ path, limit, scope, meters = [], meterMargin = 0, lockWaitMs = 30_000, now = () => Date.now(), requireAnchor = true }) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new BudgetError("request budget: limit must be a positive integer", "EBUDGETCONFIG");
    if (!scope) throw new BudgetError("request budget: scope is required", "EBUDGETCONFIG");
    if (!(Number.isInteger(meterMargin) && meterMargin >= 0 && meterMargin < limit)) throw new BudgetError("request budget: meterMargin must be an integer in [0, limit)", "EBUDGETCONFIG");
    Object.assign(this, { path, limit, scope, meters, meterMargin, lockWaitMs, now, requireAnchor });
    this.ledger = new Ledger(path);
    this.refusal = null;
  }

  /** High-water anchor beside the ledger: a ledger that was truncated, replaced or removed after it was written is detected. */
  get anchorPath() { return `${this.path}.anchor.json`; }

  /** Records after verifying the chain, the init record and the anchor (throws BudgetError: fail closed). */
  verified() {
    let records;
    try { records = this.ledger.records(); } catch (error) { throw new BudgetError(`request budget ledger unreadable: ${error.message}`, "EBUDGETLEDGER"); }
    const chain = this.ledger.verify();
    if (chain.length) throw new BudgetError(`request budget ledger chain broken: ${chain.slice(0, 2).join("; ")}`, "EBUDGETLEDGER");
    let anchor = null;
    if (existsSync(this.anchorPath)) {
      try { anchor = JSON.parse(readFileSync(this.anchorPath, "utf8")); } catch (error) { throw new BudgetError(`request budget anchor unreadable: ${error.message}`, "EBUDGETLEDGER"); }
      if (!(Number.isInteger(anchor?.count) && anchor.count >= 1) || records.length < anchor.count || records[anchor.count - 1]?.hash !== anchor.lastHash || records[0]?.hash !== anchor.initHash) {
        throw new BudgetError(`request budget ledger is shorter than or differs from its anchor (${anchor?.count} records, last ${String(anchor?.lastHash).slice(0, 12)}): truncated, replaced or removed after it was written`, "EBUDGETLEDGER");
      }
    } else if (records.length && this.requireAnchor) {
      throw new BudgetError("request budget ledger has no anchor (the anchor is written with the init record; a missing anchor means the budget storage was tampered with)", "EBUDGETLEDGER");
    }
    if (records.length) {
      const init = records[0];
      if (init.type !== "init" || init.schema !== BUDGET_SCHEMA) throw new BudgetError("request budget ledger does not start with an init record", "EBUDGETLEDGER");
      if (init.limit !== this.limit) throw new BudgetError(`request budget ledger was created with limit ${init.limit}; this process asks for ${this.limit} (a ceiling is never changed by a later run)`, "EBUDGETLIMIT");
      if (init.scope !== this.scope) throw new BudgetError(`request budget ledger scope differs ("${init.scope}")`, "EBUDGETLIMIT");
      if (records.filter(r => r.type === "init").length !== 1) throw new BudgetError("request budget ledger has more than one init record", "EBUDGETLEDGER");
    }
    return records;
  }

  /** Append under the caller's lock and move the anchor forward (the anchor never moves back). */
  #append(record) {
    const entry = this.ledger.append(record);
    const all = this.ledger.records();
    try { atomicWriteJson(this.anchorPath, { schema: "pi-eval-loop/request-budget-anchor@1", count: all.length, lastHash: entry.hash, initHash: all[0].hash, at: entry.at }); }
    catch (error) { throw new BudgetError(`request budget anchor unwritable: ${error.message}`, "EBUDGETLEDGER"); }
    return entry;
  }

  /** Read-only status (no lock, no write). */
  status() {
    const records = this.verified(); // a missing ledger whose anchor exists is refused there
    const totals = budgetTotals(records);
    const init = records[0];
    const meters = this.meters.map(m => { try { return { name: m.name, count: init ? m.read(Date.parse(init.at)) : 0 }; } catch (error) { return { name: m.name, error: String(error?.message ?? error).slice(0, 200) }; } });
    return { schema: BUDGET_SCHEMA, path: this.path, scope: this.scope, createdAt: init?.at ?? null, ...totals, limit: this.limit, remaining: this.limit - totals.charged, meterMargin: this.meterMargin, meters };
  }

  async #locked(fn) {
    const deadline = this.now() + this.lockWaitMs;
    while (true) {
      let lock;
      try { lock = acquireLock(`${this.path}.lock`); } catch (error) {
        if (error instanceof LockBusyError && error.verdict?.state === "live" && this.now() < deadline) { await sleep(25 + Math.floor(Math.random() * 50)); continue; }
        throw new BudgetError(`request budget lock unavailable: ${error.message}`, "EBUDGETLOCK");
      }
      try { return fn(); } finally { lock.release(); }
    }
  }

  /**
   * Reserve `amount` requests (the attempt's worst case) before dispatch. Resolves { id, amount } or null when admitting it could
   * exceed the ceiling (this.refusal says why). Throws BudgetError when the accounting itself is unusable (fail closed: the caller
   * must halt, never run unmetered).
   * @param {number} amount @param {any} [meta]
   */
  async reserve(amount, meta = {}) {
    if (!(Number.isInteger(amount) && amount > 0)) throw new BudgetError(`request budget: reservation amount ${amount} is not a positive integer`, "EBUDGETCONFIG");
    return this.#locked(() => {
      const records = this.verified();
      if (!records.length) this.#append({ type: "init", schema: BUDGET_SCHEMA, limit: this.limit, scope: this.scope, pid: process.pid, meters: this.meters.map(m => m.name), meterMargin: this.meterMargin });
      const all = records.length ? records : this.verified();
      const totals = budgetTotals(all);
      if (totals.problems.length) throw new BudgetError(`request budget ledger inconsistent: ${totals.problems.slice(0, 2).join("; ")}`, "EBUDGETLEDGER");
      const since = Date.parse(all[0].at);
      const meterCounts = [];
      for (const m of this.meters) {
        let count;
        try { count = m.read(since); } catch (error) {
          if (m.required !== false) throw new BudgetError(`request budget: required meter ${m.name} unreadable: ${String(error?.message ?? error).slice(0, 200)}`, "EBUDGETMETER");
          continue;
        }
        if (!Number.isFinite(count)) { if (m.required !== false) throw new BudgetError(`request budget: meter ${m.name} returned ${count}`, "EBUDGETMETER"); continue; }
        meterCounts.push({ name: m.name, count });
      }
      // Meter-side headroom keeps `meterMargin` free: provider-side events appear only when a request completes, and the gateway
      // may retry upstream; the margin covers what in-flight requests can add before the watchdog halts (calibrate.mjs).
      const worstMeter = meterCounts.reduce((s, m) => Math.max(s, m.count + totals.openAmount), 0);
      if (totals.charged + amount > this.limit || (meterCounts.length && worstMeter + amount > this.limit - this.meterMargin)) {
        this.refusal = `request ceiling ${this.limit}: charged ${totals.charged} (open ${totals.openReservations} x worst case = ${totals.openAmount})${meterCounts.length ? `, meters ${meterCounts.map(m => `${m.name}=${m.count}`).join(", ")}` : ""}; reserving ${amount} more could exceed it`;
        return null;
      }
      const id = `r-${randomBytes(6).toString("hex")}`;
      this.#append({ type: "reserve", id, amount, pid: process.pid, chargedBefore: totals.charged, meters: meterCounts, meta });
      return { id, amount };
    });
  }

  /**
   * Settle a reservation with the observed request count (never more than once). The recorded `used` is raised to the attempt
   * floor when the gate admitted more outbound attempts than the other charges cover (attempts - (charged - amount)), so the
   * charged total never falls below the actual attempts; the floor never exceeds `amount` while the gate invariant holds.
   * @param {{ id: string }} ticket @param {number} used @param {any} [detail]
   */
  async settle(ticket, used, detail = {}) {
    if (!(Number.isInteger(used) && used >= 0)) throw new BudgetError(`request budget: settlement ${used} is not a count`, "EBUDGETCONFIG");
    return this.#locked(() => {
      const records = this.verified();
      const x = records.find(r => r.type === "reserve" && r.id === ticket.id);
      if (!x) throw new BudgetError(`request budget: unknown reservation ${ticket.id}`, "EBUDGETLEDGER");
      if (records.some(r => r.type === "settle" && r.id === ticket.id)) throw new BudgetError(`request budget: reservation ${ticket.id} already settled`, "EBUDGETLEDGER");
      const totals = budgetTotals(records);
      const floor = Math.max(0, totals.attempts - (totals.charged - x.amount));
      const final = Math.max(used, floor);
      this.#append({ type: "settle", id: ticket.id, used: final, reported: final !== used ? used : undefined, attemptFloor: totals.attempts ? floor : undefined, overrun: final > x.amount || undefined, detail });
      return { used: final, reported: used, floor };
    });
  }

  /**
   * Settle every open reservation whose owning process is provably gone (2026-11-07: a cycle killed mid-pass leaves its unit
   * reservations open; they would hold budget forever and make every later "no foreign open reservation" check wait). The owner
   * must be a pid that no longer exists on this host (a reused pid counts as alive: conservative, the reservation stays). Each is
   * settled at 0, which settle() raises to the attempt floor, so charged never falls below the actual attempts.
   * @returns {Promise<{ id: string, pid: number, used: number }[]>}
   */
  async reconcileDead(detail = {}) {
    const open = (() => { const recs = this.verified(); const settled = new Set(recs.filter(r => r.type === "settle").map(r => r.id)); return recs.filter(r => r.type === "reserve" && !settled.has(r.id)); })();
    const out = [];
    for (const r of open) {
      if (!Number.isInteger(r.pid) || r.pid === process.pid) continue;
      let alive = true; try { process.kill(r.pid, 0); } catch (error) { alive = error?.code === "EPERM"; }
      if (alive) continue;
      const s = await this.settle({ id: r.id }, 0, { ...detail, reconciled: `owner pid ${r.pid} is not running` }).catch(() => null);
      if (s) out.push({ id: r.id, pid: r.pid, used: s.used });
    }
    return out;
  }

  /**
   * Admit ONE outbound provider attempt (called by the attempt gate before it opens the upstream connection). Admitted iff the
   * attempts already admitted + 1 stay within the charged total (settled usage + open reservations, itself <= limit): no attempt
   * ever leaves without a covering reservation, across processes and restarts. Returns the attempt record or null (this.refusal).
   * Throws BudgetError when the accounting is unusable (the gate then refuses: fail closed).
   * @param {any} [meta]
   */
  async admitAttempt(meta = {}) {
    return this.#locked(() => {
      const records = this.verified();
      if (!records.length) { this.refusal = "no reservation exists (the budget ledger is not initialised)"; return null; }
      const totals = budgetTotals(records);
      if (totals.problems.length) throw new BudgetError(`request budget ledger inconsistent: ${totals.problems.slice(0, 2).join("; ")}`, "EBUDGETLEDGER");
      if (totals.attempts + 1 > totals.charged || totals.attempts + 1 > this.limit) {
        this.refusal = `outbound attempt refused: ${totals.attempts} attempts already cover the charged total ${totals.charged} (open reservations ${totals.openReservations}, limit ${this.limit})`;
        return null;
      }
      return this.#append({ type: "attempt", pid: process.pid, n: totals.attempts + 1, meta });
    });
  }
}

/**
 * Meter over the CLIProxyAPI gateway's usage database (read-only sqlite): events of `model` at or after `sinceMs`, failed and
 * canceled ones included (each is a request the gateway sent or tried to send upstream).
 * @param {{ db: string, model: string }} options
 */
export function gatewayUsageMeter({ db, model, required = true }) {
  return {
    name: `gateway-usage:${model}`,
    required,
    read(sinceMs) {
      if (!existsSync(db)) throw new Error(`gateway usage database not found: ${db}`);
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const h = new DatabaseSync(db, { readOnly: true, timeout: 10_000 });
      try { return Number(h.prepare("SELECT count(*) AS n FROM usage_events WHERE model = ? AND timestamp_ms >= ?").get(model, Math.floor(sinceMs)).n); }
      finally { h.close(); }
    },
  };
}

export const defaultBudgetPath = (privateStorage) => join(privateStorage, "budget", "target-model-requests.jsonl");

/**
 * Deterministic upper bound on the provider request ATTEMPTS one forwarded request can cause inside a CLIProxyAPI gateway
 * (2026-11-07; read-only over the gateway's config and auth directory). Basis (CLIProxyAPI v8.0.57 c2f402b4,
 * sdk/cliproxy/auth/conductor_execution.go executeStream / conductor_selection.go retryAllowedForRequest): without Home mode a
 * request runs in rounds 0..R where R = the largest effective request-retry of an eligible credential (global
 * routing.retry.request-retry unless a credential overrides it); each round tries every eligible credential at most once (its
 * attempted set; max-retry-credentials 0 = all, else at most that many); the codex executor itself has no retry loop. So
 *   attempts per forwarded request <= (R + 1) x C,   C = eligible credentials (enabled codex auths; with force-model-prefix
 *   only those without a prefix), capped by max-retry-credentials.
 * Anything that would make the bound unknowable REFUSES (throws): Home mode, codex API keys or OpenAI-compatible upstreams in the
 * config, a key that is not found exactly once uncommented, an unreadable auth file, a provider other than codex.
 * @param {{ config: string, model: string }} options
 */
export function gatewayAttemptBound({ config, model }) {
  const { readFileSync: read, readdirSync: list } = process.getBuiltinModule("node:fs");
  const { dirname, resolve: res } = process.getBuiltinModule("node:path");
  if (!/^gpt-/.test(String(model))) throw new BudgetError(`gateway attempt bound: only codex-served gpt-* models are supported (${model})`, "EBUDGETBOUND");
  const lines = read(config, "utf8").split("\n").map(l => l.replace(/\s+#.*$/, "")).filter(l => l.trim() && !/^\s*#/.test(l));
  const one = (re, name) => { const m = lines.map(l => l.match(re)).filter(Boolean); if (m.length !== 1) throw new BudgetError(`gateway attempt bound: ${name} found ${m.length} times uncommented (need exactly one)`, "EBUDGETBOUND"); return m[0][1]; };
  if (lines.some(l => /^home:/.test(l))) throw new BudgetError("gateway attempt bound: Home mode configured (different retry contract)", "EBUDGETBOUND");
  if (lines.some(l => /^\s*(codex-api-key|openai-compatibility|codex-api-keys):/.test(l))) throw new BudgetError("gateway attempt bound: API-key or OpenAI-compatible upstreams configured (more eligible credentials)", "EBUDGETBOUND");
  const retry = Number(one(/^\s+request-retry:\s*(-?\d+)\s*$/, "request-retry"));
  const maxCreds = Number(one(/^\s+max-retry-credentials:\s*(-?\d+)\s*$/, "max-retry-credentials"));
  const forcePrefix = one(/^\s+force-model-prefix:\s*(true|false)\s*$/, "force-model-prefix") === "true";
  const authDir = res(dirname(config), one(/^\s+auth-dir:\s*"?([^"]+?)"?\s*$/, "auth-dir"));
  let rounds = Math.max(0, retry) + 1, credentials = 0;
  for (const f of list(authDir).filter(n => n.endsWith(".json"))) {
    let a; try { a = JSON.parse(read(`${authDir}/${f}`, "utf8")); } catch (error) { throw new BudgetError(`gateway attempt bound: auth file ${f} unreadable`, "EBUDGETBOUND"); }
    if (a?.type !== "codex" || a.disabled === true) continue;
    if (forcePrefix && String(a.prefix ?? "").trim()) continue;
    credentials++;
    if (Number.isInteger(a["request-retry"]) && a["request-retry"] >= 0) rounds = Math.max(rounds, a["request-retry"] + 1);
  }
  if (!credentials) throw new BudgetError("gateway attempt bound: no eligible credential", "EBUDGETBOUND");
  const perRound = maxCreds > 0 ? Math.min(credentials, maxCreds) : credentials;
  return { perRequest: rounds * perRound, rounds, credentials, perRound, forcePrefix, basis: "CLIProxyAPI v8.0.57 c2f402b4 retry contract (non-Home): (request-retry+1) rounds x eligible credentials per round" };
}

/**
 * Peer-protection meter over the gateway usage database: failed events of `model` with a rate-limit/overload status (429, 503,
 * 529) at or after `sinceMs`. Not an accounting meter: it only tells the calibration to stop adding load.
 * @param {{ db: string, model: string }} options
 */
export function gatewayPressureMeter({ db, model }) {
  return {
    name: `gateway-pressure:${model}`,
    read(sinceMs) {
      if (!existsSync(db)) throw new Error(`gateway usage database not found: ${db}`);
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const h = new DatabaseSync(db, { readOnly: true, timeout: 10_000 });
      try { return Number(h.prepare("SELECT count(*) AS n FROM usage_events WHERE model = ? AND timestamp_ms >= ? AND failed = 1 AND failure_status IN (429, 503, 529)").get(model, Math.floor(sinceMs)).n); }
      finally { h.close(); }
    },
  };
}

/**
 * Identity of the gateway process that actually serves `port` (Linux /proc; read-only): pid, executable sha256, -config path.
 * `--help` of a file on disk proves nothing about the process the route talks to; this reads the running process.
 */
export function gatewayProcess(port) {
  const { execFileSync } = process.getBuiltinModule("node:child_process");
  const { readFileSync: read, readlinkSync } = process.getBuiltinModule("node:fs");
  const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8", timeout: 5000 });
  const pids = [...new Set([...out.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))];
  if (pids.length !== 1) throw new BudgetError(`gateway process: ${pids.length} listeners on port ${port}`, "EBUDGETBOUND");
  const pid = pids[0];
  const exe = readlinkSync(`/proc/${pid}/exe`);
  const argv = read(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  const i = argv.indexOf("-config");
  return { pid, exe, exeSha256: sha256(read(`/proc/${pid}/exe`)), config: i >= 0 ? argv[i + 1] : null, argv0: argv[0] };
}

/**
 * Isolation required for a deterministic attempt bound (2026-11-07): the bound is computed from the gateway's config and auth
 * directory, which a SHARED gateway hot-reloads at any time (another operator or tool may add a credential or raise
 * request-retry mid-attempt, after the reservation was sized). Only a gateway whose config lives in the study's private storage
 * (started for the study, used by nothing else) gives a bound that cannot change under a running attempt. Returns problems.
 * @param {{ process: { exeSha256: string, config: string | null }, verifiedExeSha256: string, privateRoot: string, configPath: string }} o
 */
export function gatewayIsolationProblems({ process: p, verifiedExeSha256, privateRoot, configPath }) {
  const { resolve: res } = process.getBuiltinModule("node:path");
  const out = [];
  if (p.exeSha256 !== verifiedExeSha256) out.push("the running gateway executable is not the build whose retry contract was verified");
  if (!p.config || res(p.config) !== res(configPath)) out.push(`the running gateway reads ${p.config ?? "an unknown config"}, not --gateway-config`);
  if (!res(configPath).startsWith(`${res(privateRoot)}/`)) out.push("the gateway is the shared live instance (its config is outside the study's private storage): its config and credentials can be hot-reloaded by others during an attempt, so the per-request attempt bound is not invariant, and its credential quota is shared with peer experiments");
  return out;
}
