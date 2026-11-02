/**
 * R-1929 — a new reseller's quote does not promise the platform company's free training.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLeadQuoteNotes, pricingValidityLine } from "./default-quote-notes";

describe("default quote notes", () => {
  it("a quote from a lead says only who it is for and how long the price holds", () => {
    expect(defaultLeadQuoteNotes({ leadName: "Sharma Traders", contactName: "Ravi", validityDays: 30 }))
      .toBe("Quote for Sharma Traders\nAttn: Ravi\n\nPricing valid for 30 days.");
  });

  it("N comes from the quote's validity", () => {
    expect(pricingValidityLine(15)).toBe("Pricing valid for 15 days.");
    expect(pricingValidityLine(1)).toBe("Pricing valid for 1 day.");
    expect(pricingValidityLine(0)).toBe("Pricing valid for 30 days.");
  });

  it("no Attn line when the contact is the company itself", () => {
    expect(defaultLeadQuoteNotes({ leadName: "Ravi", contactName: "Ravi" })).toBe("Quote for Ravi\n\nPricing valid for 30 days.");
  });

  it("never promises onboarding or free training", () => {
    const notes = defaultLeadQuoteNotes({ leadName: "X", validityDays: 30 });
    expect(notes).not.toMatch(/training|onboarding|DKIM/i);
  });
});

describe("wiring — the quote builder uses it", () => {
  const src = readFileSync(join(process.cwd(), "src/components/features/quotes/quote-builder.tsx"), "utf8");
  it("no hard-coded free-training / onboarding promise anywhere in the builder", () => {
    expect(src).not.toMatch(/Free training/);
    expect(src).not.toMatch(/Onboarding includes DNS/);
  });
  it("the lead prefill and the notes placeholder come from default-quote-notes", () => {
    expect(src).toMatch(/defaultLeadQuoteNotes\(/);
    expect(src).toMatch(/pricingValidityLine\(validityDays\)/);
  });
});
