/**
 * R-1835 — Revenue by what was sold. Which family a line belongs to is decided in SQL
 * (public.revenue_family — table-driven in supabase/tests/r1835_pnl_revenue_by_product.test.sql);
 * here: the names the statement prints, and that a split is shown only when it adds up.
 */
import { describe, expect, it } from "vitest";
import { revenueByProduct, revenueFamilyLabel, type RevenueByProductRow } from "@/lib/accounting/revenue-family";

describe("revenueFamilyLabel", () => {
  it.each([
    ["google", "Google Workspace"],
    ["microsoft", "Microsoft 365"],
    ["zoho", "Zoho"],
    ["hosting", "Hosting"],
    ["domain", "Domains"],
    ["support", "In-House Support"],
    ["projects", "Software projects"],
    ["other", "Other sales"],
    ["something-new", "something-new"],   // a family added in SQL later still shows, by its key
  ])("%s → %s", (family, label) => {
    expect(revenueFamilyLabel(family)).toBe(label);
  });
});

const rows: RevenueByProductRow[] = [
  { family: "google", invoiced: 32_400, credit_notes: 1_000, debit_notes: 0, invoice_count: 1 },
  { family: "hosting", invoiced: 1_235, credit_notes: 371, debit_notes: 0, invoice_count: 1 },
  { family: "projects", invoiced: 50_000, credit_notes: 0, debit_notes: 500, invoice_count: 1 },
];
const totals = { invoiced: 83_635, creditNotes: 1_371, debitNotes: 500 };

describe("revenueByProduct", () => {
  it("each family is net of its own notes; the families add up to Revenue", () => {
    const fam = revenueByProduct(rows, totals)!;
    expect(fam.map((f) => [f.label, f.net])).toEqual([
      ["Google Workspace", 31_400], ["Hosting", 864], ["Software projects", 50_500],
    ]);
    expect(fam.reduce((s, f) => s + f.net, 0)).toBe(totals.invoiced - totals.creditNotes + totals.debitNotes);
  });

  it("numbers that come back as strings (bigint) are read as numbers", () => {
    const asStrings = rows.map((r) => ({ ...r, invoiced: String(r.invoiced) as unknown as number }));
    expect(revenueByProduct(asStrings, totals)?.[0].invoiced).toBe(32_400);
  });

  it.each([
    ["the function is not on this database", null],
    ["no answer", undefined],
  ])("null when %s — the statement keeps the R-1833 lines", (_why, r) => {
    expect(revenueByProduct(r, totals)).toBeNull();
  });

  it.each([
    ["invoiced", { ...totals, invoiced: totals.invoiced + 1 }],
    ["credit notes", { ...totals, creditNotes: totals.creditNotes - 1 }],
    ["debit notes", { ...totals, debitNotes: 0 }],
  ])("null when the %s do not add up to report_pnl to the rupee", (_what, t) => {
    expect(revenueByProduct(rows, t)).toBeNull();
  });

  it("no sales in the period: an empty split, not null", () => {
    expect(revenueByProduct([], { invoiced: 0, creditNotes: 0, debitNotes: 0 })).toEqual([]);
  });
});
