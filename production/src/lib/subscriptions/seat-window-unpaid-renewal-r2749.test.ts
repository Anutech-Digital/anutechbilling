/**
 * R-2749 (14 Nov 2026) — seat add timing while a renewal part is billed but NOT paid.
 *
 * Since R-2735 a subscription billed in parts keeps its OLD renewal_date until the new term's first part is
 * paid. The R-2735 review asked: do add-seats / seat-cut read the right term meanwhile? Proved here:
 *
 *  1. Before the old term ends (Bill next part pressed early): the charge runs only to the end of the CURRENT
 *     part (old term) — never the whole new term, which is not paid. (Before R-2735 the date was already
 *     rolled at billing, so the window read the unpaid new term.)
 *  2. After the old term ended, renewal still unpaid: add-seats refuses ("Term has ended") and writes nothing —
 *     no seat is charged against a term the customer has not paid for. Seats are added once the renewal
 *     part is paid (the date then moves, R-2735).
 *  3. The same sub once the part is paid (renewal_date moved one term): the window is the new term's current
 *     part again.
 * Seat CUT timing: reduce-seats treats a renewal date that has passed and is unpaid as the grace days of that
 * renewal (route.ts `from = renewal_date < today ? renewal_date : today`) — the scheduled cut still belongs
 * to the unpaid renewal, which is right while renewal_date has not moved. Not changed by this card.
 */
import { describe, it, expect } from "vitest";
import { seatChargeWindow, seatTermEnd } from "./seat-charge-window";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { resolveTermDays } from "./apply-seat-increase";
import type { BillingCycle } from "@/lib/supabase/database.types";

/* Quarterly, annual term 1 Oct 2025 – 30 Sep 2026 (inclusive renewal_date). */
const OLD_TERM = {
  mrr: 333,
  billing_cycle: "quarterly" as BillingCycle,
  term_months: 12,
  start_date: "2025-10-01",
  renewal_date: "2026-09-30",
};
const PAID = { ...OLD_TERM, renewal_date: "2027-09-30" };

function fakeSupabase(writes: string[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: () => { writes.push(`insert ${name}`); return Promise.resolve({ error: null }); },
    update: () => { writes.push(`update ${name}`); return { eq: () => Promise.resolve({ error: null }) }; },
  });
  return {
    from: (name: string) => table(name),
    rpc: () => { writes.push("rpc"); return Promise.resolve({ data: "Q-TEST-0001", error: null }); },
  } as unknown as AddSeatsInput["supabase"];
}

describe("R-2749 seat add while a renewal part is unpaid", () => {
  it("before the old term ends: charged to the end of the current (old-term) part only", () => {
    const w = seatChargeWindow(OLD_TERM, "2026-09-20")!;
    expect(w.instalmentPeriod).toBe(true);
    expect(w.chargeTo).toBe("2026-09-30");
    expect(w.remainingDays).toBe(11);   // 20–30 Sep, not a day of the unpaid new term
  });

  it("old term ended, renewal part unpaid: add-seats refuses and writes nothing", async () => {
    const w = seatChargeWindow(OLD_TERM, "2026-10-10")!;
    expect(w.remainingDays).toBeLessThanOrEqual(0);
    const writes: string[] = [];
    const r = await addSeats({
      supabase: fakeSupabase(writes),
      subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "Test Co",
      plan: "Google Workspace Business Starter", vendor: "google", domain: "test.in",
      currentSeats: 1, currentMrr: 333, additionalSeats: 1,
      renewalDate: OLD_TERM.renewal_date, termEnd: seatTermEnd(OLD_TERM), graceDays: 7,
      taxRatePct: 0, termDays: resolveTermDays(OLD_TERM), chargeWindow: { ...w, parts: null },
      todayISO: "2026-10-10",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("term_ended");
    expect(writes).toEqual([]);
  });

  it("once the renewal part is paid (date moved a term): the new term's current part is charged", () => {
    const w = seatChargeWindow(PAID, "2026-10-10")!;
    expect(w.instalmentPeriod).toBe(true);
    expect(w.chargeTo).toBe("2026-12-31");
    expect(w.remainingDays).toBe(83);   // 10 Oct – 31 Dec
  });
});
