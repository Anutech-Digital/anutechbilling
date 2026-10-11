/**
 * R-837 — Pardeep's R-834 rule on add-seats and renewal quotes: the whole-rupee per-seat rate
 * is the price, line total = rate × qty, subtotal = sum of lines, total = grossAmount(subtotal).
 *
 * Before, both flows priced the subtotal first and put a rounded per-seat figure on the line
 * "for display only", so rate × qty could read ₹1 or more away from the subtotal under it.
 */
import { describe, it, expect } from "vitest";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { seatIncreaseCharge, seatIncreaseQuote } from "./seat-increase-charge";
import { previewCharge } from "./seat-request";
import { renewalTerm } from "@/lib/renewals/renewal-term";
import { grossAmount } from "@/lib/quotes/amounts";

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
    rpc: (fn: string) => Promise.resolve(fn === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

/* Odd seat / mrr pairs — mrr × 12 does not divide by seats, and pro-rata never divides evenly. */
const ODD = [
  { mrr: 83, seats: 10 },
  { mrr: 1_000, seats: 3 },
  { mrr: 1_001, seats: 7 },
  { mrr: 2_345, seats: 13 },
  { mrr: 138, seats: 1 },
];
const DAYS = [1, 25, 124, 168, 188, 300, 364];
const ADD = [1, 2, 3, 7, 11];

describe("R-837 add-seats: rate × qty = line total = subtotal", () => {
  it("seatIncreaseCharge, odd pairs at many lengths", () => {
    for (const p of ODD) for (const days of DAYS) for (const add of ADD) {
      const c = seatIncreaseCharge({ currentSeats: p.seats, currentMrr: p.mrr, additionalSeats: add, remainingDays: days, termDays: 365, taxRatePct: 18 });
      expect(Number.isInteger(c.perSeat)).toBe(true);
      expect(c.perSeat * add).toBe(c.subtotal);
      expect(c.total).toBe(grossAmount(c.subtotal, 18));
      expect(c.subtotal + c.tax).toBe(c.total);
    }
  });

  it("₹2,700/mo over 10, +20, 228/365 → ₹2,024 × 20 = ₹40,480 (was a ₹40,478 subtotal under a ₹2,024 line)", () => {
    const c = seatIncreaseCharge({ currentSeats: 10, currentMrr: 2_700, additionalSeats: 20, remainingDays: 228, termDays: 365, taxRatePct: 18 });
    expect([c.perSeat, c.subtotal, c.tax, c.total]).toEqual([2_024, 40_480, 7_286, 47_766]);
  });

  it("an even case is unchanged: ₹3,240/seat/yr, +2, full term → ₹3,240 × 2 = ₹6,480, ₹7,646", () => {
    const c = seatIncreaseCharge({ currentSeats: 10, currentMrr: 2_700, additionalSeats: 2, remainingDays: 365, termDays: 365, taxRatePct: 18 });
    expect([c.perSeat, c.subtotal, c.total]).toEqual([3_240, 6_480, 7_646]);
  });

  it("two-line quote (previous term + current): lines add up to the subtotal", () => {
    for (const p of ODD) for (const prevDays of [3, 45, 200]) for (const add of [1, 3, 7]) {
      const q = seatIncreaseQuote({
        currentSeats: p.seats, currentMrr: p.mrr, additionalSeats: add, taxRatePct: 18,
        previous: { remainingDays: prevDays, termDays: 365 }, current: { remainingDays: 190, termDays: 365 },
      });
      expect(q.previous!.perSeat * add + q.current.perSeat * add).toBe(q.subtotal);
      expect(q.total).toBe(grossAmount(q.subtotal, 18));
    }
  });

  it("addSeats() writes lines whose rate × qty equals the subtotal, and the previews equal the quote", async () => {
    const today = "2026-09-25";
    for (const p of ODD) for (const days of [25, 168, 300]) for (const add of [1, 2, 7]) {
      const quotes: Record<string, unknown>[] = [];
      const termEnd = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const r = await addSeats({
        supabase: fakeSupabase(quotes),
        subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "Test Co",
        plan: "Google Workspace Business Starter", vendor: "google", domain: "test.in",
        currentSeats: p.seats, currentMrr: p.mrr, additionalSeats: add,
        renewalDate: termEnd, termEnd, graceDays: 7, taxRatePct: 18, termDays: 365, todayISO: today,
      });
      expect(r.ok).toBe(true);
      const q = quotes[0] as { subtotal: number; amount: number; line_items: { qty: number; rate: number }[] };
      const lineSum = q.line_items.reduce((s, l) => s + l.qty * l.rate, 0);
      expect(lineSum).toBe(q.subtotal);
      expect(q.amount).toBe(grossAmount(q.subtotal, 18));

      /* Add seats dialog (seatIncreaseQuote) and seat-requests card (previewCharge). */
      const dialog = seatIncreaseQuote({
        currentSeats: p.seats, currentMrr: p.mrr, additionalSeats: add, taxRatePct: 18,
        current: { remainingDays: days, termDays: 365 },
      });
      expect([dialog.current.perSeat, dialog.subtotal, dialog.total]).toEqual([q.line_items[0].rate, q.subtotal, q.amount]);
      const card = previewCharge({ currentSeats: p.seats, currentMrr: p.mrr, seatsToAdd: add, remainingDays: days, termDays: 365, taxRatePct: 18 })!;
      expect([card.perSeat, card.exGst, card.total]).toEqual([q.line_items[0].rate, q.subtotal, q.amount]);
    }
  });
});

describe("R-837 renewals: rate × qty = subtotal", () => {
  it("odd pairs at 1, 3, 6, 12, 24, 36 months", () => {
    for (const p of ODD) for (const termMonths of [1, 3, 6, 12, 24, 36]) {
      const r = renewalTerm({ mrr: p.mrr, seats: p.seats, termMonths });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(Number.isInteger(r.perSeatRate)).toBe(true);
      expect(r.perSeatRate * p.seats).toBe(r.subtotal);
    }
  });

  it("the R-834 example: 10 seats at ₹83/mo, 12 months → ₹100 × 10 = ₹1,000 (was ₹996)", () => {
    const r = renewalTerm({ mrr: 83, seats: 10, termMonths: 12 });
    expect(r.ok && [r.perSeatRate, r.subtotal]).toEqual([100, 1_000]);
  });

  it("₹1,000/mo over 3 seats, 12 months → ₹4,000 × 3 = ₹12,000 (unchanged — mrr × 12 divides)", () => {
    const r = renewalTerm({ mrr: 1_000, seats: 3, termMonths: 12 });
    expect(r.ok && [r.perSeatRate, r.subtotal]).toEqual([4_000, 12_000]);
  });

  it("₹1,000/mo over 3 seats, 1 month → ₹333 × 3 = ₹999 (was ₹1,000 with a ₹333 line)", () => {
    const r = renewalTerm({ mrr: 1_000, seats: 3, termMonths: 1 });
    expect(r.ok && [r.perSeatRate, r.subtotal]).toEqual([333, 999]);
  });

  it("even cases unchanged: SAHAKAR 14 × ₹270, XYZ monthly 10 × ₹270", () => {
    const a = renewalTerm({ mrr: 3_780, seats: 14, termMonths: 12 });
    expect(a.ok && [a.perSeatRate, a.subtotal]).toEqual([3_240, 45_360]);
    const b = renewalTerm({ mrr: 2_700, seats: 10, termMonths: 1 });
    expect(b.ok && [b.perSeatRate, b.subtotal]).toEqual([270, 2_700]);
  });
});
