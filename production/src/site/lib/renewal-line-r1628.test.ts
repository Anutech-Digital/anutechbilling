/**
 * R-1628 (24 Oct 2026): the /domains page promised "renewal shown at checkout", but every
 * yearly line at checkout said only "Renews yearly" — no amount. The checkout (and the cart
 * page) now print what each yearly line renews at, per year, incl. 18% GST, from the same
 * live rate card the /domains page reads (getSiteTldPrices). Unknown renewal → no number,
 * and the /domains page no longer promises one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { domainRenewals, lineRenewalText } from "./renewal-line";
import type { CartLine } from "./money";

const line = (over: Partial<CartLine>): CartLine => ({
  key: "k", label: "x", detail: "", unitPrice: 1000, qty: 1, unit: "year", cycle: "yearly", ...over,
});

describe("R-1628: domainRenewals — the live rate card's renewal per extension", () => {
  it("keeps only extensions with a real renewal price", () => {
    expect(domainRenewals([
      { tld: ".in", renew: 799 },
      { tld: ".com", renew: null },
      { tld: ".co.in", renew: 0 },
    ])).toEqual({ ".in": 799 });
  });
});

describe("R-1628: lineRenewalText — what a checkout line renews at", () => {
  const renewals = { ".in": 799, ".co.in": 650 };

  it("a domain line renews at the extension's renewal price, not its first-year price, incl. GST", () => {
    // 799 + 18% = 942.82 → ₹943 (gstBreakup, whole rupees)
    expect(lineRenewalText(line({ sku: "domain:in", domain: "acme.in", unitPrice: 299 }), renewals))
      .toBe("Renews ₹943/yr incl. 18% GST");
  });

  it("a second-level extension is matched whole (.co.in, not .in)", () => {
    expect(lineRenewalText(line({ sku: "domain:co.in", domain: "acme.co.in", unitPrice: 499 }), renewals))
      .toBe("Renews ₹767/yr incl. 18% GST");
  });

  it("a multi-year domain says when the renewal starts", () => {
    expect(lineRenewalText(line({ sku: "domain:in", domain: "acme.in", unitPrice: 1500, years: 2 }), renewals))
      .toBe("After 2 years: renews ₹943/yr incl. 18% GST");
  });

  it("a domain whose renewal is unknown gets no number — never a guess", () => {
    expect(lineRenewalText(line({ sku: "domain:xyz", domain: "acme.xyz" }), renewals)).toBe("Renews yearly");
    expect(lineRenewalText(line({ sku: "domain:xyz", domain: "acme.xyz", years: 3 }), renewals))
      .toBe("Renews after 3 years, then yearly");
  });

  it("a yearly plan renews at its list price × qty, incl. GST (coupons are first-payment only)", () => {
    expect(lineRenewalText(line({ sku: "hosting:starter", unitPrice: 3588 }), renewals))
      .toBe("Renews ₹4,234/yr incl. 18% GST");
    expect(lineRenewalText(line({ sku: "mailbox:anutech", unitPrice: 600, qty: 3 }), renewals))
      .toBe("Renews ₹2,124/yr incl. 18% GST");
  });

  it("monthly and one-time lines keep their own words", () => {
    expect(lineRenewalText(line({ cycle: "monthly", unit: "month" }), renewals)).toBe("Recurring monthly");
    expect(lineRenewalText(line({ cycle: "once" }), renewals)).toBe("One time");
  });
});

describe("R-1628: the pages use it", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

  it("checkout and the cart page print lineRenewalText, fed by the cart's live renewals", () => {
    for (const f of ["src/app/(marketing)/checkout/page.tsx", "src/app/(marketing)/cart/page.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/lineRenewalText\(/);
      expect(src, f).toMatch(/domainRenewals/);
    }
  });

  it("the marketing layout hands the live rate card's renewals to the cart", () => {
    const src = read("src/app/(marketing)/layout.tsx");
    expect(src).toMatch(/<CartProvider domainRenewals=\{domainRenewals\(tlds\)\}>/);
  });

  it("the /domains page no longer promises a renewal the checkout cannot show", () => {
    expect(read("src/site/components/domains/DomainLanding.tsx")).not.toMatch(/renewal shown at checkout/i);
  });
});
