// R-1639 (24 Oct 2026): the /payments search box did not find a payment by its receipt
// number (RV-…) or by the GST invoice it paid — the two numbers an accountant has in hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paymentMatchesSearch } from "./payment-search";

const pay = {
  quote_id: "Q-2026-0107",
  invoice_id: null,
  reference: "UTR998877",
  method: "bank_transfer",
  receipt_voucher_no: "RV-2026-0042",
  amount: 11800,
};
const ctx = { customerName: "Acme Pvt Ltd", invoiceNumber: "INV-2026-0031" };

describe("paymentMatchesSearch", () => {
  it("finds a payment by its receipt voucher number, any case", () => {
    expect(paymentMatchesSearch(pay, "RV-2026-0042", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "rv-2026-0042", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "0042", ctx)).toBe(true);
  });

  it("finds a payment by the invoice number it paid", () => {
    expect(paymentMatchesSearch(pay, "INV-2026-0031", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "inv-2026-0031", ctx)).toBe(true);
  });

  it("an imported invoice's own number (external_number) also finds it", () => {
    const zoho = { ...pay, quote_id: null, invoice_id: "b2c3", receipt_voucher_no: null };
    expect(paymentMatchesSearch(zoho, "ZB-118", { customerName: "Acme", invoiceNumber: "ZB-118" })).toBe(true);
  });

  it("still finds by quote, reference, method word and customer name", () => {
    expect(paymentMatchesSearch(pay, "Q-2026-0107", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "utr998877", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "bank", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "acme", ctx)).toBe(true);
  });

  it("finds by the amount typed, with or without commas", () => {
    expect(paymentMatchesSearch(pay, "11,800", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "11800", ctx)).toBe(true);
    expect(paymentMatchesSearch(pay, "11801", ctx)).toBe(false);
  });

  it("does not match something unrelated; blank matches all", () => {
    expect(paymentMatchesSearch(pay, "RV-2026-0099", ctx)).toBe(false);
    expect(paymentMatchesSearch(pay, "   ", ctx)).toBe(true);
  });
});

describe("the /payments page uses it", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/payments/page.tsx"), "utf8");
  it("the filter calls paymentMatchesSearch with the invoice number", () => {
    expect(page).toMatch(/paymentMatchesSearch\(p, search, \{[^}]*invoiceNumber: invoiceOf\(p\)\.invoiceNumber/);
  });
  it("the search box says what it searches", () => {
    expect(page).toMatch(/placeholder="Receipt \/ invoice no\., customer, amount…"/);
  });
});
