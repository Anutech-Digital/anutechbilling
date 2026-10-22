/**
 * R-1767 (Pardeep, 22 Oct 2026, staging) — a Net2secure PROFORMA "Bill To" Beta Technologies
 * was read and saved inside Acme Digital's Expenses with no warning: the reader never read
 * the BUYER, so the app could not know the bill belonged to another company.
 *
 * Owner's examples (synthetic GSTINs in the real SHAPE — the real PDF never enters the repo):
 *   1. Acme Digital uploads Invoice-4426, Bill To Beta Technologies → warning.
 *   2. A tax invoice billed to Acme Digital's own GSTIN → nothing.
 */
import { describe, it, expect } from "vitest";
import { billBuyerMismatch, buyerWarningText, buyerConfirmedNote, normaliseCompanyName, resaleProduct } from "./buyer-check";
import { sanitizeExtractedBill } from "./sanitize";
import { BILL_PROMPT } from "@/lib/ai/read-bill";

const ACME = { name: "Acme Digital", gstin: "09AAKCA1111A1Z5", legal_name: "ACME DIGITAL PRIVATE LIMITED", trade_name: null };
const BETA_GSTIN = "09AAFCE2222B1Z7";
const NET2 = { vendor_name: "Net2Secure Private Limited", vendor_gstin: "09AAICN3949G1Z3" };

describe("R-1767 — the reader asks for the buyer, never the seller", () => {
  it("prompt names buyer_name / buyer_gstin from Bill To / Billed To / Buyer", () => {
    expect(BILL_PROMPT).toMatch(/"buyer_name"/);
    expect(BILL_PROMPT).toMatch(/"buyer_gstin"/);
    expect(BILL_PROMPT).toMatch(/Bill To/);
    expect(BILL_PROMPT).toMatch(/Billed To/);
  });
  it("sanitize keeps buyer_name and an upper-case buyer_gstin; blanks become null", () => {
    const f = sanitizeExtractedBill({ ...NET2, buyer_name: " BETA TECHNOLOGIES ", buyer_gstin: " 09aafce2222b1z7 " });
    expect(f.buyer_name).toBe("BETA TECHNOLOGIES");
    expect(f.buyer_gstin).toBe(BETA_GSTIN);
    const g = sanitizeExtractedBill({ ...NET2 });
    expect(g.buyer_name).toBeNull();
    expect(g.buyer_gstin).toBeNull();
  });
  it("a 'buyer' that is really the seller (model confused) is dropped — silence beats a false alarm", () => {
    const f = sanitizeExtractedBill({ ...NET2, buyer_name: "Net2Secure Pvt Ltd", buyer_gstin: NET2.vendor_gstin });
    expect(f.buyer_name).toBeNull();
    expect(f.buyer_gstin).toBeNull();
  });
});

describe("R-1767 — billBuyerMismatch (owner example 1: Beta Technologies bill in Acme Digital)", () => {
  it("buyer GSTIN differs from ours → mismatch with the buyer's name and GSTIN", () => {
    const m = billBuyerMismatch({ buyer_name: "BETA TECHNOLOGIES", buyer_gstin: BETA_GSTIN }, ACME);
    expect(m).toEqual({ buyer_name: "BETA TECHNOLOGIES", buyer_gstin: BETA_GSTIN, own_name: "Acme Digital" });
    expect(buyerWarningText(m!)).toBe(
      `This bill is addressed to BETA TECHNOLOGIES (GSTIN ${BETA_GSTIN}), not Acme Digital. Add it here only if Acme Digital really paid it.`,
    );
    expect(buyerConfirmedNote(m!)).toMatch(/addressed to BETA TECHNOLOGIES .*confirmed Acme Digital paid it/);
  });
  it("owner example 2: buyer GSTIN = ours → nothing, whatever the name says", () => {
    expect(billBuyerMismatch({ buyer_name: "Acme Digital Pvt. Ltd.", buyer_gstin: ACME.gstin }, ACME)).toBeNull();
    expect(billBuyerMismatch({ buyer_name: "Some trade name", buyer_gstin: ACME.gstin.toLowerCase() }, ACME)).toBeNull();
  });
  it("no buyer read → nothing", () => {
    expect(billBuyerMismatch({ buyer_name: null, buyer_gstin: null }, ACME)).toBeNull();
    expect(billBuyerMismatch({}, ACME)).toBeNull();
  });
  it("no buyer GSTIN: same company after normalising Pvt Ltd / Private Limited → nothing", () => {
    expect(billBuyerMismatch({ buyer_name: "ACME DIGITAL PVT. LTD." }, ACME)).toBeNull();
    expect(billBuyerMismatch({ buyer_name: "M/s Acme Digital Private Limited" }, { ...ACME, gstin: null, legal_name: null })).toBeNull();
  });
  it("no buyer GSTIN and a clearly different name → mismatch without a GSTIN in the text", () => {
    const m = billBuyerMismatch({ buyer_name: "Beta Technologies" }, ACME);
    expect(m).toEqual({ buyer_name: "Beta Technologies", buyer_gstin: null, own_name: "Acme Digital" });
    expect(buyerWarningText(m!)).toBe("This bill is addressed to Beta Technologies, not Acme Digital. Add it here only if Acme Digital really paid it.");
  });
  it("a buyer GSTIN but our company has none on file → falls back to the name", () => {
    const own = { ...ACME, gstin: null };
    expect(billBuyerMismatch({ buyer_name: "Acme Digital", buyer_gstin: BETA_GSTIN }, own)).toBeNull();
    expect(billBuyerMismatch({ buyer_name: "Beta Technologies", buyer_gstin: BETA_GSTIN }, own)?.buyer_name).toBe("Beta Technologies");
  });
  it("a garbled buyer GSTIN is ignored (name decides)", () => {
    expect(billBuyerMismatch({ buyer_name: "Acme Digital", buyer_gstin: "N/A" }, ACME)).toBeNull();
  });
  it("our company with no name on file and no GSTIN match → nothing (can't compare)", () => {
    expect(billBuyerMismatch({ buyer_name: "Beta Technologies" }, { name: "", gstin: null })).toBeNull();
  });
});

describe("normaliseCompanyName", () => {
  it("drops case, punctuation, M/s and company-form suffixes", () => {
    expect(normaliseCompanyName("M/s. Acme Digital Pvt. Ltd.")).toBe("ACME DIGITAL");
    expect(normaliseCompanyName("ACME DIGITAL PRIVATE LIMITED")).toBe("ACME DIGITAL");
    expect(normaliseCompanyName("Beta Technologies LLP")).toBe("BETA TECHNOLOGIES");
  });
});

describe("R-1767 addition — resaleProduct (a COGS bill uploaded in Add expense)", () => {
  it("the reader's COGS category for a resold product → its product name", () => {
    expect(resaleProduct({ category_guess: "COGS-Workspace" })).toBe("Google Workspace");
    expect(resaleProduct({ category_guess: "COGS-M365" })).toBe("Microsoft 365");
    expect(resaleProduct({ category_guess: "COGS-Zoho" })).toBe("Zoho");
  });
  it("COGS-Other, null or anything else → not a resale bill", () => {
    expect(resaleProduct({ category_guess: "COGS-Other" })).toBeNull();
    expect(resaleProduct({ category_guess: null })).toBeNull();
    expect(resaleProduct({})).toBeNull();
    expect(resaleProduct({ category_guess: "Software" })).toBeNull();
  });
});
