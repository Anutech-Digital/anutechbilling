import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { duplicateQuoteHref } from "./duplicate-customer";

describe("duplicateQuoteHref (R-379 h)", () => {
  it("quote with a customer → no leadId, so the copy keeps customer_id (not 'prospect')", () => {
    const href = duplicateQuoteHref({
      id: "Q-FBB9-27-0011", customer_id: "c-1", lead_id: "L-9", customer_name: "Test Sharma Traders",
    });
    const p = new URL(href, "http://x").searchParams;
    expect(p.get("duplicate")).toBe("Q-FBB9-27-0011");
    expect(p.get("leadId")).toBeNull();
    expect(p.get("company")).toBeNull();
  });
  it("prospect quote (lead, no customer) → lead context carried forward as before", () => {
    const p = new URL(duplicateQuoteHref({ id: "Q-1", customer_id: null, lead_id: "L-9", customer_name: "Acme" }), "http://x").searchParams;
    expect(p.get("leadId")).toBe("L-9");
    expect(p.get("company")).toBe("Acme");
  });
});

/* Wiring on the quote page (source scan — the page is a large client component). */
describe("quote page wiring (R-379 h, i, j)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
  it("(h) Duplicate & edit uses duplicateQuoteHref, and Mark accepted words via acceptedToast", () => {
    expect(src).toMatch(/router\.push\(duplicateQuoteHref\(quote\)/);
    expect(src).toMatch(/toast\.success\(acceptedToast\(data\)\)/);
    expect(src).not.toMatch(/customer record created/);
  });
  it("(i) 'Activate now, pay later' button sits in the unpaid action row behind the same showCredit gate", () => {
    const i = src.indexOf("{showCredit && money.stage === \"unpaid\" && (");
    expect(i).toBeGreaterThan(0);
    const block = src.slice(i, i + 400);
    expect(block).toMatch(/onClick=\{openActivateOnCredit\}/);
    expect(block).toMatch(/Activate now, pay later/);
    expect(src).toMatch(/const gate = customerCreditEligibility\(creditCustomer \?\? null\)/);
  });
  it("(j) Record payment prefill reads existing subscription domains", () => {
    expect(src).toMatch(/quoteSubscriptionDomains:/);
    expect(src).toMatch(/customerSubscriptionDomains:/);
  });
});
