/**
 * R-046 — the billing lists must not stop at 1000 rows, and the GST heads must come from
 * one place.
 *
 * PostgREST answers at most `max_rows` rows (supabase/config.toml: 1000) and says NOTHING
 * when it truncated. So `select("*")` with no range is correct today and silently wrong the
 * day a tenant passes a thousand invoices: no error, no warning, a page that looks whole.
 * That is the shape AGENTS.md §2 is entirely about, and it gets worse as the business grows.
 *
 * Source scans, because the defect is an ABSENCE — a missing `.range()`, a missing tie-break
 * — and no unit test of a hook can see what the hook forgot to call (L85).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitTaxHeads, splitIntraStateTax } from "@/lib/gst/tax-split";

/** Comments stripped: the prose explaining a removed pattern must not satisfy a scan for it (L46). */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LISTS = [
  ["src/lib/queries/invoices.ts",      "invoices"],
  ["src/lib/queries/subscriptions.ts", "subscriptions"],
  ["src/lib/queries/customers.ts",     "customers"],
  /* R-264 — the money lists R-046 left on a bare select: same 1000-row cut, same silence. */
  ["src/lib/queries/payments.ts",        "payments"],
  ["src/lib/queries/quotes.ts",          "quotes"],
  ["src/lib/queries/expenses.ts",        "expenses"],
  ["src/lib/queries/vendor-bills.ts",    "vendor_bills"],
  ["src/lib/queries/purchase-orders.ts", "purchase_orders"],
  ["src/lib/queries/vendors.ts",         "vendors"],
  ["src/lib/queries/projects.ts",        "project_sales"],
] as const;

/* R-264 — list hooks whose totals are rolled up from OTHER tables in the browser. A capped
   rollup is the same bug one step removed: vendor 'outstanding' or project 'receivable'
   summed over the first 1000 bills/payments. Every select inside these hooks must page. */
const ROLLUPS = [
  ["src/lib/queries/vendors.ts",  "useVendors"],
  ["src/lib/queries/projects.ts", "useProjectSales"],
] as const;

describe("list rollups page every table they sum (R-264)", () => {
  it.each(ROLLUPS)("%s %s", (file, fn) => {
    const src = strip(file);
    const start = src.indexOf(`export function ${fn}(`);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const next = src.indexOf("export function", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    const selects = body.split(".select(").slice(1);
    expect(selects.length).toBeGreaterThan(1);
    for (const tail of selects) {
      expect(tail.slice(0, 300), `${fn}: a select with no .range() before the next statement`)
        .toContain(".range(");
    }
  });
});

describe("the billing lists page past the 1000-row cap", () => {
  it.each(LISTS)("%s reads every row", (file) => {
    const src = strip(file);
    expect(src).toContain("fetchAllRows");
    expect(src).toContain("@/lib/ops/fetch-all");
  });

  it.each(LISTS)("%s orders on a UNIQUE column last", (file, table) => {
    /* The part that is easy to leave out and impossible to notice. An offset page over an
       order with ties can repeat a row on one page and skip it on the next, so the list is
       wrong in BOTH directions while looking ordinary. The helper's own header says the
       query must have a total order; this asserts the caller obeyed it. */
    const src = strip(file);
    const block = src.slice(src.indexOf(`.from("${table}")`));
    expect(block.slice(0, 400)).toContain('.order("id"');
  });

  it("none of them still ends in a bare select with no range", () => {
    for (const [file, table] of LISTS) {
      const src = strip(file);
      /* The old shape: `.from(x).select("*").order(...)` and then straight to `await`.
         A `.range(` must appear before the query is awaited. */
      const i = src.indexOf(`.from("${table}")`);
      expect(src.slice(i, i + 500), `${file} has no .range() on the list query`)
        .toContain(".range(");
    }
  });
});

describe("the GST heads come from the shared split", () => {
  /* The arithmetic itself is Pardeep's and is tested in lib/gst/tax-split.test.ts. What is
     asserted here is that the three STATUTORY documents use it rather than their own copy —
     six copies of this split existed in the tree. */
  it.each([
    ["src/lib/pdf/InvoicePDF.tsx",                            "tax invoice PDF"],
    ["src/components/features/quotes/tax-invoice-dialog.tsx", "tax invoice dialog"],
    ["src/lib/pdf/ReceiptVoucherPDF.tsx",                     "receipt voucher PDF"],
  ])("%s (%s)", (file) => {
    const src = strip(file);
    expect(src).toMatch(/splitTaxHeads|splitIntraStateTax/);
    // …and no hand-rolled half left in the same file.
    expect(src).not.toMatch(/Math\.round\(\s*\w*[Tt]ax\s*\/\s*2\s*\)/);
  });

  it("agrees with the old arithmetic on an ordinary invoice, and differs where it should", () => {
    /* Said plainly rather than sold as a fix: for a POSITIVE whole-rupee tax the shared
       helper returns exactly what `Math.round(tax / 2)` returned, so nothing on a normal
       invoice moves. */
    for (const tax of [180, 181, 21240, 1]) {
      const { cgst, sgst } = splitIntraStateTax(tax);
      expect(cgst).toBe(Math.round(tax / 2));
      expect(cgst + sgst).toBe(tax);
    }

    /* Where it DOES differ is the case that would have reached GSTR-1 wrong: a credit note
       carries NEGATIVE tax, and JS rounds -90.5 to -90, so the odd rupee lands on the other
       head and the note reverses CGST/SGST differently from the invoice it credits. */
    const { cgst, sgst } = splitIntraStateTax(-181);
    expect(cgst).toBe(-91);
    expect(sgst).toBe(-90);
    expect(Math.round(-181 / 2)).toBe(-90);   // what the old line would have produced
    expect(cgst + sgst).toBe(-181);
  });

  it("an inter-state supply puts everything in IGST and nothing in CGST/SGST", () => {
    const heads = splitTaxHeads(181, true);
    expect(heads).toEqual({ igst: 181, cgst: 0, sgst: 0 });
    expect(splitTaxHeads(181, false).igst).toBe(0);
  });
});
