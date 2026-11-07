/**
 * R-2226 (G-ZOHO Billing A2) — seats added to a subscription billed in parts are priced at the
 * part's own rate: part per-seat price × days left in the part ÷ days in the part.
 *
 * Owner's example (Zoho Billing audit, 31 Oct 2026): ₹3,240/seat/yr billed monthly = ₹270 a
 * month. Adding a seat for a whole month cost ₹266 (30-day month) or ₹275 (31-day month).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { partShareOf, partFormula, type SeatPartSegment } from "./seat-part-rate";
import { seatChargeParts, seatChargePlan, seatChargeWindow } from "./seat-charge-window";
import { seatIncreaseCharge, seatIncreaseQuote } from "./seat-increase-charge";
import { previewCharge } from "./seat-request";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { staffQuoteNotes } from "@/lib/quotes/customer-notes";
import type { BillingCycle } from "@/lib/supabase/database.types";

/* 10 seats × ₹3,240/yr → mrr ₹2,700; 1 Apr 2026 → 31 Mar 2027 (inclusive end). */
const MONTHLY = {
  mrr: 2700,
  billing_cycle: "monthly" as BillingCycle,
  term_months: 12,
  start_date: "2026-04-01",
  renewal_date: "2027-03-31",
};
const HALF = { ...MONTHLY, billing_cycle: "half_yearly" as BillingCycle };
const QUARTERLY = { ...MONTHLY, billing_cycle: "quarterly" as BillingCycle };
const YEARLY = { ...MONTHLY, billing_cycle: "yearly" as BillingCycle };

const charge = (sub: typeof MONTHLY, today: string, from?: string) => {
  const w = seatChargeWindow(sub, today, from)!;
  return seatIncreaseCharge({
    currentSeats: 10, currentMrr: 2700, additionalSeats: 1, taxRatePct: 18,
    remainingDays: w.remainingDays, termDays: w.termDays,
    parts: seatChargeParts(sub, today, from),
  });
};

describe("R-2226: a whole part costs exactly one part's per-seat price", () => {
  it("monthly, whole 30-day month (June): ₹270, not ₹266", () => {
    expect(charge(MONTHLY, "2026-06-01").perSeat).toBe(270);
  });
  it("monthly, whole 31-day month (July): ₹270, not ₹275", () => {
    expect(charge(MONTHLY, "2026-07-01").perSeat).toBe(270);
  });
  it("monthly, half of June (16 → 30 Jun = 15 of 30 days): ₹135", () => {
    expect(charge(MONTHLY, "2026-06-16").perSeat).toBe(135);
  });
  it("half-yearly, whole first half: ₹1,620", () => {
    expect(charge(HALF, "2026-04-01").perSeat).toBe(1620);
  });
  it("quarterly, last day of a quarter: 1 of 91 days of ₹810", () => {
    const parts = seatChargeParts(QUARTERLY, "2026-06-30")!;
    expect(parts).toEqual([{ from: "2026-06-30", to: "2026-06-30", days: 1, partDays: 91, partMonths: 3 }]);
    expect(charge(QUARTERLY, "2026-06-30").perSeat).toBe(9); // 810 × 1/91 = 8.9
  });
  it("yearly is unchanged: annual × days ÷ term days (25 Sep: 188/365 of ₹3,240 = ₹1,669)", () => {
    expect(seatChargeParts(YEARLY, "2026-09-25")).toBeNull();
    expect(charge(YEARLY, "2026-09-25").perSeat).toBe(Math.round((3240 * 188) / 365));
  });
});

describe("R-2226: backdated across parts — each part at its own days, rounded once", () => {
  it("monthly, today 10 Jul, effective 16 Jun: 15/30 of June + all of July = ₹405", () => {
    const parts = seatChargeParts(MONTHLY, "2026-07-10", "2026-06-16")!;
    expect(parts).toEqual([
      { from: "2026-06-16", to: "2026-06-30", days: 15, partDays: 30, partMonths: 1 },
      { from: "2026-07-01", to: "2026-07-31", days: 31, partDays: 31, partMonths: 1 },
    ]);
    expect(charge(MONTHLY, "2026-07-10", "2026-06-16").perSeat).toBe(405);
  });
  it("R-543 previous-term date: the current-term part runs from the term start through today's part", () => {
    const sub = { ...QUARTERLY, start_date: "2025-04-01" };
    const plan = seatChargePlan(sub, "2026-05-10", "2026-03-01")!;
    expect(plan.previous).not.toBeNull();
    const parts = seatChargeParts(sub, "2026-05-10", plan.current.from)!;
    expect(parts).toEqual([{ from: "2026-04-01", to: "2026-06-30", days: 91, partDays: 91, partMonths: 3 }]);
  });
});

describe("partShareOf — exact integer maths", () => {
  const seg = (days: number, partDays: number, partMonths = 1): SeatPartSegment => ({ from: "x", to: "y", days, partDays, partMonths });
  it("rounds half away from zero once", () => {
    expect(partShareOf(3240, [seg(1, 2)])).toBe(135);   // 270 / 2
    expect(partShareOf(12, [seg(1, 2)])).toBe(1);        // 0.5 → 1
    expect(partShareOf(-12, [seg(1, 2)])).toBe(-1);
  });
  it("days are clamped to the part", () => {
    expect(partShareOf(3240, [seg(40, 30)])).toBe(270);
    expect(partShareOf(3240, [seg(-3, 30)])).toBe(0);
  });
  it("formula line names the part rate and the days", () => {
    expect(partFormula(3240, [seg(15, 30)], (n) => `₹${n}`)).toBe("Part rate ₹270/seat (1 month of ₹3240/yr) × 15 of 30 days");
  });
});

describe("R-2226: preview = quote", () => {
  it("previewCharge with parts gives the part price", () => {
    const w = seatChargeWindow(MONTHLY, "2026-07-01")!;
    const p = previewCharge({
      currentSeats: 10, currentMrr: 2700, seatsToAdd: 2, remainingDays: w.remainingDays, termDays: w.termDays,
      taxRatePct: 18, parts: seatChargeParts(MONTHLY, "2026-07-01"),
    })!;
    expect(p.perSeat).toBe(270);
    expect(p.exGst).toBe(540);
  });

  it("addSeats writes the part price on the quote line, the part cost, and the formula in the staff note", async () => {
    const quotes: Record<string, unknown>[] = [];
    const fake = {
      from: (name: string) => ({
        select: () => ({ eq: () => Promise.resolve({ data: [{ id: "item-1", name: "Business Starter", vendor: "google", prices: null, wholesale: 120 }], error: null }) }),
        insert: (row: Record<string, unknown>) => { if (name === "quotes") quotes.push(row); return Promise.resolve({ error: null }); },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
      rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
    } as unknown as AddSeatsInput["supabase"];
    const w = seatChargeWindow(MONTHLY, "2026-07-01")!;
    const parts = seatChargeParts(MONTHLY, "2026-07-01")!;
    const r = await addSeats({
      supabase: fake, subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "Part Co",
      plan: "Business Starter", vendor: "google", itemId: "item-1", domain: null,
      currentSeats: 10, currentMrr: 2700, additionalSeats: 2,
      renewalDate: MONTHLY.renewal_date, termEnd: "2027-04-01", graceDays: 7, taxRatePct: 18, termDays: 365,
      chargeWindow: { remainingDays: w.remainingDays, chargeTo: w.chargeTo, parts },
      todayISO: "2026-07-01",
    });
    expect(r.ok).toBe(true);
    const q = quotes[0];
    const line = (q.line_items as { rate: number; cost: number; qty: number }[])[0];
    expect(line.rate).toBe(270);
    expect(line.qty).toBe(2);
    expect(q.subtotal).toBe(540);
    expect(line.cost).toBe(120);            // ₹120/seat/month cost × a whole month
    expect(q.total_cost).toBe(240);
    const staff = staffQuoteNotes(String(q.notes));
    expect(staff).toContain("Part rate ₹270/seat (1 month of ₹3,240/yr) × 31 of 31 days");
    expect(staff).not.toMatch(/of 365 days/);
  });

  it("seatIncreaseQuote passes parts through for the current line", () => {
    const q = seatIncreaseQuote({
      currentSeats: 10, currentMrr: 2700, additionalSeats: 1, taxRatePct: 0,
      current: { remainingDays: 30, termDays: 365, parts: seatChargeParts(MONTHLY, "2026-06-01") },
    });
    expect(q.current.perSeat).toBe(270);
    expect(q.subtotal).toBe(270);
  });
});

describe("R-2226 wiring: every caller prices with the parts", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  it("server path (applySeatIncrease) sends the parts in the charge window", () => {
    expect(src("lib/subscriptions/apply-seat-increase.ts")).toMatch(/seatChargeParts\(/);
  });
  it("Add seats dialog previews with the parts and shows the formula line", () => {
    const s = src("components/features/subscriptions/add-seats-dialog.tsx");
    expect(s).toMatch(/seatChargeParts\(/);
    expect(s).toMatch(/partFormula\(/);
  });
  it("seat-request approval card previews with the parts", () => {
    expect(src("components/features/subscriptions/seat-requests-card.tsx")).toMatch(/seatChargeParts\(/);
  });
});
