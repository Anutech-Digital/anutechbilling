/**
 * R-002 — a project sale is filed against a real customer, not a typed name.
 *
 * A source scan, because the defect was WIRING: the dialog rendered a perfectly good
 * text input and passed `customerId: null` to a mutation that accepts an id. Nothing
 * about that fails a unit test, and the damage only appears later — in a Ledger that
 * never shows the sale, and in "Demo Co" quietly being a different party from
 * "Demo Co".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/components/features/projects/create-project-dialog.tsx";

/** Comments stripped — prose about a thing must not satisfy a scan for it (L46). */
const src = readFileSync(FILE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the customer is chosen, not typed", () => {
  it("uses the shared picker", () => {
    expect(src).toContain("<CustomerCombobox");
  });

  it("no longer has a free-text customer input", () => {
    expect(src).not.toMatch(/id="p_customer"[^>]*onChange=\{\(e\) => setCustomerName/);
    expect(src).not.toContain("setCustomerName(");
  });

  it("sends the id, never null", () => {
    /* THE BUG. `customerId: null` is what kept the sale out of the Ledger. */
    expect(src).not.toMatch(/customerId:\s*null/);
    expect(src).toMatch(/customerId,/);
  });

  it("takes the name from the chosen record", () => {
    expect(src).toContain("selectedCustomer?.name");
  });

  it("cannot submit without a customer selected", () => {
    expect(src).toMatch(/customerId !== ""/);
  });

  it("offers ＋ New customer through the same form the Customers page uses", () => {
    // So a customer created here still gets its mandatory contact person.
    expect(src).toContain("<AddCustomerForm");
    expect(src).toContain("onCreated={(newId) => setCustomerId(newId)}");
  });
});

describe("the tax head follows the customer, not a guess", () => {
  it("derives inter-state from the two state codes", () => {
    expect(src).toContain("isInterStateSupply(");
  });

  it("passes both GSTINs, because most customers have no state_code", () => {
    /* 36 of 41 customers holding a GSTIN have no state_code; the first two characters
       of a GSTIN are the state. Dropping these would silently tax them intra-state. */
    expect(src).toContain("customerGstin");
    expect(src).toContain("sellerGstin");
  });

  it("an explicit tick is never overwritten afterwards", () => {
    // Otherwise the effect fights the operator every time the customer re-renders.
    expect(src).toContain("interStateTouched");
    expect(src).toMatch(/if \(interStateTouched \|\| !selectedCustomer\) return;/);
  });

  it("still lets the operator override it", () => {
    expect(src).toMatch(/setInterStateTouched\(true\); setInterState\(e\.target\.checked\)/);
  });
});
