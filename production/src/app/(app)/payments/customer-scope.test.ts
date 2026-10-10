import { describe, it, expect } from "vitest";
import { scopeToCustomer, paymentTotals, paymentsSummaryLine } from "./customer-scope";

/* R-533 — the staging case: Delhom and delfos each paid ₹38,232. With ?customer=Delhom the
   page showed Delhom's one card but "Received 2 · ₹76,464 collected all-time". */
const DELHOM = "cust-delhom";
const DELFOS = "cust-delfos";

const payments = [
  { id: "p1", customer_id: DELHOM, quote_id: "Q-1", status: "received", amount: 38232 },
  { id: "p2", customer_id: DELFOS, quote_id: "Q-2", status: "received", amount: 38232 },
];
const quotes = [
  { id: "Q-1", customer_id: DELHOM, payment_status: "received", amount: 38232 },
  { id: "Q-2", customer_id: DELFOS, payment_status: "partial", amount: 50000 },
  { id: "Q-3", customer_id: DELFOS, payment_status: "received", amount: 1000 },
];
const projectPayments = [{ id: "j1", customer_id: DELFOS, amount: 5000 }];
const outstanding = [{ subscription_id: "s1", customer_id: DELFOS, outstanding_amount: 11768 }];
const lists = { payments, projectPayments, quotes, outstanding };

describe("scopeToCustomer (R-533)", () => {
  it("narrows every list to the one customer", () => {
    const s = scopeToCustomer(lists, DELHOM);
    expect(s.payments.map((p) => p.id)).toEqual(["p1"]);
    expect(s.quotes.map((q) => q.id)).toEqual(["Q-1"]);
    expect(s.projectPayments).toEqual([]);
    expect(s.outstanding).toEqual([]);
  });

  it("counts a receipt with no customer_id through its quote", () => {
    const s = scopeToCustomer(
      { ...lists, payments: [...payments, { id: "p3", customer_id: null, quote_id: "Q-1", status: "received", amount: 100 }] },
      DELHOM,
    );
    expect(s.payments.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("returns the whole company when there is no filter", () => {
    const s = scopeToCustomer(lists, null);
    expect(s.payments).toHaveLength(2);
    expect(s.quotes).toHaveLength(3);
    expect(s.projectPayments).toHaveLength(1);
    expect(s.outstanding).toHaveLength(1);
  });
});

describe("paymentTotals on the scoped slice (R-533)", () => {
  it("Delhom: All 1 / Received 1 / Refunded 0, ₹38,232 collected", () => {
    const s = scopeToCustomer(lists, DELHOM);
    const t = paymentTotals(s.payments, s.projectPayments);
    expect(t.counts.all).toBe(1);
    expect(t.counts.received).toBe(1);
    expect(t.counts.refunded ?? 0).toBe(0);
    expect(t.totalCollected).toBe(38232);
  });

  it("no filter: the company figures are unchanged (incl. project receipts)", () => {
    const s = scopeToCustomer(lists, undefined);
    const t = paymentTotals(s.payments, s.projectPayments);
    expect(t.counts.all).toBe(2);
    expect(t.counts.received).toBe(2);
    expect(t.projectCollected).toBe(5000);
    expect(t.totalCollected).toBe(38232 * 2 + 5000);
  });

  it("refunds are counted but not collected", () => {
    const t = paymentTotals([
      { status: "received", amount: 100 },
      { status: "refunded", amount: 40 },
    ], []);
    expect(t.counts).toEqual({ all: 2, received: 1, refunded: 1 });
    expect(t.totalCollected).toBe(100);
  });
});

describe("paymentsSummaryLine (R-533)", () => {
  it("names the customer and drops 'N of M' when nothing else narrows it", () => {
    expect(paymentsSummaryLine({ shown: 1, total: 1, collected: "₹38,232", customerName: "Delhom" }))
      .toBe("1 payment · ₹38,232 collected from Delhom");
  });

  it("keeps 'N of M' when a tab or search narrows the customer's list", () => {
    expect(paymentsSummaryLine({ shown: 1, total: 3, collected: "₹9,000", customerName: "Delhom" }))
      .toBe("1 of 3 payments · ₹9,000 collected from Delhom");
  });

  it("is unchanged without a customer", () => {
    expect(paymentsSummaryLine({ shown: 1, total: 2, collected: "₹76,464", customerName: null }))
      .toBe("1 of 2 payments · ₹76,464 collected all-time");
  });
});
