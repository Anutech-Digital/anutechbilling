import { describe, it, expect } from "vitest";
import { invoiceMarginMtd, type MarginInvoice } from "./margin-mtd";

// 9 Oct 2026, 12:00 IST
const NOW = new Date("2026-10-09T06:30:00Z");

const gw = (qty: number, cost: number | null, rate = 3240) =>
  ({ qty, rate, cost, item_id: "GW-STR", name: "Google Workspace Business Starter" });

const inv = (over: Partial<MarginInvoice>): MarginInvoice => ({
  status: "paid", invoice_date: "2026-10-07", amount: 38232, taxable_value: 32400, tax_amount: 5832,
  line_items: [gw(10, 1320)], ...over,
});

describe("R-405 invoiceMarginMtd — real margin from line cost", () => {
  it("₹32,400 taxable with ₹13,200 cost is ₹19,200 margin (not 17% of collection)", () => {
    const m = invoiceMarginMtd([inv({})], NOW);
    expect(m.margin).toBe(19200);
    expect(m.sales).toBe(32400);
    expect(m.costedSales).toBe(32400);
    expect(m.missingLines).toBe(0);
    expect(m.margin).not.toBe(Math.round(38232 * 0.17));
  });

  it("does not guess a line with no cost — counts it as missing instead", () => {
    const m = invoiceMarginMtd([inv({ taxable_value: 64800, line_items: [gw(10, 1320), gw(10, 0)] })], NOW);
    expect(m.sales).toBe(64800);
    expect(m.costedSales).toBe(32400);
    expect(m.margin).toBe(19200);
    expect(m.missingLines).toBe(1);
  });

  it("spreads an invoice-level discount across lines by their share", () => {
    const m = invoiceMarginMtd([inv({ taxable_value: 29160 })], NOW); // 10% off
    expect(m.costedSales).toBe(29160);
    expect(m.margin).toBe(29160 - 13200);
  });

  it("our own support line at ₹0 cost is a real ₹0, not missing", () => {
    const m = invoiceMarginMtd([inv({ taxable_value: 5000, line_items: [{ qty: 1, rate: 5000, cost: 0, item_id: "SUP-STANDARD-YR" }] })], NOW);
    expect(m.missingLines).toBe(0);
    expect(m.margin).toBe(5000);
  });

  it("leaves out void, draft, and invoices from other months (IST)", () => {
    const m = invoiceMarginMtd([
      inv({ status: "void" }),
      inv({ status: "draft" }),
      inv({ invoice_date: "2026-09-30" }),
    ], NOW);
    expect(m.invoiceCount).toBe(0);
    expect(m.margin).toBe(0);
  });

  it("counts an unpaid invoice issued this month — margin is earned on invoicing", () => {
    expect(invoiceMarginMtd([inv({ status: "pending", paid_date: null } as Partial<MarginInvoice>)], NOW).margin).toBe(19200);
  });

  it("an invoice with no lines is wholly uncosted", () => {
    const m = invoiceMarginMtd([inv({ line_items: null })], NOW);
    expect(m.sales).toBe(32400);
    expect(m.costedSales).toBe(0);
    expect(m.missingLines).toBe(1);
  });

  it("falls back to amount − tax when taxable_value is missing", () => {
    const m = invoiceMarginMtd([inv({ taxable_value: null })], NOW);
    expect(m.sales).toBe(32400);
    expect(m.margin).toBe(19200);
  });
});
