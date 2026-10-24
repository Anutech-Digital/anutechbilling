/**
 * R-1629 — the renewal line on /quote must say its price includes GST, everywhere it is shown.
 *
 * quoteRenewal's numbers are GST-inclusive (gstBreakup(...).total), and the page said
 * "incl. 18% GST" — but the printed / PDF quote and the "Email the quote" body did not, while
 * the same page says rates are "GST 18% billed separately". A buyer reading the PDF would add
 * 18% again. One helper (quoteRenewalText) now writes the line, with the GST basis, for all three.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quoteRenewalText } from "./quote-catalog";

describe("R-1629: quoteRenewalText says the renewal includes GST", () => {
  it("annual commitment", () => {
    expect(quoteRenewalText({ perMonth: null, yearlyOnce: 0, perYear: 23724 }))
      .toBe("Renews ₹23,724/yr incl. 18% GST");
  });

  it("flexible monthly with yearly items", () => {
    expect(quoteRenewalText({ perMonth: 1977, yearlyOnce: 1179, perYear: 24903 }))
      .toBe("Renews ₹1,977/mo × 12 + ₹1,179 yearly items = ₹24,903/yr incl. 18% GST");
  });

  it("flexible monthly without yearly items", () => {
    expect(quoteRenewalText({ perMonth: 1977, yearlyOnce: 0, perYear: 23724 }))
      .toBe("Renews ₹1,977/mo × 12 = ₹23,724/yr incl. 18% GST");
  });
});

describe("R-1629: QuoteBuilder writes every renewal line through the helper", () => {
  const src = readFileSync(resolve(__dirname, "../../components/quote/QuoteBuilder.tsx"), "utf8");

  it("builds the renewal text with quoteRenewalText, not by hand", () => {
    expect(src).toMatch(/renewalText\s*=\s*quoteRenewalText\(renewal\)/);
    expect(src).not.toMatch(/`Renews \$\{/);
  });

  it("page, print/PDF and email all show renewalText (so all say incl. GST)", () => {
    // email body (quoteText), the on-page summary, and the print sheet
    expect(src.match(/renewalText/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // no second, hand-written "incl. 18% GST" next to the renewal on the page
    expect(src).not.toMatch(/\{renewalText\}[^<]*incl\. 18% GST/);
  });
});
