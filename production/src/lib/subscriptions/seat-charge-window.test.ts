/**
 * R-801 — seatChargeWindow counts days to the EXCLUSIVE term end.
 *
 * Since 11 Sep 2026 renewal_date is the inclusive last covered day (1 Apr 2026 → 31 Mar 2027).
 * Counting straight to it made the year 364 days and never charged the last day:
 * 25 Sep 2026 gave 187/364 (₹851 on ₹1,656/yr) instead of 188/365 (₹853), and on the renewal
 * day itself nothing. Anniversary rows (1 Apr 2026 → 1 Apr 2027) were right and must stay so.
 */
import { describe, it, expect } from "vitest";
import { seatChargeWindow, seatTermEnd } from "./seat-charge-window";
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { assessRequest } from "./seat-request";
import { resolveTermDays } from "./apply-seat-increase";
import type { BillingCycle } from "@/lib/supabase/database.types";

const INCLUSIVE = {
  mrr: 138, // ₹1,656 / seat / year, 1 seat
  billing_cycle: "yearly" as BillingCycle,
  term_months: 12,
  start_date: "2026-04-01",
  renewal_date: "2027-03-31",
};
const ANNIVERSARY = { ...INCLUSIVE, renewal_date: "2027-04-01" };

const rupees = (remainingDays: number, termDays: number) =>
  Math.round(paiseToRupees(prorate({ annualPerSeatPaise: rupeesToPaise(1656), seats: 1, remainingDays, termDays, taxRatePct: 0 }).subtotalPaise));

describe("seatChargeWindow — inclusive-end row (renewal_date = last covered day)", () => {
  it("term start: 365 of 365 days — the full annual price", () => {
    const w = seatChargeWindow(INCLUSIVE, "2026-04-01")!;
    expect(w).toEqual({ remainingDays: 365, termDays: 365, chargeTo: "2027-03-31", instalmentPeriod: false });
    expect(rupees(w.remainingDays, w.termDays)).toBe(1656);
  });

  it("mid-term 25 Sep 2026: 188/365 = ₹853 (was 187/364 = ₹851)", () => {
    const w = seatChargeWindow(INCLUSIVE, "2026-09-25")!;
    expect([w.remainingDays, w.termDays, w.chargeTo]).toEqual([188, 365, "2027-03-31"]);
    expect(rupees(w.remainingDays, w.termDays)).toBe(853);
  });

  it("the renewal day itself is still covered: 1 day, not 0", () => {
    const w = seatChargeWindow(INCLUSIVE, "2027-03-31")!;
    expect([w.remainingDays, w.termDays, w.chargeTo]).toEqual([1, 365, "2027-03-31"]);
  });

  it("the day after renewal: term ended", () => {
    expect(seatChargeWindow(INCLUSIVE, "2027-04-01")!.remainingDays).toBe(0);
  });

  it("backdated effective date runs from that date to the exclusive end", () => {
    expect(seatChargeWindow(INCLUSIVE, "2026-10-10", "2026-09-25")!.remainingDays).toBe(188);
  });
});

describe("seatChargeWindow — anniversary row unchanged", () => {
  it("term start: 365/365, chargeTo the stored renewal date", () => {
    expect(seatChargeWindow(ANNIVERSARY, "2026-04-01")).toEqual({ remainingDays: 365, termDays: 365, chargeTo: "2027-04-01", instalmentPeriod: false });
  });
  it("25 Sep 2026: 188/365", () => {
    const w = seatChargeWindow(ANNIVERSARY, "2026-09-25")!;
    expect([w.remainingDays, w.termDays]).toEqual([188, 365]);
  });
  it("renewal day = next term's first day: ended", () => {
    expect(seatChargeWindow(ANNIVERSARY, "2027-04-01")!.remainingDays).toBe(0);
  });
});

describe("seatChargeWindow — split-billed", () => {
  it("anniversary quarterly: period logic and numbers unchanged", () => {
    const w = seatChargeWindow({ ...ANNIVERSARY, billing_cycle: "quarterly" }, "2026-09-25")!;
    expect(w).toEqual({ remainingDays: 6, termDays: 365, chargeTo: "2026-09-30", instalmentPeriod: true });
  });
  it("inclusive quarterly: same quarter, and the term is 365 days (was 364)", () => {
    const w = seatChargeWindow({ ...INCLUSIVE, billing_cycle: "quarterly" }, "2026-09-25")!;
    expect(w).toEqual({ remainingDays: 6, termDays: 365, chargeTo: "2026-09-30", instalmentPeriod: true });
  });
  it("inclusive quarterly: the last quarter ends on the renewal day", () => {
    const w = seatChargeWindow({ ...INCLUSIVE, billing_cycle: "quarterly" }, "2027-03-31")!;
    expect(w).toEqual({ remainingDays: 1, termDays: 365, chargeTo: "2027-03-31", instalmentPeriod: true });
  });
});

describe("seatTermEnd / resolveTermDays — the server agrees with the preview", () => {
  it("exclusive end for both row shapes", () => {
    expect(seatTermEnd(INCLUSIVE)).toBe("2027-04-01");
    expect(seatTermEnd(ANNIVERSARY)).toBe("2027-04-01");
    expect(seatTermEnd({ ...INCLUSIVE, renewal_date: null })).toBeNull();
  });
  it("resolveTermDays = seatChargeWindow.termDays", () => {
    expect(resolveTermDays(INCLUSIVE)).toBe(365);
    expect(resolveTermDays(ANNIVERSARY)).toBe(365);
    expect(resolveTermDays({ ...INCLUSIVE, start_date: null })).toBe(365);
  });
});

describe("assessRequest — renewal day of an inclusive row is still in the term", () => {
  const base = {
    status: "pending" as const, currentSeats: 1, requestedSeats: 2, liveSeats: 1,
    subscriptionStatus: "active" as const, renewalDate: INCLUSIVE.renewal_date,
  };
  it("inclusive row on its renewal day can be approved", () => {
    expect(assessRequest({ ...base, termEnd: seatTermEnd(INCLUSIVE), today: "2027-03-31" }).canApprove).toBe(true);
    expect(assessRequest({ ...base, termEnd: seatTermEnd(INCLUSIVE), today: "2027-04-01" }).canApprove).toBe(false);
  });
  it("anniversary row on its renewal day is ended (unchanged)", () => {
    expect(assessRequest({ ...base, renewalDate: ANNIVERSARY.renewal_date, termEnd: seatTermEnd(ANNIVERSARY), today: "2027-04-01" }).canApprove).toBe(false);
  });
});

/* ── addSeats() with the exclusive term end ─────────────────────────────── */

function fakeSupabase(quotes: Record<string, unknown>[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  });
  return {
    from: (name: string) => table(name),
    rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

function run(over: Partial<AddSeatsInput>) {
  const quotes: Record<string, unknown>[] = [];
  const p = addSeats({
    supabase: fakeSupabase(quotes),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "Test Co",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "test.in",
    currentSeats: 1, currentMrr: 138, additionalSeats: 1,
    renewalDate: INCLUSIVE.renewal_date, termEnd: seatTermEnd(INCLUSIVE), graceDays: 7,
    taxRatePct: 0, termDays: resolveTermDays(INCLUSIVE),
    todayISO: "2026-09-25",
    ...over,
  });
  return { p, quotes };
}

describe("addSeats — inclusive-end row", () => {
  it("25 Sep 2026: 188 of 365 days, ₹853, line runs to the inclusive renewal date", async () => {
    const { p, quotes } = run({});
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proRataDays).toBe(188);
    expect(Math.round(Number(quotes[0].subtotal))).toBe(853);
    const line = (quotes[0].line_items as { name: string }[])[0];
    expect(line.name).toContain("pro-rata from 2026-09-25 to 2027-03-31");
    expect(String(quotes[0].notes)).toContain("188 of 365 days");
  });

  it("renewal day: 1 day charged, not refused as term ended", async () => {
    const r = await run({ todayISO: "2027-03-31" }).p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proRataDays).toBe(1);
  });

  it("day after renewal: term ended", async () => {
    const r = await run({ todayISO: "2027-04-01" }).p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("term_ended");
  });

  it("without termEnd (old callers) the renewal date is read as before", async () => {
    const r = await run({ termEnd: undefined, termDays: 364 }).p;
    expect(r.ok && r.proRataDays).toBe(187);
  });
});
