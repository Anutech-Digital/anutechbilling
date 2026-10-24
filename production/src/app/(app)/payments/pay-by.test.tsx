// @vitest-environment jsdom
//
// R-1689 — a subscription sold on credit ("Activate now, pay later" / invoice now) raises an
// invoice with a due date and leaves subscriptions.payment_due_date empty. Its row read
// "₹44,132 due · No payment due date" while the credit invoice fell due on 3 Nov 2026 (T-M1,
// T-M3, T-N3). The date the money is due is the oldest unpaid invoice's, else the agreed one.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { buildDuesRows, subscriptionPayBy, type DuesSubRow, type DuesInvoiceRow } from "@/lib/queries/payments";
import { SubscriptionDuesList } from "./dues-list";

afterEach(cleanup);

const TODAY = "2026-10-24";
const sub = (o: Partial<DuesSubRow> = {}): DuesSubRow => ({
  id: "S-M1", customer_id: "c1", customer_name: "T-M1 Pvt Ltd", plan: "Google Workspace Business Starter",
  outstanding_amount: 44132, status: "active", last_reminder_at: null, created_at: "2026-10-19T10:00:00Z",
  start_date: "2026-10-19", payment_due_date: null, quote_id: "Q-M1", renewal_quote_id: null, ...o,
});
const invoice = (o: Partial<DuesInvoiceRow> = {}): DuesInvoiceRow => ({
  id: "INV-M1", quote_id: "Q-M1", invoice_date: "2026-10-19", due_date: "2026-11-03", status: "pending",
  amount: 44132, net_payable: 44132, paid_amount: 0, ...o,
});

describe("R-1689 — pay-by date from the real money state", () => {
  it("credit invoice, no agreed date → pay by the invoice's due date", () => {
    const [row] = buildDuesRows([sub()], [], [], [invoice()], [], TODAY);
    expect(row.pay_by).toBe("2026-11-03");
  });

  it("the oldest UNPAID invoice wins; a paid one is not a due date", () => {
    const rows = buildDuesRows(
      [sub()], [], [],
      [invoice({ id: "INV-OLD", due_date: "2026-10-01", status: "paid", paid_amount: 44132 }), invoice({ id: "INV-NEW", due_date: "2026-11-18" })],
      [], TODAY,
    );
    expect(rows[0].pay_by).toBe("2026-11-18");
  });

  it("postpaid with an agreed date and no invoice keeps the agreed date; neither → null", () => {
    expect(buildDuesRows([sub({ payment_due_date: "2026-11-10" })], [], [], [], [], TODAY)[0].pay_by).toBe("2026-11-10");
    expect(buildDuesRows([sub()], [], [], [], [], TODAY)[0].pay_by).toBeNull();
    expect(subscriptionPayBy(null, null)).toBeNull();
    expect(subscriptionPayBy("2026-11-10", "2026-11-03T00:00:00Z")).toBe("2026-11-03");
  });

  it("the Payments dues row shows 'Pay by 3 Nov 2026', not nothing", () => {
    const rows = buildDuesRows([sub()], [], [], [invoice()], [], TODAY);
    render(
      <SubscriptionDuesList
        rows={rows}
        readOnly
        actions={{ payButton: () => null, onRemind: () => {}, onSuspend: () => {}, onResume: () => {}, onWriteOff: () => {} }}
      />,
    );
    expect(document.body.textContent).toMatch(/Pay by 3 Nov 2026/);
    expect(document.body.textContent).not.toMatch(/No payment due date/);
  });
});
