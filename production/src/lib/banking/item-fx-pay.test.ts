/* R-2466 — Reconcile sheet "An open quote / invoice": what paying the picked item does, before Save.
   Owner's example (scenario usd-inw-lines): SCN Timbergloss Inc's INV-SCN-USD-1 is $2,000 raised at
   ₹84.00 (₹1,68,000 due); the bank line "INW … USD2000.0@88.5" credits ₹1,77,000 → the invoice is
   settled in full through R-2427's reconcile_bank_credit_fx_invoice, ₹9,000 forex gain. */
import { describe, expect, it } from "vitest";
import { itemPayPlan, itemFxText } from "./item-fx-pay";

const usd = { kind: "invoice" as const, invoice_id: "INV-SCN-USD-1", quote_id: "Q-SCN-USD-1", amount_due: 168000, currency: "USD", fx_rate: 84 };
const inw = (d: string, credit: number) => ({ description: d, credit });

describe("R-2466 itemPayPlan", () => {
  it("owner's example: a USD invoice paid by its USD remittance → fx path, ₹9,000 forex gain", () => {
    const p = itemPayPlan(usd, inw("INW 041126I0SCN0000022 USD2000.0@88.5 SCN TIMBERGLOSS INC", 177000));
    expect(p.problem).toBeNull();
    expect(p.fx).toEqual({ currency: "USD", rate: 88.5, foreignAmount: 2000, invoiceRate: 84, foreignDue: 2000, bankCharges: 0, forex: -9000 });
    expect(itemFxText("INV-SCN-USD-1", p.fx!)).toBe(
      "Export receipt $2,000 @ ₹88.50 settles INV-SCN-USD-1 in full ($2,000 due at ₹84 = ₹1,68,000) — ₹9,000 forex gain on the bank line's date.");
  });

  it("a short remittance (bank kept $24) → Bank Charges, no TDS", () => {
    const p = itemPayPlan({ ...usd, amount_due: 95846, fx_rate: 93.6 }, inw("INW X USD1000.0@93.6", 93600));
    expect(p.fx).toMatchObject({ bankCharges: 2246, forex: 0, foreignDue: 1024 });
    expect(itemFxText("INV-1", p.fx!)).toContain("₹2,246 Bank Charges (remitting bank)");
  });

  it("a USD invoice with no USD amount + rate in the narration is not booked in ₹", () => {
    const p = itemPayPlan(usd, inw("NEFT CR TIMBERGLOSS", 177000));
    expect(p.fx).toBeNull();
    expect(p.problem).toMatch(/INV-SCN-USD-1 is in USD, but this bank line's narration has no USD amount and rate/);
  });

  it("another currency, or more than 5% short, is refused with the reason", () => {
    expect(itemPayPlan(usd, inw("INW X EUR2000.0@88.5", 177000)).problem).toMatch(/came in EUR/);
    expect(itemPayPlan(usd, inw("INW X USD1500.0@88.5", 132750)).problem).toMatch(/more than bank charges/);
  });

  it("a relink books in ₹ only — a foreign invoice is refused there", () => {
    expect(itemPayPlan(usd, inw("INW X USD2000.0@88.5", 177000), { relink: true }).problem).toMatch(/relink/i);
  });

  it("a ₹ item: nothing special", () => {
    expect(itemPayPlan({ ...usd, currency: "INR", fx_rate: null }, inw("NEFT", 5000))).toEqual({ fx: null, problem: null });
    expect(itemPayPlan({ ...usd, currency: undefined, fx_rate: undefined }, inw("NEFT", 5000))).toEqual({ fx: null, problem: null });
  });

  it("a Zoho opening invoice takes no more than its due (no customer credit on it)", () => {
    const opening = { kind: "opening" as const, invoice_id: "OPN-1", quote_id: null, amount_due: 1800, currency: "INR", fx_rate: null };
    expect(itemPayPlan(opening, inw("NEFT", 1800)).problem).toBeNull();
    expect(itemPayPlan(opening, inw("NEFT", 1700)).problem).toBeNull();
    expect(itemPayPlan(opening, inw("NEFT", 5000)).problem).toBe(
      "OPN-1 is last year's invoice from Zoho with ₹1,800 due — it takes no more. Choose \"Several quotes / invoices\" and keep the rest as advance.");
  });
});
