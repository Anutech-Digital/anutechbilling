/**
 * R-1518 — the owner's week on /collections: the maths on fixtures.
 * Today = Saturday 17 Oct 2026 → week = Monday 12 Oct … 17 Oct (IST).
 */
import { describe, it, expect } from "vitest";
import { buildWeeklyReport, maySeeCollectionsReport, paymentsFrom, weekStartOf, type ReportFollowup, type ReportPayment } from "./weekly-report";

const TODAY = "2026-10-17";
const A = "cust-a", B = "cust-b", C = "cust-c", D = "cust-d", X = "cust-x";
const P1 = "user-1", P2 = "user-2";

/** IST evening of a date, as a UTC instant (18:00 IST = 12:30Z). */
const at = (d: string, hhmm = "12:30") => `${d}T${hhmm}:00Z`;

let n = 0;
const fu = (customer_id: string, created: string, extra: Partial<ReportFollowup> = {}): ReportFollowup => ({
  id: `f${++n}`, customer_id, promised_on: null, promised_amount: null, created_by: P1, created_at: created, ...extra,
});
const pay = (customer_id: string | null, amount: number, received: string, status = "received"): ReportPayment => ({ customer_id, amount, received_at: received, status });

const followups: ReportFollowup[] = [
  // A: promised ₹10,000 by 14 Oct, logged 10 Oct (last week) — paid ₹10,000 on 13 Oct → kept
  fu(A, at("2026-10-10"), { promised_on: "2026-10-14", promised_amount: 10000, created_by: P2 }),
  // B: promised ₹5,000 by 15 Oct, logged this week — paid only ₹2,000 → broken
  fu(B, at("2026-10-12"), { promised_on: "2026-10-15", promised_amount: 5000 }),
  // B: same promise logged again later (one promise, newest amount)
  fu(B, at("2026-10-13"), { promised_on: "2026-10-15", promised_amount: 5000 }),
  // C: promised (no amount) by today, nothing paid yet → "today", not broken
  fu(C, at("2026-10-16"), { promised_on: "2026-10-17", created_by: P2 }),
  // D: last follow-up 9 days ago, promise for next week (made last week, not due)
  fu(D, at("2026-10-08"), { promised_on: "2026-10-22", promised_amount: 1000 }),
  // X: paid in full this week, off the list now — still counts as a list customer
  fu(X, at("2026-10-05")),
];

const payments: ReportPayment[] = [
  pay(A, 10000, at("2026-10-13")),
  pay(B, 2000, at("2026-10-14")),
  pay(X, 7000.4, at("2026-10-15")),
  pay("not-followed", 99999, at("2026-10-15")),       // never on the list → not counted
  pay(A, 500, at("2026-10-11")),                        // Sunday before the week → not counted as this week
  pay(B, 3000, at("2026-10-16"), "refunded"),           // not received
  pay(A, 800, "2026-10-11T19:00:00Z"),                  // 00:30 IST on Monday 12 Oct → this week
];

const owing = [
  { customerId: A, customerName: "Alpha", amountDue: 20000 },
  { customerId: B, customerName: "Beta", amountDue: 3000 },
  { customerId: C, customerName: "Gamma", amountDue: 1500 },
  { customerId: D, customerName: "Delta", amountDue: 9000 },
  { customerId: "cust-e", customerName: "Echo", amountDue: 400 },  // never followed up
];

describe("weekly report", () => {
  const r = buildWeeklyReport({ today: TODAY, owing, followups, payments });

  it("week = Monday … today (IST)", () => {
    expect(weekStartOf("2026-10-17")).toBe("2026-10-12");
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12");
    expect(weekStartOf("2026-10-18")).toBe("2026-10-12");   // Sunday
    expect(r.weekStart).toBe("2026-10-12");
  });

  it("money received this week from list customers, whole rupees, IST dates", () => {
    expect(r.received).toEqual({ total: 10000 + 2000 + 7000 + 800, payments: 4, customers: 3 });
  });

  it("R-1565: advance credit applied is not money the customer paid this week", () => {
    const withCredit = buildWeeklyReport({
      today: TODAY, owing, followups,
      payments: [...payments,
        { ...payments[0], amount: 6000, credit_applied: 4000 },   // ₹2,000 cash
        { ...payments[0], amount: 3000, credit_applied: 3000 }],  // all credit — not a payment
    });
    expect(withCredit.received.total).toBe(r.received.total + 2000);
    expect(withCredit.received.payments).toBe(r.received.payments + 1);
  });

  it("promises made / kept / broken / due today", () => {
    expect(r.promises.made).toBe(3);             // B twice + C, logged this week
    expect(r.promises.madeAmount).toBe(10000);
    expect(r.promises.outcomes.map((o) => [o.customerId, o.result, o.paid])).toEqual([
      [A, "kept", 11300],   // 500 on Sun 11 Oct is after the promise was logged
      [B, "broken", 2000],
      [C, "today", 0],
    ]);
    expect([r.promises.due, r.promises.kept, r.promises.broken, r.promises.today]).toEqual([3, 1, 1, 1]);
  });

  it("follow-ups per person this week, most first", () => {
    expect(r.perPerson).toEqual([{ userId: P1, count: 2 }, { userId: P2, count: 1 }]);
  });

  it("customers who owe with no follow-up for 7+ days (or never), biggest first", () => {
    expect(r.quiet.map((q) => [q.customerName, q.days])).toEqual([["Alpha", 7], ["Delta", 9], ["Echo", null]]);
  });

  it("payments are read from the day the oldest promise due this week was logged", () => {
    expect(paymentsFrom(followups, TODAY)).toBe("2026-10-10");
    expect(paymentsFrom([], TODAY)).toBe("2026-10-12");
  });

  it("only owner / manager / accountant see it", () => {
    expect(["owner", "manager", "accountant"].every(maySeeCollectionsReport)).toBe(true);
    expect(["sales", "billing", "support", null].some(maySeeCollectionsReport)).toBe(false);
  });
});
