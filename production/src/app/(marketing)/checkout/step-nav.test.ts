/**
 * R-1113 (23 Oct 2026): Continue on an incomplete form marks every missing box and focuses the
 * first; step 2 opens at the top; the phone's Back returns to step 1 instead of leaving checkout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { missingCheckoutFields, type CheckoutDetails } from "@/site/lib/checkout-details";

const empty: CheckoutDetails = {
  name: "", email: "", phone: "", domain: "", hasHosting: true, hasDomain: true,
  needsState: true, stateCode: "", gstin: "", address: { line1: "", city: "", state: "", pin: "" },
};

describe("R-1113 missingCheckoutFields", () => {
  it("names every missing box, in form order (name first)", () => {
    expect(missingCheckoutFields(empty)).toEqual(["name", "email", "phone", "domain", "state", "address"]);
  });
  it("a bad GSTIN is its own box; complete details are none", () => {
    const full: CheckoutDetails = { ...empty, name: "Pawan", email: "p@anutech.in", phone: "7778886760", domain: "acme.in", stateCode: "07", address: { line1: "12 Main Rd", city: "Delhi", state: "Delhi", pin: "110085" } };
    expect(missingCheckoutFields(full)).toEqual([]);
    expect(missingCheckoutFields({ ...full, gstin: "07ABCDE1234F1Z0" })).toEqual(["gstin"]);
  });
});

describe("R-1113 wiring in the checkout page", () => {
  const src = readFileSync("src/app/(marketing)/checkout/page.tsx", "utf8");
  it("Continue focuses the first missing box and marks all of them", () => {
    expect(src).toMatch(/focusField\(missingFields\[0\]\)/);
    expect(src).toMatch(/invalid=\{bad\("name"\)\}/);
    expect(src).toMatch(/invalid=\{bad\("phone"\)\}/);
    expect(src).toMatch(/id="checkout-name"/);
  });
  it("step 2 opens at the top with its own history entry; Back and popstate return to step 1", () => {
    expect(src).toMatch(/window\.scrollTo\(0, 0\)/);
    expect(src).toMatch(/window\.history\.pushState\(null, "", "\?step=payment"\)/);
    expect(src).toMatch(/addEventListener\("popstate"/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(firstStep\.current\)[\s\S]{0,300}window\.scrollTo\(0, 0\);\s*\}, \[step\]\)/);
    expect(src).toMatch(/onClick=\{backToDetails\}/);
  });
});
