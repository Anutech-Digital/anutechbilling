import { describe, expect, it } from "vitest";
import { buildCustomerStatement, type StatementInput } from "./customer-statement";

const base: StatementInput = { invoices: [], payments: [], creditNotes: [], debitNotes: [], projectPayments: [] };

describe("R-1682 customer Statement", () => {
  it("staging T-19: invoice, payment, credit note, part refund → closing ₹0", () => {
    const { rows, closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-5F40-27-0079", invoice_date: "2026-10-19", amount: 7646 }],
      payments: [
        // the payment after the partial refund: ₹1,274 kept, ₹6,372 split off and refunded
        { id: "p1", quote_id: "Q-1", amount: 1274, status: "received", received_at: "2026-10-19T05:00:00Z", receipt_voucher_no: "RV-1" },
        { id: "p2", quote_id: "Q-1", amount: 6372, status: "refunded", received_at: "2026-10-19T05:00:00Z", refunded_at: "2026-10-19T09:00:00Z", refund_voucher_no: "RFV-1" },
      ],
      creditNotes: [{ id: "CN-5F40-27-0001", invoice_id: "INV-5F40-27-0079", credit_date: "2026-10-19", amount: 6372 }],
    });
    expect(closing).toBe(0);
    expect(rows.map((r) => r.desc)).toEqual([
      "Invoice INV-5F40-27-0079",
      "Payment received · RV-1",
      "Payment received",
      "Credit note CN-5F40-27-0001 · on INV-5F40-27-0079",
      "Refund · RFV-1",
    ]);
    // never dips into credit before the refund is shown
    expect(rows.map((r) => r.balance)).toEqual([7646, 6372, 0, -6372, 0]);
  });

  it("before the refund the credit note shows as money owed to the customer", () => {
    const { closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-19", amount: 7646 }],
      payments: [{ id: "p1", quote_id: "Q-1", amount: 7646, status: "received", received_at: "2026-10-19T05:00:00Z" }],
      creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-19", amount: 6372 }],
    });
    expect(closing).toBe(-6372);
  });

  it("a fully refunded payment shows its receipt AND the refund (it used to show only the refund)", () => {
    const { rows, closing } = buildCustomerStatement({
      ...base,
      payments: [{ id: "p1", quote_id: "Q-1", amount: 1180, status: "refunded", received_at: "2026-10-01T05:00:00Z", refunded_at: "2026-10-05T05:00:00Z" }],
    });
    expect(rows).toHaveLength(2);
    expect(closing).toBe(0);
  });

  it("debit notes add to what is owed; project receipts reduce it", () => {
    const { closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-01", amount: 1000 }],
      debitNotes: [{ id: "DN-1", invoice_id: "INV-1", debit_date: "2026-10-02", amount: 180 }],
      projectPayments: [{ received_at: "2026-10-03T05:00:00Z", amount: 500, project_title: "Site", project_id: "pr1", invoice_id: null }],
    });
    expect(closing).toBe(680);
  });
});
