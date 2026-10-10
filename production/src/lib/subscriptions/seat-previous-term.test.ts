/**
 * R-543 — Add seats with an Effective date in the PREVIOUS term (Abhishek, staging, 10 Oct 2026:
 * "a seat added last month can't be backdated" once the subscription had renewed).
 *
 * A previous-term date gives ONE quote with TWO lines:
 *   1. the rest of the previous term, pro-rata over that term's own length;
 *   2. the whole current term from its start — what a current-term-start date already charged.
 * Same annual per seat, same paise engine, same GST. Renewal date untouched.
 *
 * Subscription: sold 15 Sep 2023, renewed twice; current term 15 Sep 2025 → 14 Sep 2026,
 * previous term 15 Sep 2024 → 14 Sep 2025 (365 days). ₹270/mo for 1 seat = ₹3,240/seat/yr.
 */
import { describe, it, expect } from "vitest";
import { checkSeatEffectiveDate, seatEffectiveBounds } from "./seat-effective-date";
import { seatChargePlan, seatChargeWindow } from "./seat-charge-window";
import { seatIncreaseQuote, seatIncreaseCharge } from "./seat-increase-charge";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { previousTermStart } from "@/lib/billing/subscription-schedule";
import type { BillingCycle } from "@/lib/supabase/database.types";

const TODAY = "2026-06-01";
const SUB = {
  mrr: 270, seats: 1, billing_cycle: "yearly" as BillingCycle, term_months: 12,
  start_date: "2023-09-15", renewal_date: "2026-09-14",
};

describe("limits", () => {
  it("min = previous term start when the subscription existed then", () => {
    expect(previousTermStart(SUB)).toBe("2024-09-15");
    expect(seatEffectiveBounds(SUB, TODAY)).toEqual({ min: "2024-09-15", max: TODAY });
    expect(checkSeatEffectiveDate("2024-09-15", SUB, TODAY)).toEqual({ ok: true, date: "2024-09-15", backdated: true });
    const r = checkSeatEffectiveDate("2024-09-14", SUB, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/before the previous term started/);
  });

  it("never before the subscription's own start date", () => {
    const sub = { ...SUB, start_date: "2025-06-01" };
    expect(seatEffectiveBounds(sub, TODAY)!.min).toBe("2025-06-01");
    const r = checkSeatEffectiveDate("2025-05-31", sub, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/before this subscription started/);
  });

  it("first term (sold at the current term start): unchanged — no previous term", () => {
    const sub = { ...SUB, start_date: "2026-04-01", renewal_date: "2027-03-31" };
    expect(seatEffectiveBounds(sub, "2026-10-10")!.min).toBe("2026-04-01");
    const r = checkSeatEffectiveDate("2026-03-31", sub, "2026-10-10");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/before this term started/);
  });

  it("no start_date: can't prove it existed, so the current term start stays the limit", () => {
    expect(seatEffectiveBounds({ ...SUB, start_date: null }, TODAY)!.min).toBe("2025-09-15");
  });

  it("future still refused", () => {
    const r = checkSeatEffectiveDate("2026-06-02", SUB, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/future/);
  });
});

describe("seatChargePlan", () => {
  it("previous-term date: 45 of 365 days of the previous term + the whole current term", () => {
    const plan = seatChargePlan(SUB, TODAY, "2025-08-01")!;
    expect(plan.previous).toEqual({ from: "2025-08-01", to: "2025-09-14", remainingDays: 45, termDays: 365 });
    expect(plan.current).toEqual({ ...seatChargeWindow(SUB, TODAY, "2025-09-15")!, from: "2025-09-15" });
    expect([plan.current.remainingDays, plan.current.termDays, plan.current.chargeTo]).toEqual([365, 365, "2026-09-14"]);
  });

  it("current-term date: no previous part, exactly seatChargeWindow as before", () => {
    for (const d of ["2025-09-15", "2026-01-10", TODAY]) {
      const plan = seatChargePlan(SUB, TODAY, d)!;
      expect(plan.previous).toBeNull();
      expect(plan.current).toEqual({ ...seatChargeWindow(SUB, TODAY, d)!, from: d });
    }
  });

  it("the day before the current term: 1 day of the previous term", () => {
    expect(seatChargePlan(SUB, TODAY, "2025-09-14")!.previous!.remainingDays).toBe(1);
  });

  it("quarterly: the current part runs from the term start to the current instalment end", () => {
    const q = { ...SUB, billing_cycle: "quarterly" as BillingCycle };
    const plan = seatChargePlan(q, TODAY, "2025-08-01")!;
    expect(plan.previous!.remainingDays).toBe(45);
    expect(plan.current.instalmentPeriod).toBe(true);
    expect(plan.current.chargeTo).toBe("2026-06-14");
    expect(plan.current.remainingDays).toBe(273); // 15 Sep 2025 → 15 Jun 2026
  });
});

describe("seatIncreaseQuote", () => {
  it("+2 seats from 1 Aug 2025: ₹799 + ₹6,480 → subtotal ₹7,279, total ₹8,589", () => {
    const q = seatIncreaseQuote({
      currentSeats: 1, currentMrr: 270, additionalSeats: 2, taxRatePct: 18,
      previous: { remainingDays: 45, termDays: 365 }, current: { remainingDays: 365, termDays: 365 },
    });
    // 324000 × 2 × 45 / 365 = 79890.4 → 79890 paise; GST 14380 → 94270
    expect(q.previous!.proration.subtotalPaise).toBe(79890);
    expect(q.previous!.proration.totalPaise).toBe(94270);
    expect(q.previous!.subtotal).toBe(799);
    // whole current term: 648000 paise; GST 116640 → 764640
    expect(q.current.subtotal).toBe(6480);
    expect(q.current.total).toBe(7646);
    // parts added in paise, rounded once: 727890 → ₹7,279; 858910 → ₹8,589
    expect(q.subtotal).toBe(7279);
    expect(q.total).toBe(8589);
    expect(q.tax).toBe(1310);
    expect(q.newMrr).toBe(810);
  });

  it("no previous part = seatIncreaseCharge, unchanged", () => {
    const one = seatIncreaseCharge({ currentSeats: 10, currentMrr: 2700, additionalSeats: 2, remainingDays: 188, termDays: 365, taxRatePct: 18 });
    const q = seatIncreaseQuote({
      currentSeats: 10, currentMrr: 2700, additionalSeats: 2, taxRatePct: 18,
      current: { remainingDays: 188, termDays: 365 },
    });
    expect(q.previous).toBeNull();
    expect([q.subtotal, q.tax, q.total, q.newMrr]).toEqual([one.subtotal, one.tax, one.total, one.newMrr]);
  });

  it("export: zero GST on both lines", () => {
    const q = seatIncreaseQuote({
      currentSeats: 1, currentMrr: 270, additionalSeats: 2, taxRatePct: 0,
      previous: { remainingDays: 45, termDays: 365 }, current: { remainingDays: 365, termDays: 365 },
    });
    expect(q.tax).toBe(0);
    expect(q.total).toBe(q.subtotal);
  });
});

/* ── addSeats() writes the two lines ──────────────────────────────────────── */

function fakeSupabase(quotes: Record<string, unknown>[], subs: Record<string, unknown>[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: (row: Record<string, unknown>) => {
      if (name === "subscriptions") subs.push(row);
      return { eq: () => Promise.resolve({ error: null }) };
    },
  });
  return {
    from: (name: string) => table(name),
    rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

function run(effective: string) {
  const quotes: Record<string, unknown>[] = [];
  const subs: Record<string, unknown>[] = [];
  const plan = seatChargePlan(SUB, TODAY, effective)!;
  const p = addSeats({
    supabase: fakeSupabase(quotes, subs),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "HOK Agrichem",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "hok.in",
    currentSeats: 1, currentMrr: 270, additionalSeats: 2,
    renewalDate: SUB.renewal_date, termEnd: "2026-09-15", graceDays: 7, taxRatePct: 18, termDays: 365,
    effectiveDate: effective, effectiveDateSetBy: "Abhishek",
    previousTerm: plan.previous ? { to: plan.previous.to, remainingDays: plan.previous.remainingDays, termDays: plan.previous.termDays } : null,
    currentTermStart: plan.previous ? plan.current.from : null,
    todayISO: TODAY,
  });
  return { p, quotes, subs };
}

describe("addSeats — previous-term effective date", () => {
  it("one quote, two lines, amounts = seatIncreaseQuote, renewal untouched", async () => {
    const { p, quotes, subs } = run("2025-08-01");
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(quotes).toHaveLength(1);
    const lines = quotes[0].line_items as { name: string; qty: number; rate: number }[];
    expect(lines.map((l) => l.name)).toEqual([
      "Google Workspace Business Starter · +2 seats (previous term, pro-rata from 2025-08-01 to 2025-09-14)",
      "Google Workspace Business Starter · +2 seats (current term 2025-09-15 to 2026-09-14)",
    ]);
    expect(lines.map((l) => [l.qty, l.rate])).toEqual([[2, 399], [2, 3240]]);
    expect(quotes[0].subtotal).toBe(7279);
    expect(quotes[0].amount).toBe(8589);
    expect(r.amount).toBe(8589);
    expect(r.newMrr).toBe(810);
    const notes = String(quotes[0].notes);
    expect(notes).toContain("Effective date 2025-08-01 (backdated by Abhishek on 2026-06-01)");
    expect(notes).toContain("Crosses a term: 45 of 365 days of the previous term (to 2025-09-14) + current term from 2025-09-15");
    expect(subs[0]).toEqual({ seats: 3, mrr: 810 });
    expect(subs[0]).not.toHaveProperty("renewal_date");
  });

  it("current-term date: one line, as before R-543", async () => {
    const { p, quotes } = run("2026-05-01");
    const r = await p;
    expect(r.ok && r.proRataDays).toBe(137);
    const lines = quotes[0].line_items as { name: string }[];
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toContain("pro-rata from 2026-05-01 to 2026-09-14");
    expect(String(quotes[0].notes)).not.toContain("Crosses a term");
  });

  it("a previousTerm without a current term start is refused, nothing written", async () => {
    const quotes: Record<string, unknown>[] = [];
    const r = await addSeats({
      supabase: fakeSupabase(quotes, []),
      subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "X",
      plan: "P", vendor: "google", domain: null, currentSeats: 1, currentMrr: 270, additionalSeats: 1,
      renewalDate: SUB.renewal_date, graceDays: 7, taxRatePct: 18, termDays: 365,
      effectiveDate: "2025-08-01", previousTerm: { to: "2025-09-14", remainingDays: 45, termDays: 365 },
      todayISO: TODAY,
    });
    expect(r.ok).toBe(false);
    expect(quotes).toHaveLength(0);
  });
});
