/* R-2544 (Pardeep, 6 Nov): Customer → Transactions — each payment sits under the invoice it paid.
   The link is the one the database uses for invoices.paid_amount, so the rows under an invoice
   always add up to what the invoice says is paid. */
import { describe, it, expect } from "vitest";
import {
  linkPaymentsToInvoices,
  invoicePaidAmount,
  invoiceStatusView,
  forInvoicesText,
  type LinkInvoice,
  type LinkPayment,
} from "./invoice-payment-links";

const inv = (o: Partial<LinkInvoice> & { id: string }): LinkInvoice => ({
  quote_id: null, amount: 10000, net_payable: null, paid_amount: 0, status: "pending",
  written_off_at: null, invoice_date: "2026-09-01", due_date: null, ...o,
});
const pay = (o: Partial<LinkPayment> & { id: string; amount: number }): LinkPayment => ({
  quote_id: null, invoice_id: null, status: "received", received_at: "2026-09-10T05:00:00Z", refunded_at: null, ...o,
});
const sum = (xs: { amount: number; counted: boolean }[]) => xs.filter((x) => x.counted).reduce((s, x) => s + x.amount, 0);

describe("R-2544 linkPaymentsToInvoices", () => {
  it("an invoice with 2 payments has both under it, oldest first", () => {
    const invoices = [inv({ id: "INV-1", quote_id: "Q-1", paid_amount: 10000, status: "paid" })];
    const payments = [
      pay({ id: "p2", quote_id: "Q-1", amount: 6000, received_at: "2026-09-20T05:00:00Z" }),
      pay({ id: "p1", quote_id: "Q-1", amount: 4000, received_at: "2026-09-05T05:00:00Z" }),
    ];
    const r = linkPaymentsToInvoices({ invoices, payments, quotes: [{ id: "Q-1", invoice_id: "INV-1" }], instalments: [] });
    expect(r.byInvoice["INV-1"].map((s) => [s.paymentId, s.amount])).toEqual([["p1", 4000], ["p2", 6000]]);
    expect(r.unlinked).toEqual([]);
    expect(sum(r.byInvoice["INV-1"])).toBe(invoicePaidAmount(invoices[0]));
    expect(r.forOf.p1).toEqual(["INV-1"]);
  });

  it("a receipt split over two invoices (R-1525 multi-invoice) shows under each with its own amount", () => {
    // record_multi_invoice_payment writes one payments row per invoice, same reference.
    const invoices = [
      inv({ id: "INV-A", quote_id: "Q-A", amount: 3000, paid_amount: 3000, status: "paid", invoice_date: "2026-08-01" }),
      inv({ id: "INV-B", quote_id: "Q-B", amount: 5000, paid_amount: 2000, invoice_date: "2026-08-15" }),
    ];
    const payments = [
      pay({ id: "pa", quote_id: "Q-A", amount: 3000, reference: "UTR123" }),
      pay({ id: "pb", quote_id: "Q-B", amount: 2000, reference: "UTR123" }),
    ];
    const r = linkPaymentsToInvoices({ invoices, payments, quotes: [{ id: "Q-A", invoice_id: "INV-A" }, { id: "Q-B", invoice_id: "INV-B" }], instalments: [] });
    expect(r.byInvoice["INV-A"].map((s) => s.amount)).toEqual([3000]);
    expect(r.byInvoice["INV-B"].map((s) => s.amount)).toEqual([2000]);
    expect(sum(r.byInvoice["INV-B"])).toBe(invoicePaidAmount(invoices[1]));
  });

  it("one subscription receipt over two instalment invoices splits oldest first, capped at what each invoice shows paid", () => {
    const invoices = [
      inv({ id: "INV-I1", amount: 3000, paid_amount: 3000, status: "paid", invoice_date: "2026-07-01" }),
      inv({ id: "INV-I2", amount: 3000, paid_amount: 1000, invoice_date: "2026-08-01" }),
    ];
    const payments = [pay({ id: "p", quote_id: "Q-S", amount: 4000 })];
    const r = linkPaymentsToInvoices({
      invoices, payments, quotes: [{ id: "Q-S", invoice_id: null }],
      instalments: [{ invoice_id: "INV-I1", quote_id: "Q-S" }, { invoice_id: "INV-I2", quote_id: "Q-S" }],
    });
    expect(r.byInvoice["INV-I1"]).toEqual([expect.objectContaining({ paymentId: "p", amount: 3000, whole: false, paymentAmount: 4000 })]);
    expect(r.byInvoice["INV-I2"]).toEqual([expect.objectContaining({ paymentId: "p", amount: 1000, whole: false })]);
    expect(r.forOf.p).toEqual(["INV-I1", "INV-I2"]);
    for (const i of invoices) expect(sum(r.byInvoice[i.id])).toBe(invoicePaidAmount(i));
  });

  it("an advance (quote not yet invoiced) and an advance holder go to the advance group, with the quote", () => {
    const invoices = [inv({ id: "INV-1", quote_id: "Q-1", paid_amount: 0 })];
    const payments = [
      pay({ id: "adv", quote_id: "Q-2", amount: 2500 }),
      pay({ id: "hold", quote_id: "Q-ADV", amount: 900 }),
    ];
    const r = linkPaymentsToInvoices({ invoices, payments, quotes: [{ id: "Q-1", invoice_id: "INV-1" }, { id: "Q-2", invoice_id: null }], instalments: [] });
    expect(r.byInvoice["INV-1"] ?? []).toEqual([]);
    expect(r.unlinked.map((s) => [s.paymentId, s.quoteId, s.amount])).toEqual([["adv", "Q-2", 2500], ["hold", "Q-ADV", 900]]);
    expect(r.forOf.adv).toEqual([]);
    expect(forInvoicesText(r.forOf.adv)).toBe("Advance");
  });

  it("money beyond what the invoice shows paid (overpayment → customer credit) goes to the advance group", () => {
    const invoices = [inv({ id: "INV-1", quote_id: "Q-1", amount: 1000, paid_amount: 1000, status: "paid" })];
    const r = linkPaymentsToInvoices({ invoices, payments: [pay({ id: "p", quote_id: "Q-1", amount: 1200 })], quotes: [{ id: "Q-1", invoice_id: "INV-1" }], instalments: [] });
    expect(r.byInvoice["INV-1"].map((s) => s.amount)).toEqual([1000]);
    expect(r.unlinked.map((s) => [s.paymentId, s.amount, s.quoteId])).toEqual([["p", 200, "Q-1"]]);
  });

  it("a Zoho-imported invoice's receipt (R-2542: invoice_id, no quote) is nested under it, with its TDS inside the amount", () => {
    const invoices = [inv({ id: "INV/25-26/1913", amount: 89208, paid_amount: 89208, status: "paid" })];
    const payments = [pay({ id: "rv", invoice_id: "INV/25-26/1913", amount: 89208 })];
    const r = linkPaymentsToInvoices({ invoices, payments, quotes: [], instalments: [] });
    expect(r.byInvoice["INV/25-26/1913"].map((s) => [s.paymentId, s.amount, s.whole])).toEqual([["rv", 89208, true]]);
    expect(sum(r.byInvoice["INV/25-26/1913"])).toBe(invoicePaidAmount(invoices[0]));
  });

  it("an advance taken before the invoice and folded into it (net_payable) still counts under that invoice", () => {
    const invoices = [inv({ id: "INV-1", quote_id: "Q-1", amount: 10000, net_payable: 6000, paid_amount: 2000 })];
    const payments = [
      pay({ id: "a", quote_id: "Q-1", amount: 4000, received_at: "2026-08-01T05:00:00Z" }),
      pay({ id: "b", quote_id: "Q-1", amount: 2000 }),
    ];
    const r = linkPaymentsToInvoices({ invoices, payments, quotes: [{ id: "Q-1", invoice_id: "INV-1" }], instalments: [] });
    expect(invoicePaidAmount(invoices[0])).toBe(6000);
    expect(sum(r.byInvoice["INV-1"])).toBe(6000);
  });

  it("a refunded payment stays visible under its invoice but adds nothing to the paid total", () => {
    const invoices = [inv({ id: "INV-1", quote_id: "Q-1", paid_amount: 0 })];
    const r = linkPaymentsToInvoices({ invoices, payments: [pay({ id: "r", quote_id: "Q-1", amount: 500, status: "refunded" })], quotes: [{ id: "Q-1", invoice_id: "INV-1" }], instalments: [] });
    expect(r.byInvoice["INV-1"]).toEqual([expect.objectContaining({ paymentId: "r", amount: 500, counted: false })]);
    expect(sum(r.byInvoice["INV-1"])).toBe(0);
  });
});

describe("R-2544 invoiceStatusView", () => {
  const today = "2026-11-07";
  it("Paid / Part-paid (₹X due) / Overdue / Void", () => {
    expect(invoiceStatusView(inv({ id: "a", status: "paid", paid_amount: 10000 }), today).label).toBe("Paid");
    expect(invoiceStatusView(inv({ id: "b", paid_amount: 4000 }), today).label).toBe("Part-paid (₹6,000 due)");
    expect(invoiceStatusView(inv({ id: "c", due_date: "2026-10-01" }), today).label).toBe("Overdue");
    expect(invoiceStatusView(inv({ id: "d", due_date: "2026-10-01", paid_amount: 4000 }), today).label).toBe("Overdue (₹6,000 due)");
    expect(invoiceStatusView(inv({ id: "e", status: "void" }), today).label).toBe("Void");
    expect(invoiceStatusView(inv({ id: "f" }), today).label).toBe("Unpaid");
    expect(invoiceStatusView(inv({ id: "g", written_off_at: "2026-10-01T00:00:00Z" }), today).label).toBe("Written off");
  });
});

describe("R-2544 forInvoicesText", () => {
  it("names up to two invoices, then +N", () => {
    expect(forInvoicesText(["INV-1"])).toBe("INV-1");
    expect(forInvoicesText(["INV-1", "INV-2", "INV-3"])).toBe("INV-1, INV-2 +1");
  });
});
