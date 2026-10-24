/**
 * R-1485 — the buyer's GSTIN comes from the customer row (else the lead's), and every
 * quote surface passes it: preview, quote page, downloaded PDF, emailed PDF.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addGstinHref, buyerGstinMissing, quoteBuyerGstin } from "./buyer-gstin";

const G = "07AAACR5055K1Z9";

describe("quoteBuyerGstin (R-1485)", () => {
  it("the customer's GSTIN", () => {
    expect(quoteBuyerGstin({ gstin: G }, { gstin: "06AAAAA0000A1Z5" })).toBe(G);
  });
  it("a lead quote (no customer yet) prints the lead's GSTIN", () => {
    expect(quoteBuyerGstin(null, { gstin: ` ${G.toLowerCase()} ` })).toBe(G);
  });
  it("a customer without one is not filled from the lead — one fact, one place", () => {
    expect(quoteBuyerGstin({ gstin: null }, { gstin: G })).toBeNull();
  });
  it("blank → null", () => {
    expect(quoteBuyerGstin({ gstin: "  " })).toBeNull();
    expect(quoteBuyerGstin(undefined, undefined)).toBeNull();
  });
});

describe("buyerGstinMissing (R-1485)", () => {
  it("a business customer with no GSTIN → offer to add it", () => {
    expect(buyerGstinMissing({ id: "c1", gstin: null, customer_type: "business", gst_treatment: "unregistered_business" })).toBe(true);
  });
  it("not for a customer that has one", () => {
    expect(buyerGstinMissing({ id: "c1", gstin: G, customer_type: "business" })).toBe(false);
  });
  it("not for an individual, a consumer or an overseas buyer", () => {
    expect(buyerGstinMissing({ gstin: null, customer_type: "individual" })).toBe(false);
    expect(buyerGstinMissing({ gstin: null, customer_type: "business", gst_treatment: "consumer" })).toBe(false);
    expect(buyerGstinMissing({ gstin: null, customer_type: "business", gst_treatment: "overseas" })).toBe(false);
  });
  it("not for a name-only row (R-1004) — the GSTIN is hidden from this role, not missing", () => {
    expect(buyerGstinMissing({ gstin: null, customer_type: "business", name_only: true })).toBe(false);
  });
  it("links to the customer's edit form", () => {
    expect(addGstinHref("c1")).toBe("/customers/c1/edit");
  });
});

describe("every quote surface passes the buyer's GSTIN (R-1485)", () => {
  /* Source guard: the bug was callers leaving customerGstin out. */
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("quote page: Download PDF and Preview", () => {
    const src = read("src/app/(app)/quotes/[id]/page.tsx");
    expect(src).toMatch(/downloadQuotePDF\(\{[\s\S]*?customerGstin:\s*buyerGstin/);
    expect(src).toMatch(/<QuotePreviewDialog[\s\S]*?customerGstin=\{buyerGstin\}/);
  });
  it("emailed PDF (send route)", () => {
    expect(read("src/app/api/quotes/[id]/send/route.ts")).toMatch(/renderQuotePDF\(\{[\s\S]*?customerGstin:\s*quoteBuyerGstin\(customer, lead\)/);
  });
  it("builder preview", () => {
    expect(read("src/components/features/quotes/quote-builder.tsx")).toMatch(/<QuotePreviewDialog[\s\S]*?customerGstin=\{previewGstin\}/);
  });
  it("quotes list preview", () => {
    expect(read("src/app/(app)/quotes/page.tsx")).toMatch(/<QuotePreviewDialog[\s\S]*?customerGstin=\{quoteBuyerGstin\(customer, lead\)\}/);
  });
  it("the preview prints it under Bill to", () => {
    expect(read("src/components/features/quotes/quote-preview-dialog.tsx")).toMatch(/GSTIN: <span className="font-mono">\{customerGstin\}/);
  });
});
