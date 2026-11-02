/* R-2360 — the Zoho invoice number reaches the server only when there is one (old callers resolve to
   the old SQL signatures), and a sale billed in parts gets it on its first part's invoice. */
import { describe, it, expect, vi } from "vitest";
import { keepZohoNumberOnFirstPart, newSaleArgs } from "./bank-credit-pay-for";
import { splitArgs } from "@/lib/banking/credit-pay-for-multi";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const sale = {
  transactionId: "t", customerId: "c1", createSubscription: false, subStart: null, subRenewal: null, tdsAmount: 0, tdsRatePct: null,
  lines: [{ itemId: null, name: "Setup", qty: 1, rate: 1000, cost: 0, cycle: "one_time" as const, perSeat: false }],
};
const res = (o: Partial<PayForResult> & Record<string, unknown>) => ({ kind: "new", quote_id: "Q-1", invoice_id: null, invoice_issued: null, ...o }) as unknown as PayForResult & { external_number?: string | null; external_number_saved?: boolean };

describe("R-2360 arguments", () => {
  it("new sale: p_external_number only when given (trimmed)", () => {
    expect(newSaleArgs(sale)).not.toHaveProperty("p_external_number");
    expect(newSaleArgs({ ...sale, externalNumber: "  " })).not.toHaveProperty("p_external_number");
    expect(newSaleArgs({ ...sale, externalNumber: " INV/26-27/0613 " })).toMatchObject({ p_external_number: "INV/26-27/0613" });
  });
  it("split: only with a new sale", () => {
    const base = { transactionId: "t", customerId: "c1", items: [{ quote_id: null, invoice_id: "INV-9", amount: 100 }], rest: null, externalNumber: "INV/26-27/0700" };
    expect(splitArgs({ ...base, sale: null })).not.toHaveProperty("p_external_number");
    expect(splitArgs({ ...base, sale: { lines: [], billingCycle: "yearly", createSubscription: false, subStart: null, subRenewal: null, amount: 100 } }))
      .toMatchObject({ p_external_number: "INV/26-27/0700" });
  });
});

describe("R-2360 first part's invoice of a sale billed in parts", () => {
  it("saved later on the raised invoice", async () => {
    const call = vi.fn(async () => ({ data: {}, error: null }));
    const r = await keepZohoNumberOnFirstPart(res({ invoice_issued: "INV-7", external_number: "INV/26-27/0900", external_number_saved: false }), call);
    expect(call).toHaveBeenCalledWith("set_invoice_external_number", { p_invoice_id: "INV-7", p_external_number: "INV/26-27/0900" });
    expect(r.external_number_saved).toBe(true);
  });
  it("already saved, no number, or no invoice raised → no call", async () => {
    const call = vi.fn(async () => ({ data: {}, error: null }));
    await keepZohoNumberOnFirstPart(res({ invoice_issued: "INV-7", external_number: "X", external_number_saved: true }), call);
    await keepZohoNumberOnFirstPart(res({ invoice_issued: "INV-7" }), call);
    await keepZohoNumberOnFirstPart(res({ external_number: "X", external_number_saved: false }), call);
    expect(call).not.toHaveBeenCalled();
  });
  it("a refusal (number already in the app) is reported on the result, the sale stays booked", async () => {
    const call = vi.fn(async () => ({ data: null, error: { message: "Zoho invoice X is already in the app as INV-1. Nothing was saved." } }));
    const r = await keepZohoNumberOnFirstPart(res({ invoice_issued: "INV-7", external_number: "X", external_number_saved: false }), call);
    expect(r).toMatchObject({ external_number_saved: false, external_number_error: "Zoho invoice X is already in the app as INV-1. Nothing was saved." });
  });
});
