import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signerNameDefault } from "./signer-default";

/* R-376 (d): the accept dialog pre-filled "Your full name" with the COMPANY name. */
describe("signerNameDefault", () => {
  it("customer's contact person (first + last) wins over the company", () => {
    expect(signerNameDefault({
      customer: { contact_first_name: "Rajesh", contact_last_name: "Kumar", contact_name: "R K" },
      company: "Acme Pvt Ltd",
    })).toBe("Rajesh Kumar");
  });

  it("customer contact_name when first/last are blank", () => {
    expect(signerNameDefault({ customer: { contact_first_name: " ", contact_name: "Priya S" }, company: "Acme" })).toBe("Priya S");
  });

  it("a lead quote uses the lead's contact", () => {
    expect(signerNameDefault({ customer: null, lead: { contact_name: "Amit" }, company: "Acme" })).toBe("Amit");
  });

  it("no person known → falls back to the company", () => {
    expect(signerNameDefault({ customer: null, lead: { contact_name: "  " }, company: "Acme Pvt Ltd" })).toBe("Acme Pvt Ltd");
  });

  it("nothing at all → empty", () => {
    expect(signerNameDefault({})).toBe("");
  });
});

describe("accept page wiring", () => {
  const dir = join(process.cwd(), "src", "app", "(public)", "quote", "[id]", "accept");
  const page = readFileSync(join(dir, "page.tsx"), "utf8");
  const view = readFileSync(join(dir, "quote-accept-view.tsx"), "utf8");

  it("the view seeds the signer box from signerDefault, not the company name", () => {
    expect(view).toMatch(/React\.useState\(signerDefault \?\? quote\.customer_name \?\? ""\)/);
    expect(view).not.toMatch(/useState\(quote\.customer_name \?\? ""\)/);
  });

  it("the page computes it with signerNameDefault and passes it down", () => {
    expect(page).toMatch(/signerNameDefault\(/);
    expect(page).toMatch(/signerDefault=\{signerDefault\}/);
  });

  it("only the contact NAME reaches the page — never the customer's email/phone", () => {
    const sel = page.match(/from\("customers"\)\s*\.select\("([^"]+)"\)/)?.[1] ?? "";
    expect(sel).not.toMatch(/email|phone/);
  });
});
