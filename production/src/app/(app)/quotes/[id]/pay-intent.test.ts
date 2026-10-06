/**
 * R-243: one click from anywhere to the Record-payment dialog, amount filled.
 *  - /quotes/<id>?pay=1 opens the dialog when the quote takes a payment;
 *  - Ctrl+K "Record a payment" opens the invoices still owed, not the whole list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { payIntent, quoteTotal, type PayIntentQuote } from "./pay-intent";

const q = (over: Partial<PayIntentQuote> = {}): PayIntentQuote => ({
  status: "accepted", payment_status: "awaiting", invoice_id: null,
  amount: 11_800, subtotal: 10_000, discount_pct: 0, tax_rate: 18, ...over,
});

describe("R-243 ?pay=1 on a quote", () => {
  it("accepted, unpaid → open", () => {
    expect(payIntent("1", q(), 0)).toBe("open");
  });

  it("part paid → open (balance payment)", () => {
    expect(payIntent("1", q({ payment_status: "partial" }), 5_000)).toBe("open");
  });

  it("waits while the quote or its payments are loading", () => {
    expect(payIntent("1", undefined, 0)).toBe("none");
    expect(payIntent("1", q(), null)).toBe("none");
  });

  it("draft, closed or invoiced quote → the param is dropped, no dialog", () => {
    expect(payIntent("1", q({ status: "draft" }), 0)).toBe("drop");
    expect(payIntent("1", q({ invoice_id: "inv-1" }), 0)).toBe("drop");
    expect(payIntent("1", q({ status: "rejected" }), 0)).toBe("drop");
  });

  it("no ?pay=1 → nothing", () => {
    expect(payIntent(null, q(), 0)).toBe("none");
    expect(payIntent("0", q(), 0)).toBe("none");
  });

  it("quoteTotal: stored amount, else subtotal − discount + GST", () => {
    expect(quoteTotal({ amount: 999, subtotal: 1, discount_pct: 0, tax_rate: 0 })).toBe(999);
    expect(quoteTotal({ amount: null, subtotal: 10_000, discount_pct: 10, tax_rate: 18 })).toBe(10_620);
  });

  it("the quote page reads ?pay= and opens the payment dialog", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/searchParams\.get\("pay"\)/);
    expect(src).toMatch(/payIntent\(/);
    expect(src).toMatch(/setPaymentOpen\(true\)/);
  });
});

describe("R-243 Ctrl+K 'Record a payment'", () => {
  it("opens the invoices still owed, not the bare list", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/command-palette.tsx"), "utf8");
    const line = src.split("\n").find((l) => l.includes('label: "Record a payment"')) ?? "";
    expect(line).toContain('href: "/invoices?focus=unpaid"');
  });
});
