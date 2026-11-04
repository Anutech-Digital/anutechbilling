/**
 * R-2427 (3) — the Reconcile sheet: Save of a Find-in-Zoho USD bill (filled in ₹ at the bank's rate,
 * R-2425) books the sale IN USD with the narration's figures (reconcile_bank_credit_new_sale_fx), so
 * the invoice no longer stays INR. Pure; Zoho is never called.
 */
import { describe, it, expect, vi } from "vitest";
import { prefillSaleFx, zohoPrefill } from "./payment-prefill";
import type { ZohoPaymentMatch } from "./payment-match";
import { newSaleFxRpcArgs } from "@/lib/queries/bank-credit-pay-for";

const customers = [{ id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States" }];
const usd = (amount: number, currency: string | undefined = "USD"): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "p", number: "9001", date: "2026-08-07", amount, reference: "", customerZohoId: "z", customerName: "Design Box", currency, exchangeRate: 93.6 },
  customer: { zohoId: "z", name: "Design Box", gstin: null },
  invoices: [{ zohoId: "i", number: "INV/26-27/0501", date: "2026-08-01", amountApplied: amount, total: amount, lines: [
    { invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: amount, itemTotal: null, start: null, end: null, months: 0, domain: null },
  ] }],
  moreInvoices: [],
});
const narration = "INW 070826I049902623 USD1024.0@93.6";

describe("R-2427 (3): Find in Zoho → Save books the sale in USD", () => {
  it("$1,024 filled at the bank's rate → Save sends USD 1024 @ 93.6 (the narration's)", () => {
    const p = zohoPrefill(usd(1024), { customers, catalog: [], txnDate: "2026-08-07", credit: 95846 });
    expect(p.fx).toEqual({ currency: "USD", zohoAmount: 1024 });
    expect(p.notes.join(" ")).toContain("Save books the sale in USD");
    expect(prefillSaleFx(p, narration, 95846)).toEqual({ currency: "USD", rate: 93.6, foreignAmount: 1024 });
  });

  it("stays a ₹ sale: a bill in ₹, no rate in the narration, or a narration that is not Zoho's amount", () => {
    const inr = zohoPrefill(usd(95846, undefined), { customers, catalog: [], txnDate: "2026-08-07", credit: 95846 });
    expect(inr.fx ?? null).toBeNull();
    expect(prefillSaleFx(inr, narration, 95846)).toBeNull();
    const p = zohoPrefill(usd(1024), { customers, catalog: [], txnDate: "2026-08-07", credit: 95846 });
    expect(prefillSaleFx(p, "NEFT CR-CITI-DESIGN BOX", 95846)).toBeNull();
    expect(prefillSaleFx(p, "INW 070826I049902623 USD1000.0@95.846", 95846)).toBeNull();
    expect(prefillSaleFx(null, narration, 95846)).toBeNull();
  });

  it("a short remittance (prices left in USD) is never saved in USD from the sheet", () => {
    const p = zohoPrefill(usd(1024), { customers, catalog: [], txnDate: "2026-08-07", credit: 93600 });
    expect(p.fx ?? null).toBeNull();
    expect(prefillSaleFx(p, "INW 070826I049902623 USD1000.0@93.6", 93600)).toBeNull();
  });

  it("newSaleFxRpcArgs: the 11 arguments of reconcile_bank_credit_new_sale_fx — no TDS, Zoho number kept", () => {
    const a = newSaleFxRpcArgs({
      transactionId: "t", customerId: "c", lines: [], createSubscription: false, subStart: null, subRenewal: null,
      tdsAmount: 0, tdsRatePct: null, billingCycle: null, externalNumber: " INV/26-27/0501 ",
    }, { currency: "USD", rate: 93.6, foreignAmount: 1024 });
    expect(Object.keys(a).sort()).toEqual([
      "p_billing_cycle", "p_create_subscription", "p_currency", "p_customer_id", "p_external_number", "p_foreign_amount",
      "p_fx_rate", "p_lines", "p_sub_renewal", "p_sub_start", "p_txn_id",
    ]);
    expect(a).toMatchObject({ p_currency: "USD", p_fx_rate: 93.6, p_foreign_amount: 1024, p_external_number: "INV/26-27/0501" });
  });
});

describe("R-2427 (3): the sheet's new-sale save with fx goes to the foreign-currency RPC", () => {
  const sale = {
    transactionId: "t", customerId: "c", lines: [], createSubscription: false, subStart: null, subRenewal: null,
    tdsAmount: 0, tdsRatePct: null, billingCycle: null, externalNumber: "INV/26-27/0501",
  };
  const fx = { currency: "USD", rate: 93.6, foreignAmount: 1024 };
  it("calls reconcile_bank_credit_new_sale_fx with the narration's figures", async () => {
    const { newSaleInCurrency } = await import("@/lib/queries/bank-credit-pay-for");
    const call = vi.fn(async () => ({ data: { quote_id: "Q-1" }, error: null }));
    await newSaleInCurrency(sale, fx, call);
    expect(call).toHaveBeenCalledWith("reconcile_bank_credit_new_sale_fx", expect.objectContaining({ p_currency: "USD", p_fx_rate: 93.6, p_foreign_amount: 1024 }));
  });
  it("refuses TDS or a sale billed in parts before any call", async () => {
    const { newSaleInCurrency } = await import("@/lib/queries/bank-credit-pay-for");
    const call = vi.fn(async () => ({ data: {}, error: null }));
    await expect(newSaleInCurrency({ ...sale, tdsAmount: 1000 }, fx, call)).rejects.toThrow("deducts no Indian TDS");
    await expect(newSaleInCurrency({ ...sale, billingCycle: "quarterly" }, fx, call)).rejects.toThrow("billed in parts");
    expect(call).not.toHaveBeenCalled();
  });
});
