/**
 * R-2414 — DSO, best DSO, average days late, CEI and promise-kept %, hand-worked on a fixture.
 * Today = Friday 30 Oct 2026 → window = 1 Oct … 30 Oct (30 days, IST).
 */
import { describe, it, expect } from "vitest";
import {
  buildCollectionMetrics, metricsPaymentsFrom, metricsStart,
  type MetricsFollowup, type MetricsInvoice, type MetricsLine,
} from "./collection-metrics";
import type { PromisePayment } from "./followup-rules";

const TODAY = "2026-10-30";
/** 18:00 IST on a date, as UTC. */
const at = (d: string) => `${d}T12:30:00Z`;

// Closing AR 23,000 = overdue 10,000 + 4,000, not yet due 6,000 + 3,000; a 0 line is ignored.
const lines: MetricsLine[] = [
  { amountDue: 10000, daysOverdue: 5 },
  { amountDue: 4000, daysOverdue: 40 },
  { amountDue: 6000, daysOverdue: 0 },     // due today = not late yet
  { amountDue: 3000, daysOverdue: -10 },
  { amountDue: 0, daysOverdue: 90 },
];

// Sales 30,500 = 20,000 + 10,000 (amount, no net_payable) + 500 (500.4 rounded).
const invoices: MetricsInvoice[] = [
  { invoice_date: "2026-10-05", status: "pending", net_payable: 20000, amount: 23600 },  // net_payable wins
  { invoice_date: "2026-10-20", status: "paid", net_payable: null, amount: 10000 },
  { invoice_date: "2026-10-30", status: "overdue", net_payable: 500.4, amount: 500.4 },
  { invoice_date: "2026-09-30", status: "pending", net_payable: 5000, amount: 5000 },   // before the window
  { invoice_date: "2026-10-10", status: "draft", net_payable: 7000, amount: 7000 },      // not issued
  { invoice_date: "2026-10-11", status: "cancelled", net_payable: 2000, amount: 2000 },  // not issued
  { invoice_date: null, status: "pending", net_payable: 900, amount: 900 },               // no date
];

// Received 14,000 = A 12,000 + B 2,000 (3,000 less 1,000 advance credit).
const payments: PromisePayment[] = [
  { customer_id: "A", amount: 12000, received_at: at("2026-10-15"), status: "received" },
  { customer_id: "B", amount: 3000, credit_applied: 1000, received_at: at("2026-10-25"), status: "received" },
  { customer_id: "A", amount: 9999, received_at: at("2026-09-30"), status: "received" },  // before the window
  { customer_id: "A", amount: 500, received_at: at("2026-10-16"), status: "refunded" },   // not received
];

let n = 0;
const fu = (customer_id: string, promised_on: string | null, logged: string, promised_amount: number | null = null): MetricsFollowup =>
  ({ id: `f${++n}`, customer_id, promised_on, promised_amount, created_at: at(logged) });

const followups: MetricsFollowup[] = [
  fu("A", "2026-10-14", "2026-10-10", 10000),  // paid 12,000 only on 15 Oct (after the date) → broken
  fu("B", "2026-10-26", "2026-10-20", 5000),   // B's promise, first logged 20 Oct …
  fu("B", "2026-10-26", "2026-10-22", 1500),   // … newest amount 1,500; paid 2,000 on 25 Oct → kept
  fu("C", "2026-10-30", "2026-10-29", 800),    // due today → not decided, left out
  fu("D", "2026-09-28", "2026-09-25", 100),    // before the window → left out
  fu("E", "2026-10-20", "2026-10-18"),         // E owes nothing now → kept
  fu("F", "2026-10-05", "2026-09-20"),         // logged before the window, nothing paid → broken
  fu("A", null, "2026-10-28"),                 // a note without a promise
];

const owesNow = new Set(["A", "B", "C", "D", "F"]);

describe("collection metrics (hand-worked)", () => {
  const m = buildCollectionMetrics({ today: TODAY, lines, invoices, payments, followups, owesNow });

  it("window = the last 30 days, today included", () => {
    expect(metricsStart(TODAY)).toBe("2026-10-01");
    expect(m.periodStart).toBe("2026-10-01");
    expect(m.days).toBe(30);
  });

  it("balances, sales, received and the derived opening AR", () => {
    expect(m.closingAr).toBe(23000);
    expect(m.currentAr).toBe(9000);
    expect(m.overdueAr).toBe(14000);
    expect(m.sales).toBe(30500);
    expect(m.received).toBe(14000);
    expect(m.openingAr).toBe(6500);   // 23,000 + 14,000 − 30,500
  });

  it("DSO = 23,000 ÷ 30,500 × 30 = 22.6 → 23", () => expect(m.dso).toEqual({ value: 23 }));
  it("best DSO = 9,000 ÷ 30,500 × 30 = 8.9 → 9", () => expect(m.bestDso).toEqual({ value: 9 }));
  it("average days late = 14,000 ÷ 30,500 × 30 = 13.8 → 14", () => expect(m.avgDaysLate).toEqual({ value: 14 }));
  it("CEI = (6,500 + 30,500 − 23,000) ÷ (6,500 + 30,500 − 9,000) = 14,000 ÷ 28,000 = 50%", () => expect(m.cei).toEqual({ value: 50 }));
  it("promise kept = 2 (B, E) of 4 (A, B, E, F) = 50%", () => expect(m.promiseKept).toEqual({ value: 50, kept: 2, due: 4 }));

  it("payments are read from the oldest promise's log day when it is before the window", () => {
    expect(metricsPaymentsFrom(followups, TODAY)).toBe("2026-09-20");
    expect(metricsPaymentsFrom([], TODAY)).toBe("2026-10-01");
  });
});

describe("no data → — with a reason", () => {
  it("no invoices in the window: DSO, best DSO and days late have no value", () => {
    const m = buildCollectionMetrics({ today: TODAY, lines, invoices: [], payments: [], followups: [], owesNow });
    for (const k of ["dso", "bestDso", "avgDaysLate"] as const) {
      expect(m[k].value).toBeNull();
      expect(m[k].reason).toBe("No invoices issued in the last 30 days");
    }
    // Opening = 23,000 + 0 − 0; CEI = (23,000 − 23,000) ÷ (23,000 − 9,000) = 0%
    expect(m.cei).toEqual({ value: 0 });
    expect(m.promiseKept).toEqual({ value: null, reason: "No promise fell due in the last 30 days", kept: 0, due: 0 });
  });

  it("nothing owed, billed or received: CEI has no value", () => {
    const m = buildCollectionMetrics({ today: TODAY, lines: [], invoices: [], payments: [], followups: [], owesNow: new Set() });
    expect(m.cei.value).toBeNull();
    expect(m.cei.reason).toBe("Nothing was owed or billed in the last 30 days");
  });

  it("everything collected and nothing owed: CEI 100%, DSO 0", () => {
    const m = buildCollectionMetrics({
      today: TODAY, lines: [],
      invoices: [{ invoice_date: "2026-10-10", status: "paid", net_payable: 5000, amount: 5000 }],
      payments: [{ customer_id: "A", amount: 5000, received_at: at("2026-10-12"), status: "received" }],
      followups: [], owesNow: new Set(),
    });
    expect(m.cei).toEqual({ value: 100 });
    expect(m.dso).toEqual({ value: 0 });
    expect(m.openingAr).toBe(0);
  });
});
