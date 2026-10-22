// R-1745 — whose payment is it? A payment on an imported Zoho invoice (R-1739) has no quote:
// payments.quote_id NULL, payments.invoice_id set. /payments used to name the customer from the
// quote only and showed "—" (localhost 22 Oct: ₹15,000 on INV-000245 for T-ABC Pvt Ltd).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paymentCustomerLookup, paymentInvoiceLookup } from "./payment-customer";

const CUST = "c-tabc";
const lookup = paymentCustomerLookup({
  quotes: [{ id: "Q-0101", customer_id: "c-acme", customer_name: "Acme Corp" }],
  invoices: [{ id: "INV-000245", customer_id: CUST, customer_name: "T-ABC Pvt Ltd" }],
  customers: [
    { id: CUST, name: "T-ABC Pvt Ltd" },
    { id: "c-acme", name: "Acme Corporation" },
    { id: "c-lead", name: "Converted Lead Ltd" },
  ],
});

describe("R-1745 paymentCustomerLookup", () => {
  it("owner's example: ₹15,000 on INV-000245, no quote → T-ABC Pvt Ltd (linked to the customer)", () => {
    const p = { quote_id: null, invoice_id: "INV-000245", customer_id: null, amount: 15000 };
    expect(lookup(p)).toEqual({ customerId: CUST, customerName: "T-ABC Pvt Ltd" });
  });

  it("the imported invoice's name is used even when the customers list has not loaded", () => {
    const bare = paymentCustomerLookup({
      quotes: [],
      invoices: [{ id: "INV-000245", customer_id: CUST, customer_name: "T-ABC Pvt Ltd" }],
      customers: [],
    });
    expect(bare({ quote_id: null, invoice_id: "INV-000245" })).toEqual({ customerId: CUST, customerName: "T-ABC Pvt Ltd" });
  });

  it("a quote payment still reads the quote's customer (the customer record's current name first)", () => {
    expect(lookup({ quote_id: "Q-0101", invoice_id: null, customer_id: "c-acme" }))
      .toEqual({ customerId: "c-acme", customerName: "Acme Corporation" });
  });

  it("no quote and no invoice row loaded → the payment's own customer_id", () => {
    expect(lookup({ quote_id: null, invoice_id: "INV-UNKNOWN", customer_id: "c-lead" }))
      .toEqual({ customerId: "c-lead", customerName: "Converted Lead Ltd" });
  });

  it("nothing known → null, so the screen shows its own dash (never a guessed name)", () => {
    expect(lookup({ quote_id: null, invoice_id: null, customer_id: null }))
      .toEqual({ customerId: null, customerName: null });
  });
});

/* The /payments page (table rows, phone cards, search, sort, Export CSV and the receipt voucher /
   its PDF) names a payment's customer through this one helper — not from the quote alone. */
describe("R-1745 /payments wiring", () => {
  const page = readFileSync(join(__dirname, "../../app/(app)/payments/page.tsx"), "utf8");
  it("uses paymentCustomerLookup", () => {
    expect(page).toContain("paymentCustomerLookup(");
  });
  it("no longer reads the customer name from the quote context", () => {
    expect(page).not.toMatch(/ctx\??\.customerName/);
    expect(page).not.toMatch(/ctx\??\.customerId/);
  });
});

/* R-1747 — which invoice is a payment on? The refund flow and the receipt voucher read it here:
   the quote's GST invoice, else (a payment on an imported Zoho invoice) payments.invoice_id. */
describe("R-1747 paymentInvoiceLookup", () => {
  const invoiceOf = paymentInvoiceLookup({
    quotes: [{ id: "Q-0101", invoice_id: "INV-TZA-27-0007" }, { id: "Q-0102", invoice_id: null }],
    invoices: [
      { id: "INV-000245", external_number: "INV-000245" },
      { id: "INV-000300-TYA", external_number: "INV-000300" },
    ],
  });

  it("owner's example: ₹15,000 on imported INV-000245 (no quote) → that invoice, opening balance", () => {
    expect(invoiceOf({ quote_id: null, invoice_id: "INV-000245" }))
      .toEqual({ invoiceId: "INV-000245", invoiceNumber: "INV-000245", openingBalance: true });
  });

  it("an imported invoice whose id took a company suffix shows the Zoho number", () => {
    expect(invoiceOf({ quote_id: null, invoice_id: "INV-000300-TYA" }))
      .toEqual({ invoiceId: "INV-000300-TYA", invoiceNumber: "INV-000300", openingBalance: true });
  });

  it("invoice row not loaded yet → still the payment's invoice id (never the quote path)", () => {
    expect(invoiceOf({ quote_id: null, invoice_id: "INV-000999" }))
      .toEqual({ invoiceId: "INV-000999", invoiceNumber: "INV-000999", openingBalance: true });
  });

  it("a quote payment → the quote's GST invoice, not an opening balance", () => {
    expect(invoiceOf({ quote_id: "Q-0101", invoice_id: null }))
      .toEqual({ invoiceId: "INV-TZA-27-0007", invoiceNumber: "INV-TZA-27-0007", openingBalance: false });
    expect(invoiceOf({ quote_id: "Q-0102", invoice_id: null }))
      .toEqual({ invoiceId: null, invoiceNumber: null, openingBalance: false });
  });
});

describe("R-1747 /payments wiring", () => {
  const page = readFileSync(join(__dirname, "../../app/(app)/payments/page.tsx"), "utf8");
  it("the refund flow and the receipt read the invoice through paymentInvoiceLookup, not the quote context", () => {
    expect(page).toContain("paymentInvoiceLookup(");
    expect(page).not.toMatch(/invoiceId=\{ctx\?\.invoiceId/);
    expect(page).toContain("openingInvoiceNumber=");
  });
});
