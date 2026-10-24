/* R-1670 (3) — the quote PDF printed "Net 7 days from acceptance" for every customer, while the
   invoice raised from that quote is due after quotes.payment_terms_days (default 30). */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_INVOICE_TERMS_DAYS, quotePaymentTermsLine } from "./payment-terms";

describe("quote payment terms line (R-1670 item 3)", () => {
  it("a Net 30 quote says Net 30", () => {
    expect(quotePaymentTermsLine(30)).toBe("Net 30 days from the invoice date.");
  });
  it("no terms on the quote → the invoice default, 30 days (generate_invoice)", () => {
    expect(DEFAULT_INVOICE_TERMS_DAYS).toBe(30);
    expect(quotePaymentTermsLine(null)).toBe("Net 30 days from the invoice date.");
    expect(quotePaymentTermsLine(undefined)).toBe("Net 30 days from the invoice date.");
  });
  it("0 days → due on receipt", () => {
    expect(quotePaymentTermsLine(0)).toBe("Due on receipt of the invoice.");
  });
  it("one day is singular; nonsense falls back to the default", () => {
    expect(quotePaymentTermsLine(1)).toBe("Net 1 day from the invoice date.");
    expect(quotePaymentTermsLine(-5)).toBe("Net 30 days from the invoice date.");
  });
  it("QuotePDF no longer hardcodes Net 7", () => {
    const src = fs.readFileSync(path.join(__dirname, "QuotePDF.tsx"), "utf8");
    expect(src).not.toMatch(/Net 7 days from acceptance\. UPI/);
    expect(src).toMatch(/quotePaymentTermsLine\(paymentTermsDays\)/);
  });
  it("the SQL default it mirrors is still 30", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const last = [...files].reverse().find((f) => /coalesce\(v_quote\.payment_terms_days, \d+\)/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(last).toBeTruthy();
    const m = /coalesce\(v_quote\.payment_terms_days, (\d+)\)/.exec(fs.readFileSync(path.join(dir, last!), "utf8"));
    expect(Number(m![1])).toBe(DEFAULT_INVOICE_TERMS_DAYS);
  });
});
