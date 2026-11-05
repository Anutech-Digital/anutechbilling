/**
 * R-2494 — Reconcile from Zoho on real Zoho data (5 Nov staging, Excel 4523): every fully-paid last
 * year's invoice was refused with "does not add up: total ₹X, receipts and credits ₹0, balance ₹0".
 * Zoho's GET /invoices/{id} (official v3 reference, invoices.yml get-an-invoice-response) carries only
 * the totals payment_made / credits_applied / balance — NO payments or credits list. The dated lists
 * are GET /invoices/{id}/payments and GET /invoices/{id}/creditsapplied (credits: amount_applied).
 * Fixtures below are shaped like those documented responses; names and amounts are made up.
 */
import { describe, it, expect } from "vitest";
import { readZohoPaymentMatch } from "./payment-match";
import { openingFromZoho } from "./opening-from-zoho";

type Body = Record<string, unknown>;

/** A fake Zoho: path (without query) → JSON body; every call is recorded. */
function fakeZoho(routes: Record<string, Body>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/books\/v3/, "");
    calls.push(path);
    const body = routes[path];
    if (!body) return new Response(JSON.stringify({ code: 1002, message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ code: 0, message: "success", ...body }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const payment = (invoices: Body[], over: Body = {}): Body => ({
  payment: {
    payment_id: "zp-1", payment_number: "PAY-1", date: "2026-04-03", amount: 59000, reference_number: "UTR77",
    customer_id: "zc-1", customer_name: "Acme Tools", currency_code: "INR", invoices, ...over,
  },
});
/** GET /invoices/{id} as the reference documents it: totals only, no payments / credits arrays. */
const invoiceDetail = (over: Body = {}): Body => ({
  invoice: {
    invoice_id: "zi-1", invoice_number: "INV/25-26/0412", date: "2025-12-01", due_date: "2026-01-15",
    currency_code: "INR", gst_no: "07AAACT1234A1Z3", place_of_supply: "DL", line_items: [],
    total: 59000, payment_made: 59000, credits_applied: 0, tax_amount_withheld: 0, write_off_amount: 0, balance: 0,
    ...over,
  },
});
const deps = (f: typeof fetch) => ({ orgId: "org-1", token: "tok", fetch: f });

describe("R-2494 readZohoPaymentMatch: the invoice's receipts when Zoho's invoice detail has no payments list", () => {
  it("paid in full by THIS payment (payment_made = this payment's amount applied) → this payment is its one receipt, no extra Zoho call", async () => {
    const z = fakeZoho({
      "/customerpayments/zp-1": payment([{ invoice_id: "zi-1", invoice_number: "INV/25-26/0412", amount_applied: 59000, tax_amount_withheld: 0 }]),
      "/invoices/zi-1": invoiceDetail(),
    });
    const m = await readZohoPaymentMatch("zp-1", "utr", deps(z.f));
    expect(z.calls).toEqual(["/customerpayments/zp-1", "/invoices/zi-1"]);
    expect(m.invoices[0].history?.payments).toEqual([{ paymentId: "zp-1", date: "2026-04-03", amount: 59000, tds: 0 }]);
    expect(m.invoices[0].history?.credits).toEqual([]);
    /* The staging refusal ("does not add up … receipts and credits ₹0") is gone: ₹59,000 was due on 1 Apr. */
    const out = openingFromZoho(m.invoices[0], "2026-04-01", "zp-1");
    expect(out).toMatchObject({ ok: true, create: { number: "INV/25-26/0412", total: 59000, balance: 59000 } });
  });

  it("this payment carries TDS on the invoice → its receipt is cash + TDS", async () => {
    const z = fakeZoho({
      "/customerpayments/zp-1": payment([{ invoice_id: "zi-1", invoice_number: "INV/25-26/0412", amount_applied: 58000, tax_amount_withheld: 1000 }], { amount: 58000 }),
      "/invoices/zi-1": invoiceDetail({ payment_made: 58000, tax_amount_withheld: 1000 }),
    });
    const m = await readZohoPaymentMatch("zp-1", "utr", deps(z.f));
    expect(m.invoices[0].history?.payments).toEqual([{ paymentId: "zp-1", date: "2026-04-03", amount: 58000, tds: 1000 }]);
    expect(openingFromZoho(m.invoices[0], "2026-04-01", "zp-1")).toMatchObject({ ok: true, create: { balance: 59000 } });
  });

  it("other receipts too (payment_made > this payment) → reads GET /invoices/{id}/payments for their dates", async () => {
    const z = fakeZoho({
      "/customerpayments/zp-1": payment([{ invoice_id: "zi-1", invoice_number: "INV/25-26/0412", amount_applied: 29000 }], { amount: 29000 }),
      "/invoices/zi-1": invoiceDetail(),
      "/invoices/zi-1/payments": {
        payments: [
          { payment_id: "zp-0", payment_number: 6, invoice_id: "zi-1", invoice_payment_id: "ip-0", payment_mode: "banktransfer", date: "2026-02-10", amount: 30000, tax_amount_withheld: 0, is_single_invoice_payment: true },
          { payment_id: "zp-1", payment_number: 7, invoice_id: "zi-1", invoice_payment_id: "ip-1", payment_mode: "banktransfer", date: "2026-04-03", amount: 29000, tax_amount_withheld: 0, is_single_invoice_payment: true },
        ],
      },
    });
    const m = await readZohoPaymentMatch("zp-1", "utr", deps(z.f));
    expect(z.calls).toContain("/invoices/zi-1/payments");
    expect(m.invoices[0].history?.payments).toEqual([
      { paymentId: "zp-0", date: "2026-02-10", amount: 30000, tds: 0 },
      { paymentId: "zp-1", date: "2026-04-03", amount: 29000, tds: 0 },
    ]);
    expect(openingFromZoho(m.invoices[0], "2026-04-01", "zp-1")).toMatchObject({ ok: true, create: { balance: 29000 } });
  });

  it("credits applied (credits_applied > 0, no credits list) → reads GET /invoices/{id}/creditsapplied (amount_applied)", async () => {
    const z = fakeZoho({
      "/customerpayments/zp-1": payment([{ invoice_id: "zi-1", invoice_number: "INV/25-26/0412", amount_applied: 49000 }], { amount: 49000 }),
      "/invoices/zi-1": invoiceDetail({ payment_made: 49000, credits_applied: 10000 }),
      "/invoices/zi-1/creditsapplied": {
        credits: [{ creditnote_id: "cn-1", creditnotes_invoice_id: "cni-1", creditnotes_number: "CN-00001", credited_date: "2026-03-01", amount_applied: 10000 }],
      },
    });
    const m = await readZohoPaymentMatch("zp-1", "utr", deps(z.f));
    expect(z.calls).not.toContain("/invoices/zi-1/payments");
    expect(m.invoices[0].history?.credits).toEqual([{ date: "2026-03-01", amount: 10000 }]);
    expect(openingFromZoho(m.invoices[0], "2026-04-01", "zp-1")).toMatchObject({ ok: true, create: { balance: 49000 } });
  });

  it("a detail that DOES carry a payments list is used as it is (no extra call)", async () => {
    const z = fakeZoho({
      "/customerpayments/zp-1": payment([{ invoice_id: "zi-1", invoice_number: "INV/25-26/0412", amount_applied: 59000 }]),
      "/invoices/zi-1": invoiceDetail({ payments: [{ payment_id: "zp-1", date: "2026-04-03", amount: 59000 }], credits: [] }),
    });
    const m = await readZohoPaymentMatch("zp-1", "utr", deps(z.f));
    expect(z.calls).toEqual(["/customerpayments/zp-1", "/invoices/zi-1"]);
    expect(m.invoices[0].history?.payments).toEqual([{ paymentId: "zp-1", date: "2026-04-03", amount: 59000, tds: 0 }]);
  });
});

describe("R-2494 openingFromZoho: this bank line's own payment always counts in the add-up check", () => {
  it("Zoho's list leaves this payment out but the gap is exactly its amount applied → adds up, not refused", () => {
    const inv = {
      zohoId: "zi-1", number: "INV/25-26/0412", date: "2025-12-01", amountApplied: 59000, tdsApplied: 0, total: 59000, lines: [],
      history: { dueDate: null, currency: "INR", balance: 0, writeOff: 0, gstin: null, placeOfSupply: "07", payments: [], credits: [] },
    };
    expect(openingFromZoho(inv, "2026-04-01", "zp-1")).toMatchObject({ ok: true, create: { balance: 59000 } });
  });

  it("a gap that is NOT this payment's amount still refuses (never a guessed balance)", () => {
    const inv = {
      zohoId: "zi-1", number: "INV/25-26/0412", date: "2025-12-01", amountApplied: 40000, tdsApplied: 0, total: 59000, lines: [],
      history: { dueDate: null, currency: "INR", balance: 0, writeOff: 0, gstin: null, placeOfSupply: "07", payments: [], credits: [] },
    };
    expect(openingFromZoho(inv, "2026-04-01", "zp-1")).toMatchObject({ ok: false, problem: expect.stringMatching(/does not add up/) });
  });
});
