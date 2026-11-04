/* R-2466 — "An open quote / invoice" on an export receipt: a USD invoice paid by its USD inward
   remittance goes through R-2427's reconcile_bank_credit_fx_invoice (the invoice's whole ₹ due, the
   forex / Bank Charges lines), never the ₹ reconcile_bank_credit_to_item (which would keep ₹9,000 of
   a $2,000 payment as customer credit). A ₹ item is unchanged. */
import { describe, expect, it, vi } from "vitest";
import { payItemCall } from "./bank-credit-pay-for";

const base = {
  transactionId: "t-22", quoteId: "Q-SCN-USD-1", invoiceId: "INV-SCN-USD-1", tdsAmount: 0, tdsRatePct: null,
  createSubscription: null, subStart: null, subRenewal: null,
};
const fx = { currency: "USD", rate: 88.5, foreignAmount: 2000, invoiceRate: 84, foreignDue: 2000, bankCharges: 0, forex: -9000 };

describe("R-2466 payItemCall", () => {
  it("owner's example: INV-SCN-USD-1 + 'USD2000.0@88.5' → reconcile_bank_credit_fx_invoice with the narration's figures", async () => {
    const call = vi.fn(async () => ({ data: { kind: "one_off", payment_id: "p1", forex_difference: -9000 }, error: null }));
    const r = await payItemCall({ ...base, fx }, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("reconcile_bank_credit_fx_invoice", {
      p_txn_id: "t-22", p_invoice_id: "INV-SCN-USD-1", p_currency: "USD", p_fx_rate: 88.5, p_foreign_amount: 2000,
      p_create_subscription: null, p_sub_start: null,
    });
    expect(r.payment_id).toBe("p1");
  });

  it("a foreign receipt never carries TDS (a customer abroad deducts none)", async () => {
    const call = vi.fn();
    await expect(payItemCall({ ...base, fx, tdsAmount: 500 }, call)).rejects.toThrow(/deducts no Indian TDS/);
    expect(call).not.toHaveBeenCalled();
  });

  it("a ₹ item → reconcile_bank_credit_to_item as before", async () => {
    const call = vi.fn(async () => ({ data: { kind: "opening", payment_id: "p2" }, error: null }));
    await payItemCall({ ...base, quoteId: null, invoiceId: "OPN-1" }, call);
    expect(call).toHaveBeenCalledWith("reconcile_bank_credit_to_item", expect.objectContaining({ p_invoice_id: "OPN-1", p_quote_id: null }));
  });

  it("a server refusal is thrown (the hook toasts it)", async () => {
    const call = vi.fn(async () => ({ data: null, error: { message: "Invoice X is paid" } }));
    await expect(payItemCall({ ...base, fx }, call)).rejects.toMatchObject({ message: "Invoice X is paid" });
  });
});
