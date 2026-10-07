/**
 * R-265 — the reports that sum rows in the browser must read every row, not the first 1000.
 *
 * PostgREST answers at most 1000 rows and says nothing when it truncated, so a bare
 * `select` with no `.range()` is right today and silently wrong the day a tenant passes a
 * thousand rows. The Cash Flow loader has its own behaviour test (load.test.ts); the other
 * four reports are guarded by a source scan, because the defect is an ABSENCE — a missing
 * `.range()` — that no unit test of a hook can see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Comments stripped: prose explaining a removed pattern must not satisfy the scan. */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const REPORTS: [string, string[]][] = [
  ["src/app/(app)/accounting/cash-flow/load.ts",      ["bank_accounts", "bank_transactions"]],
  ["src/app/(app)/reports/purchases/page.tsx",        ["expenses", "vendor_bills"]],
  ["src/app/(app)/accounting/saas-metrics/page.tsx",  ["subscriptions"]],
  ["src/lib/queries/pnl.ts",                          ["subscriptions", "project_labour", "employees", "project_sales", "items"]],
  ["src/lib/queries/gst-health.ts",                   ["invoices", "customers"]],
];

describe("reports page past the 1000-row cap (R-265)", () => {
  it.each(REPORTS)("%s uses fetchAllRows", (file) => {
    const src = strip(file);
    expect(src).toContain("@/lib/ops/fetch-all");
    expect(src).toMatch(/fetchAllRows(In)?\(/);
  });

  it.each(REPORTS)("%s: every summed table ends in .order(\"id\") + .range()", (file, tables) => {
    const src = strip(file);
    for (const t of tables) {
      const hits = src.split(`.from("${t}")`).slice(1);
      expect(hits.length, `${t} not read in ${file}`).toBeGreaterThan(0);
      for (const tail of hits) {
        /* Up to the end of this query — the next `.from(` or the end of the builder call. */
        const q = tail.split(".from(")[0].slice(0, 500);
        expect(q, `${file}: ${t} read with no .range()`).toContain(".range(");
        expect(q, `${file}: ${t} paged without a unique tie-break`).toContain('.order("id")');
      }
    }
  });
});
