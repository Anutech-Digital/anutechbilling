import { describe, it, expect } from "vitest";
import { cancelDueSplit, openInvoiceDue } from "./cancel-due";

const inv = (id: string, over: Partial<Parameters<typeof openInvoiceDue>[0]> = {}) => ({
  id, status: "pending", amount: 1180, net_payable: 1180, paid_amount: 0, written_off_at: null, ...over,
});

describe("R-1711 cancelDueSplit — a due on an open invoice is never cleared", () => {
  it("T-A1: ₹18,232 owed, INV-0013 open for ₹18,232 → nothing clearable, credit note needed", () => {
    const s = cancelDueSplit(18232, [inv("INV-0013", { amount: 18232, net_payable: 18232 })]);
    expect(s).toEqual({ owed: 18232, onInvoices: 18232, clearable: 0, openInvoices: [{ id: "INV-0013", due: 18232 }] });
  });

  it("after a full credit note the invoice asks for nothing → the whole due is clearable", () => {
    const s = cancelDueSplit(18232, [inv("INV-0013", { amount: 18232, net_payable: 0, status: "paid" })]);
    expect(s.clearable).toBe(18232);
    expect(s.openInvoices).toEqual([]);
  });

  it("part on an invoice → only the rest is clearable", () => {
    const s = cancelDueSplit(1500, [inv("INV-1", { paid_amount: 180 })]);
    expect(s.onInvoices).toBe(1000);
    expect(s.clearable).toBe(500);
  });

  it("no invoice (postpaid) → all of it clearable, as before", () => {
    expect(cancelDueSplit(956, []).clearable).toBe(956);
  });

  it("paid, void, draft and written-off invoices ask for nothing", () => {
    expect(openInvoiceDue(inv("a", { status: "paid" }))).toBe(0);
    expect(openInvoiceDue(inv("b", { status: "void" }))).toBe(0);
    expect(openInvoiceDue(inv("c", { status: "draft" }))).toBe(0);
    expect(openInvoiceDue(inv("d", { written_off_at: "2026-10-20T00:00:00Z" }))).toBe(0);
    expect(openInvoiceDue(inv("e", { status: "overdue", net_payable: null, amount: 590 }))).toBe(590);
  });

  it("invoice asks for more than the subscription's balance → onInvoices capped at the balance", () => {
    const s = cancelDueSplit(500, [inv("X", { amount: 2360, net_payable: 2360 })]);
    expect(s).toMatchObject({ onInvoices: 500, clearable: 0 });
  });
});
