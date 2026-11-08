// ctrl-confirm-4 execution resource management (experiment-local; src/ is not changed, so the evaluator digests of concurrent
// experiments stay intact). Durable, append-only, hash-chained resource ledger `resources.jsonl` in the state directory:
//
//   campaign-start  first launch ever: elapsed-wall deadline fixed once (never reset by a resume)
//   session-start / session-end / heartbeat   one runner invocation (pid, host); heartbeats every heartbeatMs while units run
//   active-start / active-end                 an interval with >= 1 attempt in flight (ACTIVE time; paused/idle time excluded)
//   reserve        BEFORE an attempt is dispatched: its worst-case requests/tokens/API-equivalent cost and its time bound
//   settle         after the attempt: actual usage (record, wire journal, or a conservative charge) releases the reservation
//   pause / resume dispatch stopped (cap, provider failure, route violation, operator) / continued
//
// Admission is synchronous (check + reserve without an await in between), so concurrent workers of one process cannot overshoot;
// a second process is excluded by RunnerLock. A crashed session leaves an open active interval and open reservations: the next
// session closes the interval at min(last heartbeat + heartbeatMs, now) (bounded, never the whole downtime, never less than the
// evidence) and settles every open reservation from the evaluator ledger / wire journals, or charges the full reservation when no
// evidence survives (never zero by default). Nothing here decides an outcome.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { digestOf, ensureDir } from "../../src/util.mjs";

const ZERO = () => ({ requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 });
const add = (a, b, sign = 1) => { for (const k of Object.keys(ZERO())) a[k] += sign * (b?.[k] ?? 0); return a; };

/** API-equivalent cost (USD) of a usage vector; input includes cached and cache-write tokens (wire/record semantics). */
export function costOf(u, pricing) {
  const uncached = Math.max(0, (u.input ?? 0) - (u.cached ?? 0) - (u.cacheWrite ?? 0));
  return (uncached * pricing.inputPerM + (u.cached ?? 0) * pricing.cachedInputPerM + (u.cacheWrite ?? 0) * pricing.cacheWritePerM + (u.output ?? 0) * pricing.outputPerM) / 1e6;
}

/** Append-only hash-chained JSONL with an in-memory tail (single writer guaranteed by RunnerLock). */
export class ChainLedger {
  constructor(path) {
    this.path = path; ensureDir(join(path, ".."));
    this.cache = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${path}: corrupt line ${i + 1}`); } }) : [];
  }
  records() { return this.cache; }
  append(record) {
    const prev = this.cache.at(-1)?.hash ?? "genesis";
    const body = { ...record, seq: this.cache.length, at: record.at ?? new Date().toISOString(), prev };
    const entry = { ...body, hash: digestOf(body) };
    const fd = openSync(this.path, "a", 0o600);
    try { writeSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    this.cache.push(entry);
    return entry;
  }
  verify() {
    const problems = []; let prev = "genesis";
    this.cache.forEach((e, i) => { const { hash, ...body } = e; if (e.seq !== i) problems.push(`record ${i}: seq`); if (e.prev !== prev) problems.push(`record ${i}: chain broken`); if (digestOf(body) !== hash) problems.push(`record ${i}: hash mismatch`); prev = hash; });
    return problems;
  }
}

export class DuplicateRunnerError extends Error {}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/**
 * Exclusive runner lock (O_EXCL create). A lock whose pid is dead on this host is moved aside atomically (rename; the loser of a
 * concurrent takeover sees ENOENT and retries the exclusive create) and kept as evidence. A live pid refuses: no duplicate runner.
 */
export class RunnerLock {
  /** @type {string} */ path = "";
  /** @type {string} */ token = "";
  /** @type {number} */ pid = 0;
  /** @type {any} */ takeover = null;
  static acquire(stateDir, { pid = process.pid, isAlive = alive, now = Date.now } = {}) {
    const path = join(ensureDir(stateDir), "runner.lock");
    const token = `${pid}-${now()}-${Math.random().toString(36).slice(2)}`;
    let takeover = null;
    for (let i = 0; i < 5; i++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try { writeSync(fd, JSON.stringify({ pid, host: hostname(), token, at: new Date(now()).toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
        return Object.assign(new RunnerLock(), { path, token, pid, takeover });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let held; try { held = JSON.parse(readFileSync(path, "utf8")); } catch { held = null; }
        if (held && held.host === hostname() && isAlive(held.pid)) throw new DuplicateRunnerError(`another runner (pid ${held.pid}, since ${held.at}) holds ${path}`);
        if (held && held.host !== hostname()) throw new DuplicateRunnerError(`runner lock held by host ${held.host}; refusing to judge its liveness`);
        const aside = `${path}.stale-${now()}-${held?.pid ?? "unknown"}`;
        try { renameSync(path, aside); takeover = { stale: held, keptAt: aside }; } catch (r) { if (r.code !== "ENOENT") throw r; }
      }
    }
    throw new DuplicateRunnerError(`could not acquire ${path}`);
  }
  release() { try { const held = JSON.parse(readFileSync(this.path, "utf8")); if (held.token === this.token) renameSync(this.path, `${this.path}.released-${Date.now()}`); } catch { /* already gone */ } }
}

/** Processes whose command line contains `needle` (orphans of a crashed runner: sandboxes, proxies), excluding this process. */
export function processesWith(needle, { procDir = "/proc" } = {}) {
  const out = [];
  for (const d of readdirSync(procDir)) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try { const cmd = readFileSync(join(procDir, d, "cmdline"), "utf8").replace(/\0/g, " "); if (cmd.includes(needle)) out.push({ pid: Number(d), cmd: cmd.slice(0, 300) }); } catch { /* gone */ }
  }
  return out;
}

/** Stop surviving processes of an interrupted attempt (SIGTERM, then SIGKILL after graceMs). Returns what was found. */
export async function stopOrphans(needle, { graceMs = 5000, find = processesWith, kill = process.kill.bind(process), sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const found = find(needle);
  for (const p of found) { try { kill(p.pid, "SIGTERM"); } catch { /* gone */ } }
  if (found.length) { await sleep(graceMs); for (const p of find(needle)) { try { kill(p.pid, "SIGKILL"); } catch { /* gone */ } } }
  return found;
}

/** Provider-side failure class from an attempt record (outcome-independent signals only): credit | auth | rate | null. */
export function providerFailure(record) {
  const t = `${record?.terminal_status ?? ""} ${record?.terminal_detail ?? ""}`;
  if (!/model_error|infra_error|model_unavailable|aborted|agent_error/.test(record?.terminal_status ?? "")) return null;
  if (/credit_balance_exhausted|no credits remaining|insufficient_quota|billing|payment required|\b402\b/i.test(t)) return "credit";
  if (/auth_unavailable|unauthori[sz]ed|invalid api key|\b401\b|\b403\b/i.test(t)) return "auth";
  if (/rate.?limit|too many requests|\b429\b/i.test(t)) return "rate";
  return null;
}

/** Usage of an attempt from wire journal entries: completed responses' usage + a conservative charge per request without usage. */
export function wireUsage(entries, { unknownRequest, pricing }) {
  const u = ZERO();
  const posts = entries.filter(e => e.method === "POST");
  const starts = posts.filter(e => e.phase === "start").length;
  const ends = posts.filter(e => e.phase === "end");
  let unknown = Math.max(0, starts - ends.length);
  for (const e of ends) {
    if (e.usage) { u.input += e.usage.input ?? 0; u.cached += e.usage.cached ?? 0; u.cacheWrite += e.usage.cacheWrite ?? 0; u.output += e.usage.output ?? 0; }
    else if (e.status === 200) unknown++;
  }
  u.requests = Math.max(starts, ends.length);
  u.input += unknown * unknownRequest.input; u.output += unknown * unknownRequest.output;
  u.costUsd = costOf(u, pricing);
  return { usage: u, unknownUsageRequests: unknown };
}

/** Usage of a finished attempt from its evaluator record (requests charged = forwarded, >= completed). */
export function recordUsage(r, pricing) {
  const u = { requests: Math.max(r.model_requests ?? 0, r.model_requests_completed ?? 0), input: r.input_tokens ?? 0, cached: r.cache_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0, output: r.output_tokens ?? 0, costUsd: 0 };
  u.costUsd = costOf(u, pricing);
  return u;
}

export class ResourceManager {
  /**
   * @param {{ stateDir: string, budget: any, reserve: any, pricing: any, attemptTimeBoundMs: number, heartbeatMs?: number, overrunSlots?: number, now?: () => number }} o
   * budget: { maxRequestsTotal, maxInputTokens, maxOutputTokens, maxCostUsdApiEquivalent, maxActiveHours, maxCampaignWallHours }
   * reserve: per attempt { requests, input, output } (cost = all reserved input priced at the HIGHER of the uncached and the
   *   cache-write price + output, so a cache-write-heavy attempt is not under-reserved)
   * overrunSlots: pre-launch hardening A2 (outcome-independent): token and cost admission keep an extra headroom of
   *   overrunSlots x the per-attempt reservation below each token/cost ceiling, because the proxy enforces only the per-attempt
   *   REQUEST ceiling (tokens are measured, not capped, per attempt). With overrunSlots = parallelism, every attempt in flight at
   *   the end may use up to twice its token reservation before a ceiling can be crossed. Requests need no headroom (hard proxy cap).
   */
  constructor({ stateDir, budget, reserve, pricing, attemptTimeBoundMs, heartbeatMs = 60_000, overrunSlots = 0, now = Date.now }) {
    /** @type {string} */ this.stateDir = stateDir;
    /** @type {any} */ this.budget = budget;
    /** @type {any} */ this.pricing = pricing;
    /** @type {number} */ this.attemptTimeBoundMs = attemptTimeBoundMs;
    /** @type {number} */ this.heartbeatMs = heartbeatMs;
    /** @type {number} */ this.overrunSlots = overrunSlots;
    /** @type {() => number} */ this.now = now;
    /** @type {number} */ this.inFlight = 0;
    /** @type {any} */ this.timer = null;
    this.reserveVec = { ...ZERO(), requests: reserve.requests, input: reserve.input, output: reserve.output };
    this.reserveVec.costUsd = (reserve.input * Math.max(pricing.inputPerM, pricing.cacheWritePerM ?? 0) + reserve.output * pricing.outputPerM) / 1e6;
    this.ledger = new ChainLedger(join(stateDir, "resources.jsonl"));
    const chain = this.ledger.verify();
    if (chain.length) throw new Error(`resource ledger damaged: ${chain.join("; ")}`);
    this.paused = null; this.session = null; this.timer = null;
  }

  /** Append with the manager clock (tests inject a clock; production uses Date.now). */
  log(record) { return this.ledger.append({ ...record, at: record.at ?? new Date(this.now()).toISOString() }); }

  /** Replay: consumed (settled), open reservations, active ms of closed intervals, open interval, last heartbeat, unresolved pause. */
  state() {
    const consumed = ZERO(), open = new Map(); let activeMs = 0, openSince = null, lastBeat = null, campaign = null, sessions = 0, pause = null;
    for (const e of this.ledger.records()) {
      const t = Date.parse(e.at);
      if (e.type === "campaign-start") campaign = e;
      else if (e.type === "session-start") sessions++;
      else if (e.type === "reserve") open.set(e.attemptId, e);
      else if (e.type === "settle") { add(consumed, e.usage); open.delete(e.attemptId); }
      else if (e.type === "active-start") { openSince = t; lastBeat = t; }
      else if (e.type === "heartbeat") lastBeat = t;
      else if (e.type === "active-end") { if (openSince !== null) activeMs += Math.max(0, Date.parse(e.endAt ?? e.at) - openSince); openSince = null; }
      else if (e.type === "pause") pause = { reason: e.reason, kind: e.kind, at: e.at, seq: e.seq };
      else if (e.type === "resume") pause = null;
    }
    const reserved = ZERO(); for (const r of open.values()) add(reserved, r.amount);
    return { consumed, reserved, open, activeMs, openSince, lastBeat, campaign, sessions, pause };
  }

  activeMsNow() { const s = this.state(); return s.activeMs + (s.openSince !== null ? this.now() - s.openSince : 0); }

  /** Start a runner session: close a crashed session's active interval (bounded), fix the campaign deadline on the first launch. */
  startSession({ pid = process.pid, command = "" } = {}) {
    const s = this.state();
    if (s.openSince !== null) {
      const endAt = Math.min(this.now(), (s.lastBeat ?? s.openSince) + this.heartbeatMs);
      this.log({ type: "active-end", endAt: new Date(endAt).toISOString(), reason: "previous session ended without closing its active interval (crash): closed at last heartbeat + heartbeat interval" });
    }
    if (!s.campaign) this.log({ type: "campaign-start", wallDeadline: new Date(this.now() + this.budget.maxCampaignWallHours * 3600_000).toISOString(), budget: this.budget, reserve: this.reserveVec, pricing: this.pricing, attemptTimeBoundMs: this.attemptTimeBoundMs });
    this.session = this.log({ type: "session-start", pid, host: hostname(), command }).seq;
    this.inFlight = 0;
    return this.state();
  }

  /** Synchronous admission decision for one more attempt (null = admitted, else the reason; the caller pauses on a reason). */
  refusal() {
    if (this.paused) return this.paused.reason;
    const s = this.state(), b = this.budget, r = this.reserveVec, after = (k) => s.consumed[k] + s.reserved[k] + r[k];
    const headroom = (k) => this.overrunSlots * r[k];
    if (after("requests") > b.maxRequestsTotal) return `aggregate request ceiling ${b.maxRequestsTotal} (consumed ${s.consumed.requests} + reserved ${s.reserved.requests} + ${r.requests})`;
    if (after("input") + headroom("input") > b.maxInputTokens) return `input-token ceiling ${b.maxInputTokens} (incl. overrun headroom ${headroom("input")})`;
    if (after("output") + headroom("output") > b.maxOutputTokens) return `output-token ceiling ${b.maxOutputTokens} (incl. overrun headroom ${headroom("output")})`;
    if (after("costUsd") + headroom("costUsd") > b.maxCostUsdApiEquivalent) return `API-equivalent cost ceiling $${b.maxCostUsdApiEquivalent} (incl. overrun headroom $${headroom("costUsd").toFixed(2)})`;
    const active = s.activeMs + (s.openSince !== null ? this.now() - s.openSince : 0);
    if (active + this.attemptTimeBoundMs > b.maxActiveHours * 3600_000) return `active-time ceiling ${b.maxActiveHours} h (an attempt may take ${Math.round(this.attemptTimeBoundMs / 60000)} min)`;
    if (s.campaign && this.now() + this.attemptTimeBoundMs > Date.parse(s.campaign.wallDeadline)) return `campaign elapsed-wall deadline ${s.campaign.wallDeadline}`;
    return null;
  }

  /** Admit and reserve atomically (no await). Returns the reservation entry or null (refused: dispatch must not happen). */
  reserve(attemptId, info = {}) {
    const why = this.refusal();
    if (why) { if (!this.paused) this.pause(why, "cap"); return null; }
    if (this.state().open.has(attemptId)) throw new Error(`attempt ${attemptId} already reserved (double dispatch refused)`);
    if (this.inFlight === 0) this.log({ type: "active-start" });
    this.inFlight++;
    this.ensureHeartbeat();
    return this.log({ type: "reserve", attemptId, ...info, amount: this.reserveVec, session: this.session });
  }

  /** Settle an attempt's reservation with its actual (or conservative) usage; idempotent per attempt. */
  settle(attemptId, usage, source, extra = {}) {
    const s = this.state();
    if (!s.open.has(attemptId)) return null;
    const own = s.open.get(attemptId).session === this.session;
    const e = this.log({ type: "settle", attemptId, usage, source, ...extra });
    if (own) { this.inFlight = Math.max(0, this.inFlight - 1); if (this.inFlight === 0) { this.log({ type: "active-end" }); this.stopHeartbeat(); } }
    return e;
  }

  pause(reason, kind) { this.paused = { reason, kind }; this.log({ type: "pause", reason, kind }); }
  resume(reason) { this.paused = null; this.log({ type: "resume", reason }); }

  ensureHeartbeat() { if (!this.timer && this.heartbeatMs > 0) { this.timer = setInterval(() => { if (this.inFlight > 0) this.log({ type: "heartbeat", inFlight: this.inFlight }); }, this.heartbeatMs); /** @type {any} */ (this.timer).unref?.(); } }
  stopHeartbeat() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  endSession(reason) {
    this.stopHeartbeat();
    const s = this.state();
    if (s.openSince !== null && this.inFlight === 0) this.log({ type: "active-end" });
    this.log({ type: "session-end", reason, session: this.session });
  }

  /** Planned vs reserved vs consumed, ceilings and the remaining margin (for campaign.json and reports). */
  snapshot(planned = null) {
    const s = this.state();
    return { planned, consumed: s.consumed, reserved: s.reserved, openReservations: s.open.size, activeHours: Math.round(this.activeMsNow() / 36_000) / 100, wallDeadline: s.campaign?.wallDeadline ?? null, budget: this.budget, paused: this.paused, sessions: s.sessions };
  }
}
