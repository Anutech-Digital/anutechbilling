/* R-1529 — Tax Invoice or Bill of Supply, read off the frozen invoice row. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  billOfSupplyDeclarations, COMPOSITION_DECLARATION, documentKindOf, documentTitle, isBillOfSupply,
  isTaxInvoiceRow, supplierGstStatusOf, UNREGISTERED_DECLARATION,
} from "./document-kind";

describe("documentKindOf", () => {
  it("bill_of_supply only when the row says so", () => {
    expect(documentKindOf({ document_kind: "bill_of_supply" })).toBe("bill_of_supply");
    expect(documentKindOf({ document_kind: "tax_invoice" })).toBe("tax_invoice");
  });
  it("a row from before R-1529 (no column / null) was a Tax Invoice", () => {
    expect(documentKindOf({})).toBe("tax_invoice");
    expect(documentKindOf({ document_kind: null })).toBe("tax_invoice");
    expect(documentKindOf(null)).toBe("tax_invoice");
  });
  it("an unknown value is not promoted to a Bill of Supply", () => {
    expect(isBillOfSupply({ document_kind: "Bill Of Supply" })).toBe(false);
  });
});

describe("title and declarations", () => {
  it("titles", () => {
    expect(documentTitle({ document_kind: "bill_of_supply" })).toBe("Bill of Supply");
    expect(documentTitle({ document_kind: "tax_invoice" })).toBe("Tax Invoice");
  });
  it("composition carries the statutory sentence (q5)", () => {
    const d = billOfSupplyDeclarations({ document_kind: "bill_of_supply", supplier_gst_status: "composition" });
    expect(d[0]).toBe(COMPOSITION_DECLARATION);
    expect(COMPOSITION_DECLARATION.toLowerCase()).toBe("composition taxable person, not eligible to collect tax on supplies");
    expect(d.join(" ")).toMatch(/Rule 49/);
  });
  it("unregistered says no GST is charged", () => {
    expect(billOfSupplyDeclarations({ document_kind: "bill_of_supply", supplier_gst_status: "unregistered" })[0])
      .toBe(UNREGISTERED_DECLARATION);
  });
  it("a Tax Invoice carries none", () => {
    expect(billOfSupplyDeclarations({ document_kind: "tax_invoice", supplier_gst_status: "registered" })).toEqual([]);
  });
  it("supplier status is read strictly", () => {
    expect(supplierGstStatusOf({ supplier_gst_status: "composition" })).toBe("composition");
    expect(supplierGstStatusOf({ supplier_gst_status: "x" })).toBeNull();
  });
});

describe("GST returns take Tax Invoices only (q5)", () => {
  const rows = [
    { id: "INV-1", document_kind: "tax_invoice" },
    { id: "BOS-1", document_kind: "bill_of_supply" },
    { id: "INV-old" },
  ];
  it("isTaxInvoiceRow drops Bills of Supply and keeps legacy rows", () => {
    expect(rows.filter(isTaxInvoiceRow).map((r) => r.id)).toEqual(["INV-1", "INV-old"]);
  });

  /* The GSTR-1 / GST payable loader and the GST audit must apply it to what they read. A
     source check, because both are React Query hooks over a live client. */
  it.each([
    ["src/app/(app)/accounting/gst/report.ts"],
    ["src/lib/queries/gst-health.ts"],
  ])("%s selects document_kind and filters with isTaxInvoiceRow", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/from\("invoices"\)[\s\S]{0,80}\.select\("[^"]*\bdocument_kind\b[^"]*"\)/);
    expect(src).toMatch(/\.filter\(isTaxInvoiceRow\)/);
  });

  it("report.ts builds GSTR-1 output rows only from the filtered list", () => {
    const src = readFileSync("src/app/(app)/accounting/gst/report.ts", "utf8");
    const filterAt = src.indexOf(".filter(isTaxInvoiceRow)");
    const rowsAt = src.indexOf("const outputRows: OutputRow[] = (invoices ?? [])");
    expect(filterAt).toBeGreaterThan(0);
    expect(rowsAt).toBeGreaterThan(filterAt);
    expect(src).not.toMatch(/const \{ data: invoices, error: invErr \}/);   // the unfiltered name is gone
  });
});
