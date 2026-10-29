/**
 * R-2046 — "Commitment due" on the Quotes list: the unpaid part payment requests (R-2044) of
 * subscriptions billed in parts. After R-2044 an unpaid part is a quote, not an invoice, so it
 * is not in receivables; this list is where the owner sees that committed money.
 *
 * Shapes are the local DB's own part requests (Q-F588-27-0049 "SCN Bharat Apps",
 * "Advance payment for Q2 · 28 Oct–27 Jan 2027", ₹4,814, bill_on 2026-10-28).
 */
import { describe, it, expect } from "vitest";
import {
  isCommitmentDue,
  commitmentStillDue,
  commitmentDueLabel,
  commitmentDueRows,
  type CommitmentQuote,
} from "./commitment-due";

const req = (over: Partial<CommitmentQuote> = {}): CommitmentQuote => ({
  id: "Q-F588-27-0049",
  customer_id: "c-1",
  customer_name: "SCN Bharat Apps",
  amount: 4814,
  payment_amount: 0,
  payment_status: "awaiting",
  status: "sent",
  invoice_id: null,
  subscription_billing_id: "b-1",
  line_items: [{ name: "Advance payment for Q2 · 28 Oct–27 Jan 2027" }],
  open_balance: null,
  ...over,
});

describe("isCommitmentDue — which quotes are in the list", () => {
  it("an open, unpaid part request is in (sent, viewed or accepted)", () => {
    for (const status of ["sent", "viewed", "accepted"]) {
      expect(isCommitmentDue(req({ status }))).toBe(true);
    }
  });

  it("a paid request is out (received / invoiced, or nothing left to pay)", () => {
    expect(isCommitmentDue(req({ payment_status: "received", payment_amount: 4814 }))).toBe(false);
    expect(isCommitmentDue(req({ payment_status: "invoiced" }))).toBe(false);
    expect(isCommitmentDue(req({ open_balance: 0 }))).toBe(false);
  });

  it("a part-paid request stays in, for what is still due", () => {
    const q = req({ payment_status: "partial", payment_amount: 2000 });
    expect(isCommitmentDue(q)).toBe(true);
    expect(commitmentStillDue(q)).toBe(2814);
    expect(commitmentStillDue(req({ payment_status: "partial", payment_amount: 2000, open_balance: 2700 }))).toBe(2700);
  });

  it("a request the customer stopped is out (stop_part_payment_request sets it rejected)", () => {
    expect(isCommitmentDue(req({ status: "rejected" }))).toBe(false);
    expect(isCommitmentDue(req({ status: "expired" }))).toBe(false);
    expect(isCommitmentDue(req({ status: "draft" }))).toBe(false);
  });

  it("an invoiced request is out", () => {
    expect(isCommitmentDue(req({ invoice_id: "INV-F588-27-0032" }))).toBe(false);
  });

  it("an ordinary quote (no subscription_billing_id) is out", () => {
    expect(isCommitmentDue(req({ subscription_billing_id: null }))).toBe(false);
    expect(isCommitmentDue(req({ subscription_billing_id: undefined }))).toBe(false);
  });
});

describe("commitmentDueLabel — days overdue, counted from the part's bill date", () => {
  it("past the bill date → N days overdue", () => {
    expect(commitmentDueLabel("2026-10-01", "2026-10-28")).toEqual({ days: 27, text: "27 days overdue", tone: "overdue" });
    expect(commitmentDueLabel("2026-10-27", "2026-10-28")).toEqual({ days: 1, text: "1 day overdue", tone: "overdue" });
  });
  it("on the bill date → Due today", () => {
    expect(commitmentDueLabel("2026-10-28", "2026-10-28")).toEqual({ days: 0, text: "Due today", tone: "today" });
  });
  it("before the bill date → Due in N days", () => {
    expect(commitmentDueLabel("2026-11-02", "2026-10-28")).toEqual({ days: -5, text: "Due in 5 days", tone: "upcoming" });
    expect(commitmentDueLabel("2026-10-29", "2026-10-28")).toEqual({ days: -1, text: "Due in 1 day", tone: "upcoming" });
  });
  it("no bill date known → says so, never a made-up 0", () => {
    expect(commitmentDueLabel(null, "2026-10-28")).toEqual({ days: null, text: "Due date not found", tone: "unknown" });
  });
});

describe("commitmentDueRows — the list and its total", () => {
  const quotes = [
    req({ id: "Q-A", customer_name: "Alpha", subscription_billing_id: "b-a", amount: 2443, line_items: [{ name: "Advance payment for Q1 · 1 Oct–31 Dec 2026" }] }),
    req({ id: "Q-B", customer_name: "Beta", subscription_billing_id: "b-b", amount: 4814, payment_status: "partial", payment_amount: 1000 }),
    req({ id: "Q-PAID", subscription_billing_id: "b-p", payment_status: "received", payment_amount: 4814 }),
    req({ id: "Q-STOP", subscription_billing_id: "b-s", status: "rejected" }),
    req({ id: "Q-INV", subscription_billing_id: "b-i", invoice_id: "INV-1" }),
    req({ id: "Q-SALE", subscription_billing_id: null }),
  ];
  const billOn = new Map([["b-a", "2026-10-01"], ["b-b", "2026-10-28"], ["b-p", "2026-10-01"], ["b-s", "2026-10-01"], ["b-i", "2026-10-01"]]);

  it("keeps only the open unpaid requests, most overdue first, keyed by their own quote id", () => {
    const { rows } = commitmentDueRows(quotes, billOn, "2026-10-28");
    expect(rows.map((r) => r.quoteId)).toEqual(["Q-A", "Q-B"]);
    expect(rows[0]).toMatchObject({
      quoteId: "Q-A",
      customerName: "Alpha",
      period: "Advance payment for Q1 · 1 Oct–31 Dec 2026",
      amount: 2443,
      stillDue: 2443,
      billOn: "2026-10-01",
      due: { days: 27, text: "27 days overdue" },
      partPaid: false,
    });
    expect(rows[1]).toMatchObject({ quoteId: "Q-B", amount: 4814, stillDue: 3814, partPaid: true, due: { text: "Due today" } });
  });

  it("the total is what is still due across the list", () => {
    expect(commitmentDueRows(quotes, billOn, "2026-10-28").total).toBe(2443 + 3814);
  });

  it("an empty list totals ₹0", () => {
    expect(commitmentDueRows([], new Map(), "2026-10-28")).toEqual({ rows: [], total: 0 });
  });
});
