/**
 * R-803 — every preview of a seat-increase charge equals the quote the server writes.
 *
 * 10 Oct 2026: the Add seats dialog showed ₹853 + ₹154 GST = ₹1,007 and the quote it created
 * (Q-F588-27-0004 — ₹1,656/seat/yr, 188 of 365 days, 1 seat) said ₹1,006. The dialog added
 * the separately rounded subtotal and GST; the server rounds the paise total once
 * (₹852.95 + ₹153.53 = ₹1,006.48). The seat-requests card had a second drift: it kept the
 * per-seat price in paise where the server rounds it to a rupee, so ₹1,000/mo over 3 seats
 * previewed ₹2,172 for a ₹2,173 quote.
 *
 * These tests run the REAL addSeats() against a fake client and compare what it writes with
 * both previews, across cases where the old rounding went each way and multi-seat ones.
 */
import { describe, it, expect } from "vitest";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { seatIncreaseCharge } from "./seat-increase-charge";
import { previewCharge } from "./seat-request";

function fakeSupabase(quotes: Record<string, unknown>[], subUpdates: Record<string, unknown>[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: (patch: Record<string, unknown>) => ({
      eq: () => {
        if (name === "subscriptions") subUpdates.push(patch);
        return Promise.resolve({ error: null });
      },
    }),
  });
  return {
    from: (name: string) => table(name),
    rpc: (fn: string) => Promise.resolve(fn === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

interface Case { name: string; mrr: number; seats: number; add: number; days: number; termDays: number; tax: number }

/** What the server writes for this case: the quote's subtotal and amount, and the new MRR. */
async function serverQuote(c: Case) {
  const quotes: Record<string, unknown>[] = [];
  const subUpdates: Record<string, unknown>[] = [];
  /* Not split-billed: the charge runs from today to the exclusive term end. */
  const today = "2026-09-25";
  const termEnd = new Date(Date.parse(`${today}T00:00:00Z`) + c.days * 86_400_000).toISOString().slice(0, 10);
  const res = await addSeats({
    supabase: fakeSupabase(quotes, subUpdates),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "Test Co",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "test.in",
    currentSeats: c.seats, currentMrr: c.mrr, additionalSeats: c.add,
    renewalDate: termEnd, termEnd, graceDays: 7,
    taxRatePct: c.tax, termDays: c.termDays, todayISO: today,
  });
  if (!res.ok) throw new Error(res.message);
  const q = quotes[0] as { subtotal: number; amount: number };
  return { subtotal: q.subtotal, amount: q.amount, newMrr: subUpdates[0].mrr as number, days: res.proRataDays };
}

const CASES: Case[] = [
  { name: "10 Oct report: ₹1,656/yr, 188/365, 1 seat (old dialog ₹1 high)", mrr: 138, seats: 1, add: 1, days: 188, termDays: 365, tax: 18 },
  { name: "old dialog ₹1 LOW: ₹1,656/yr, 25/365, 1 seat",                  mrr: 138, seats: 1, add: 1, days: 25,  termDays: 365, tax: 18 },
  { name: "old dialog ₹1 low: ₹1,656/yr, 10/365, 1 seat",                  mrr: 138, seats: 1, add: 1, days: 10,  termDays: 365, tax: 18 },
  { name: "multi-seat: ₹1,656/yr, 188/365, +3",                            mrr: 138, seats: 1, add: 3, days: 188, termDays: 365, tax: 18 },
  { name: "multi-seat: 25 seats at ₹30,240/mo, +10, 200/365",               mrr: 30_240, seats: 25, add: 10, days: 200, termDays: 365, tax: 18 },
  { name: "mrr not divisible by seats: ₹1,000/mo over 3, +1, 168/365",      mrr: 1_000, seats: 3, add: 1, days: 168, termDays: 365, tax: 18 },
  { name: "mrr not divisible by seats: ₹1,000/mo over 3, +2, 124/365",      mrr: 1_000, seats: 3, add: 2, days: 124, termDays: 365, tax: 18 },
  { name: "leap-year term: 366 days",                                       mrr: 2_700, seats: 10, add: 7, days: 77, termDays: 366, tax: 18 },
  { name: "two-year term",                                                  mrr: 2_700, seats: 10, add: 4, days: 400, termDays: 730, tax: 18 },
  { name: "zero-rated export",                                              mrr: 138, seats: 1, add: 1, days: 188, termDays: 365, tax: 0 },
];

describe("R-803 seatIncreaseCharge — the 10 Oct case, pinned", () => {
  it("₹1,656/seat/yr × 188/365 × 1 = ₹853 + ₹153 GST = ₹1,006, like quote Q-F588-27-0004", () => {
    const c = seatIncreaseCharge({ currentSeats: 1, currentMrr: 138, additionalSeats: 1, remainingDays: 188, termDays: 365, taxRatePct: 18 });
    expect(c.annualPerSeat).toBe(1_656);
    expect(c.subtotal).toBe(853);
    expect(c.tax).toBe(153);
    expect(c.total).toBe(1_006);
  });

  it("rounding the other way: 25/365 → ₹113 + ₹21 = ₹134 (old dialog said ₹133)", () => {
    const c = seatIncreaseCharge({ currentSeats: 1, currentMrr: 138, additionalSeats: 1, remainingDays: 25, termDays: 365, taxRatePct: 18 });
    expect([c.subtotal, c.tax, c.total]).toEqual([113, 21, 134]);
  });

  it("the three lines always add up", () => {
    for (const k of CASES) {
      const c = seatIncreaseCharge({ currentSeats: k.seats, currentMrr: k.mrr, additionalSeats: k.add, remainingDays: k.days, termDays: k.termDays, taxRatePct: k.tax });
      expect(c.subtotal + c.tax).toBe(c.total);
    }
  });

  it("no seats added → nothing charged", () => {
    const c = seatIncreaseCharge({ currentSeats: 5, currentMrr: 690, additionalSeats: 0, remainingDays: 188, termDays: 365, taxRatePct: 18 });
    expect([c.subtotal, c.tax, c.total, c.perSeat]).toEqual([0, 0, 0, 0]);
    expect(c.newMrr).toBe(690);
  });
});

describe("R-803 previews equal the quote addSeats() writes", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const server = await serverQuote(c);
      expect(server.days).toBe(c.days);

      /* Add seats dialog. */
      const dialog = seatIncreaseCharge({
        currentSeats: c.seats, currentMrr: c.mrr, additionalSeats: c.add,
        remainingDays: c.days, termDays: c.termDays, taxRatePct: c.tax,
      });
      expect(dialog.subtotal).toBe(server.subtotal);
      expect(dialog.total).toBe(server.amount);
      expect(dialog.tax).toBe(server.amount - server.subtotal);
      expect(dialog.newMrr).toBe(server.newMrr);

      /* Seat-requests card (and anything else that calls previewCharge). */
      const card = previewCharge({
        currentSeats: c.seats, currentMrr: c.mrr, seatsToAdd: c.add,
        remainingDays: c.days, termDays: c.termDays, taxRatePct: c.tax,
      })!;
      expect(card.exGst).toBe(server.subtotal);
      expect(card.total).toBe(server.amount);
      expect(card.tax).toBe(server.amount - server.subtotal);
      expect(card.newMrr).toBe(server.newMrr);
    });
  }
});
