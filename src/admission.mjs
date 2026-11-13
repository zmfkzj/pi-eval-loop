// Attempt admission over the durable global request budget (src/request-budget.mjs) and the peer-protection verdict.
// Moved from studies/confirmatory-1/calibrate.mjs (2026-11-07) so the recurring exploration route (src/explore-cycle.mjs) and the
// studies share ONE implementation; calibrate.mjs re-exports both unchanged.

/**
 * Admission that charges provider ATTEMPTS: each forwarded request counts `bound().perRequest` (the gateway's retry contract).
 * Reserve unit.maxRequests x K before dispatch; settle forwarded x K', K' = the bound re-read at settlement (a bound that grew
 * halts: the settlement is still recorded at the larger K, never lower). Without `bound` (model-free tests) K = 1.
 * Gated mode (bound().gated, the isolated runtime): every actual attempt is admitted by the outbound gate against the same ledger
 * (budget.admitAttempt), so K is only the reservation SIZE (room for gateway retries/redirects); the settlement records the
 * forwarded count and the ledger raises it to the attempt floor (RequestBudget.settle), never below the actual attempts. A
 * runtime check failing at settlement still settles (the floor keeps the count exact) and then halts.
 * Budget policy shared-total-only (2026-11-13): the former `options.subCap` group ceiling is removed; passing it throws.
 * @param {any} budget @param {any} [bound] @param {any} [options]
 */
export function attemptAdmission(budget, bound, options = {}) {
  if (options?.subCap !== undefined) throw new Error("attemptAdmission: subCap was removed (budget policy shared-total-only: the ledger ceiling is the only limit)");
  const k = () => (bound ? bound() : { perRequest: 1 });
  const admission = {
    changed: null,
    async reserve(amount, meta) {
      const b = k();
      const K = b.perRequest;
      const t = await budget.reserve(amount * K, { ...meta, perRequestAttempts: K, forwardCap: amount, gated: b.gated || undefined });
      return t && { ...t, K, gated: !!b.gated };
    },
    async settle(ticket, used, detail) {
      if (ticket.gated) {
        try { k(); } catch (error) { admission.changed = `isolated runtime check failed at settlement: ${String(error?.message ?? error).slice(0, 300)}`; }
        await budget.settle(ticket, used, { ...detail, gated: true, forwardedCounted: used });
        if (admission.changed) throw new Error(admission.changed);
        return;
      }
      let K2;
      try { K2 = k().perRequest; } catch (error) { K2 = Infinity; admission.changed = `gateway attempt bound unreadable at settlement: ${error.message}`; }
      const K = Number.isFinite(K2) ? Math.max(ticket.K, K2) : ticket.K * 1000;
      if (K2 !== ticket.K && !admission.changed) admission.changed = `gateway attempt bound changed from ${ticket.K} to ${K2} during an attempt`;
      await budget.settle(ticket, used * K, { ...detail, perRequestAttempts: K, forwardedCounted: used });
      if (admission.changed) throw new Error(admission.changed);
    },
    get refusal() { return budget.refusal; },
  };
  return admission;
}

/** Peer-protection verdict (pure): halt when the target model shows rate-limit/overload failures on the shared gateway. */
export function pressureVerdict({ failures, tolerance = 0 }) {
  return failures > tolerance ? { action: "halt", why: `the gateway shows ${failures} rate-limit/overload failure(s) of the target model: calibration load could push a peer experiment into failures` } : { action: "none" };
}

/**
 * OFF-GATE admission (2026-11-13; proposer and reviewer sessions, request-budget.mjs RETAINED_ROUTES). Their requests pass a route
 * proxy to a gateway, never the isolated runtime's outbound attempt gate, so the ledger cannot see upstream attempts directly.
 *   - With `bound` (() => { perRequest } from gatewayAttemptBound over the gateway's config and auth directory): the reservation is
 *     maxRequests x K and the settlement forwarded x max(K, K') (K' re-read at settlement); a bound that grew or became unreadable
 *     during the session charges the FULL reservation. Unit "upstream-attempt-bound": an upper bound on upstream attempts under the
 *     assumption that the gateway kept the configuration read at reservation and settlement (a mid-session hot reload between
 *     those reads is not observable here; gatewayIsolationProblems names the setups where it cannot happen).
 *   - Without `bound`: unit "proxy-forwarded" (requests the route proxy forwarded; gateway-internal retries are NOT counted and
 *     upstream attempts are unverifiable). `requireBound` refuses such a session (strict-total mode: fail closed).
 * A missing forwarded count or a failed session settles at the full reservation; a dead owner's reservation is settled at its
 * full amount by RequestBudget.reconcileDead. Off-gate charges count toward the one limit and never fund outbound attempts.
 * @param {any} budget @param {{ route: "proposal" | "review", bound?: (() => { perRequest: number }) | null, requireBound?: boolean }} options
 */
export function offGateAdmission(budget, { route, bound = null, requireBound = false }) {
  if (!["proposal", "review"].includes(route)) throw new Error(`off-gate admission: route ${route} is not an off-gate route`);
  return {
    unit: bound ? "upstream-attempt-bound" : "proxy-forwarded",
    async reserve(maxRequests, meta = {}) {
      if (!(Number.isInteger(maxRequests) && maxRequests > 0)) throw new Error(`off-gate admission: maxRequests ${maxRequests} is not a positive integer`);
      if (!bound && requireBound) { budget.refusal = `off-gate ${route}: no gateway attempt bound (strict total refuses proxy-forwarded accounting: upstream retries would be unmetered)`; return null; }
      let K = 1;
      if (bound) { try { K = bound().perRequest; } catch (error) { budget.refusal = `off-gate ${route}: gateway attempt bound unreadable (fail closed): ${String(error?.message ?? error).slice(0, 200)}`; return null; } }
      const t = await budget.reserve(maxRequests * K, { ...meta, route, unit: bound ? "upstream-attempt-bound" : "proxy-forwarded", perRequestAttempts: bound ? K : null, forwardCap: maxRequests });
      return t && { ...t, K };
    },
    async settle(ticket, forwarded, detail = {}) {
      if (!Number.isInteger(forwarded) || forwarded < 0) return budget.settle(ticket, ticket.amount, { ...detail, unit: "full reservation (forwarded count missing)" });
      if (!bound) return budget.settle(ticket, Math.min(ticket.amount, forwarded), { ...detail, unit: "proxy-forwarded", forwardedCounted: forwarded });
      let K2; try { K2 = bound().perRequest; } catch { K2 = null; }
      if (K2 === null || K2 > ticket.K) return budget.settle(ticket, ticket.amount, { ...detail, unit: "upstream-attempt-bound", forwardedCounted: forwarded, boundChanged: K2 === null ? "unreadable at settlement" : `${ticket.K} -> ${K2}` });
      return budget.settle(ticket, Math.min(ticket.amount, forwarded * ticket.K), { ...detail, unit: "upstream-attempt-bound", perRequestAttempts: ticket.K, forwardedCounted: forwarded });
    },
    get refusal() { return budget.refusal; },
  };
}
