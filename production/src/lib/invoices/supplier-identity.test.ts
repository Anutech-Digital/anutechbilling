import { describe, it, expect } from "vitest";
import { supplierIdentity, supplierIdentityMessage } from "./supplier-identity";
import type { CurrentUserInfo } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { isValidGstin } from "@/lib/utils";

/** ANUTECH DIGITAL PVT LTD, the real tenant — Delhi, state code 07. */
const anutech = (over: Partial<CurrentUserInfo> = {}): CurrentUserInfo => ({
  tenantName:      "ANUTECH DIGITAL PVT LTD",
  tenantGstin:     "07ABDCA0298H1ZP",
  tenantAddress:   "New Delhi",
  tenantState:     "Delhi",
  tenantStateCode: "07",
  tenantEmail:     "pardeep@anutech.in",
  tenantPhone:     "+91 98765 43210",
  ...over,
} as CurrentUserInfo);

describe("a complete identity resolves", () => {
  it("returns the supplier as given", () => {
    const r = supplierIdentity(anutech());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supplier.name).toBe("ANUTECH DIGITAL PVT LTD");
    expect(r.supplier.gstin).toBe("07ABDCA0298H1ZP");
    expect(r.supplier.stateCode).toBe("07");
  });

  it("upper-cases the GSTIN and trims, because it is matched not read", () => {
    const r = supplierIdentity(anutech({ tenantGstin: "  07abdca0298h1zp " }));
    expect(r.ok && r.supplier.gstin).toBe("07ABDCA0298H1ZP");
  });

  it("keeps email and phone optional — neither is required by Rule 46", () => {
    const r = supplierIdentity(anutech({ tenantEmail: null, tenantPhone: null }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.supplier.email).toBeNull();
  });
});

describe("an unknown identity is REPORTED, never substituted", () => {
  it("refuses when nobody is resolved yet, and says it is loading", () => {
    const r = supplierIdentity(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.hasSession).toBe(false);
    expect(supplierIdentityMessage(r)).toMatch(/loading/i);
  });

  it("names the missing fields when the tenant exists but was never filled in", () => {
    const r = supplierIdentity(anutech({ tenantGstin: null, tenantStateCode: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.hasSession).toBe(true);
    expect(r.missing.map((m) => m.field)).toEqual(["gstin", "stateCode"]);
    expect(supplierIdentityMessage(r)).toContain("GSTIN");
    expect(supplierIdentityMessage(r)).toContain("Settings");
  });

  it("treats blank and the literal string 'null' as absent", () => {
    /* Both arrive from real data: an empty text input saves "", and a stringified
       null has reached this schema before. Either one printed on a tax invoice is a
       blank where a GSTIN must be. */
    for (const bad of ["", "   ", "null", "NULL"]) {
      const r = supplierIdentity(anutech({ tenantGstin: bad }));
      expect(r.ok).toBe(false);
    }
  });

  it("puts the two tax-changing fields first in the list", () => {
    /* The operator fixes what they read first. GSTIN and state code change what the
       tax IS; name and address change how the document reads. */
    const r = supplierIdentity(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.slice(0, 2).map((m) => m.field)).toEqual(["gstin", "stateCode"]);
  });

  it("gives every required field a reason, not just a label", () => {
    const r = supplierIdentity(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const m of r.missing) expect(m.why.length).toBeGreaterThan(30);
  });
});

/**
 * ─── THE REGRESSION THAT MATTERS ────────────────────────────────────────────
 * The old fallback claimed state code "27" (Maharashtra). This asserts what that
 * did to the tax on a Delhi customer's invoice, so nobody re-adds a "harmless"
 * default without seeing the cost.
 */
describe("why a guessed state code is a money bug", () => {
  const DELHI = "07", MAHARASHTRA = "27";

  it("a Delhi customer of a Delhi supplier is INTRA-state — CGST + SGST", () => {
    expect(isInterStateSupply(DELHI, DELHI, {})).toBe(false);
  });

  it("the old fallback's 27 turned that same sale into IGST", () => {
    /* Same rupees, wrong tax heads, wrong government paid — and fixing it needs a
       credit note plus a fresh invoice, not an edit. */
    expect(isInterStateSupply(DELHI, MAHARASHTRA, {})).toBe(true);
  });

  it("so a missing state code must block the invoice rather than default", () => {
    const r = supplierIdentity(anutech({ tenantStateCode: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.some((m) => m.field === "stateCode")).toBe(true);
  });

  it("and the GSTIN it printed fails this app's OWN validator", () => {
    /* `27AABCE9876D1Z3` is the placeholder text from the signup form. utils.ts:244
       documents it as checksum-invalid. So the fallback put a number on a Tax Invoice
       that the app would have refused had anyone typed it into the field — the check
       existed, the fallback simply went around it. ANUTECH's real GSTIN passes. */
    expect(isValidGstin("27AABCE9876D1Z3")).toBe(false);
    expect(isValidGstin("07ABDCA0298H1ZP")).toBe(true);
  });
});

/* R-1529 — a Bill of Supply (CGST Rule 49): GSTIN only "if registered". */
describe("Bill of Supply", () => {
  const unregBill = { document_kind: "bill_of_supply", supplier_gst_status: "unregistered" };
  const compBill  = { document_kind: "bill_of_supply", supplier_gst_status: "composition" };

  it("an unregistered supplier's Bill of Supply needs no GSTIN", () => {
    const r = supplierIdentity(anutech({ tenantGstin: null }), unregBill);
    expect(r.ok).toBe(true);
    expect(r.ok && r.supplier.gstin).toBeNull();
  });

  it("but still needs the address — Rule 49 asks for it", () => {
    const r = supplierIdentity(anutech({ tenantGstin: null, tenantAddress: null }), unregBill);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.map((m) => m.field)).toEqual(["address"]);
    expect(supplierIdentityMessage(r, unregBill)).toMatch(/bill of supply cannot be issued/i);
  });

  it("a composition supplier is registered — its GSTIN is still required", () => {
    const r = supplierIdentity(anutech({ tenantGstin: null }), compBill);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing[0].field).toBe("gstin");
    expect(r.missing[0].why).toMatch(/composition/i);
  });

  it("a Tax Invoice still refuses without a GSTIN (unchanged)", () => {
    const r = supplierIdentity(anutech({ tenantGstin: null }), { document_kind: "tax_invoice" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(supplierIdentityMessage(r, { document_kind: "tax_invoice" })).toMatch(/tax invoice cannot be issued/i);
  });

  it("a GSTIN that is present is printed on the Bill of Supply too", () => {
    const r = supplierIdentity(anutech(), compBill);
    expect(r.ok && r.supplier.gstin).toBe("07ABDCA0298H1ZP");
  });
});
