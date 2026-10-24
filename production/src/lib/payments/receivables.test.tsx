// @vitest-environment jsdom
//
// R-1708 — "money owed to us": Payments (dues card), Invoices (Outstanding) and Payment Follow-up
// read ONE rule (lib/payments/receivables.ts). One fixture, three screens, to the rupee:
//   Payment Follow-up total  = Payments "Owed to you" total
//                            = Invoices Outstanding + subscription dues not yet invoiced.
// Before: Payments summed subscriptions.outstanding_amount (₹52,586 here — T-L3's ₹38,232 and
// T-L4's ₹1,29,600 invoices missing, S-A's ₹35,000 counted beside its own invoice).
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import {
  buildCollectionRows, receivableLines,
  type CollectionInvoice, type CollectionSubscription, type CollectionsInput,
} from "@/lib/queries/collections";
import { invoiceKpis } from "@/lib/invoices/kpis";
import { SubscriptionDuesHeading } from "@/app/(app)/payments/dues-list";
import { receivablesTotals, sumReceivables, invoiceReceivable, subscriptionReceivable } from "./receivables";

afterEach(cleanup);

const TODAY = "2026-10-24";

function inv(p: Partial<CollectionInvoice> & { id: string }): CollectionInvoice {
  return {
    customer_id: "c1", customer_name: "Acme", amount: 0, net_payable: null, paid_amount: 0,
    status: "pending", invoice_date: "2026-10-01", due_date: "2026-10-16", quote_id: null,
    taxable_value: null, tax_amount: null, tax_rate: null, written_off_at: null, ...p,
  };
}
function sub(p: Partial<CollectionSubscription> & { id: string }): CollectionSubscription {
  return {
    customer_id: "c1", customer_name: "Acme", plan: "Workspace", domain: null, quote_id: null,
    outstanding_amount: 0, payment_due_date: null, created_at: "2026-10-01T00:00:00Z", ...p,
  };
}

/* Every invoice the tenant has — the Invoices page reads all of them. */
const ALL_INVOICES: CollectionInvoice[] = [
  inv({ id: "INV-L3", amount: 38232, net_payable: 38232, quote_id: "Q-L3" }),                  // T-L3: sub says 0
  inv({ id: "INV-L4", amount: 129600, net_payable: 129600, status: "overdue", customer_id: "c2" }), // T-L4: no sub
  inv({ id: "INV-A", amount: 50000, net_payable: 45000, paid_amount: 10000, quote_id: "Q-A" }),  // ₹35,000 left
  inv({ id: "INV-D", amount: 2000, net_payable: 2000, paid_amount: 2000, status: "paid", quote_id: "Q-D" }),
  inv({ id: "INV-DRAFT", amount: 9999, status: "draft" }),
  inv({ id: "INV-VOID", amount: 5000, status: "void" }),
  inv({ id: "INV-WO", amount: 7000, net_payable: 7000, written_off_at: "2026-10-20T00:00:00Z" }),
];
/* Subscriptions with a balance — what the dues rows list. */
const SUBS: CollectionSubscription[] = [
  sub({ id: "S-A", quote_id: "Q-A", outstanding_amount: 35000 }),        // INV-A already asks for it
  sub({ id: "S-B", quote_id: "Q-B", outstanding_amount: 14406 }),        // not invoiced
  sub({ id: "S-C", quote_id: null, outstanding_amount: 1180.4, customer_id: "c3" }), // not invoiced
  sub({ id: "S-D", quote_id: "Q-D", outstanding_amount: 2000 }),         // its invoice is paid
];
const INVOICED_QUOTES = new Set(ALL_INVOICES.map((i) => i.quote_id).filter((q): q is string => !!q));

/* Payment Follow-up reads only open, not-written-off invoices (fetchCollectionsInput). */
const FOLLOWUP_INPUT: CollectionsInput = {
  invoices: ALL_INVOICES.filter((i) => (i.status === "pending" || i.status === "overdue") && !i.written_off_at),
  subscriptions: SUBS,
  quoteSubscriptions: [],
  invoicedQuoteIds: INVOICED_QUOTES,
  customers: [],
  followups: [],
};

const INVOICED = 38232 + 129600 + 35000;   // ₹2,02,832
const NOT_YET = 14406 + 1180;              // ₹15,586
const TOTAL = INVOICED + NOT_YET;          // ₹2,18,418

describe("R-1708 — one receivables number on three screens", () => {
  it("the shared rule: open invoices + subscription dues no invoice asks for", () => {
    expect(receivablesTotals({ invoices: ALL_INVOICES, subscriptions: SUBS, invoicedQuoteIds: INVOICED_QUOTES }))
      .toEqual({ invoiced: INVOICED, notYetInvoiced: NOT_YET, total: TOTAL });
    expect(invoiceReceivable({ status: "draft", amount: 9999 })).toBe(0);
    expect(subscriptionReceivable({ quote_id: "Q-A", outstanding_amount: 35000 }, INVOICED_QUOTES)).toBe(0);
    expect(subscriptionReceivable({ quote_id: "Q-B", outstanding_amount: 14406, written_off_at: "2026-10-01" }, INVOICED_QUOTES)).toBe(0);
  });

  it("Payment Follow-up's total is the shared total", () => {
    const rows = buildCollectionRows(FOLLOWUP_INPUT, TODAY);
    expect(rows.reduce((s, r) => s + r.amountDue, 0)).toBe(TOTAL);
    expect(sumReceivables(rows.flatMap((r) => r.items))).toEqual({ invoiced: INVOICED, notYetInvoiced: NOT_YET, total: TOTAL });
  });

  it("Invoices → Outstanding is the invoiced part, to the rupee", () => {
    const k = invoiceKpis(ALL_INVOICES.map((i) => ({ ...i, amount: i.amount ?? 0 })), new Date("2026-10-24T06:00:00Z"));
    expect(k.outstanding).toBe(INVOICED);
    expect(k.outstandingCount).toBe(3);
  });

  it("Payments → dues card heading shows the same total and both parts", () => {
    const lines = receivableLines(FOLLOWUP_INPUT);
    render(
      <SubscriptionDuesHeading
        rows={SUBS.map((s) => ({ outstanding_amount: s.outstanding_amount ?? 0, days_outstanding: 5 }))}
        failed={false}
        receivables={{ totals: sumReceivables(lines), failed: false }}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Owed to you · ₹2,18,418");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/₹2,02,832 on open invoices/);
    expect(text).toMatch(/₹15,586 subscription dues not yet invoiced/);
    expect(text).toMatch(/4 subscriptions with a balance/);
    /* The old total — the sum of subscription balances — is not shown as the total any more. */
    expect(text).not.toMatch(/₹52,586/);
  });

  it("the lines carry the customer, so a ?customer= filter scopes the same total", () => {
    const lines = receivableLines(FOLLOWUP_INPUT);
    expect(sumReceivables(lines.filter((l) => l.customerId === "c2")).total).toBe(129600);
    expect(sumReceivables(lines.filter((l) => l.customerId === "c1")).total).toBe(38232 + 35000 + 14406);
  });
});
