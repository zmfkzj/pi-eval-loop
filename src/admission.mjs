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
 */
export function attemptAdmission(budget, bound) {
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
