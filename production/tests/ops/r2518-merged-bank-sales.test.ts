import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs ops script, no types
import { groupMergedSale, dryRunSql, readInput } from "../../scripts/ops/r2518-group-merged-sale.mjs";

/* R-2518 (6 Nov 2026): the merged-bank-sales report only READS, and the grouping script turns its
   section 4 into the owner's DRY-RUN repair calls (staging's Excel case: 4 lines → INV/26-27/0516 +
   INV/26-27/0517). */

const FILE = fileURLToPath(new URL("../../scripts/ops/r2518-merged-bank-sales-report.sql", import.meta.url));

function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}
const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop", "grant", "revoke",
  "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze", "reindex", "cluster", "refresh",
  "lock", "listen", "notify", "commit", "savepoint", "reset", "security", "into", "nextval", "setval",
  "set_config", "pg_read_file", "pg_write_file", "repair_split_merged_bank_sale", "undo_split_merged_bank_sale",
];

describe("R-2518 report — read-only", () => {
  const sql = readFileSync(FILE, "utf8");
  it("runs inside begin; set transaction read only; … rollback; with no write, DDL or repair call", () => {
    const code = codeOnly(sql).toLowerCase();
    expect(code).toMatch(/^\s*begin;\s*set transaction read only;/m);
    expect(code.trim().endsWith("rollback;")).toBe(true);
    expect(WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code))).toEqual([]);
    for (const m of code.match(/\\[a-z!]+/g) ?? []) expect(["\\echo", "\\pset"]).toContain(m);
  });
  it("selects no contact field", () => {
    expect(codeOnly(sql).toLowerCase()).not.toMatch(/\b(email|phone|contact_email|contact_phone)\b/);
  });
});

const TWO_INV = {
  invoice_id: "INV-A378-27-0490",
  quote_lines: [
    { id: "line-1", name: "Workspace seat", qty: 15, rate: 180 },
    { id: "line-2", name: "Extra storage", qty: 1, rate: 48 },
    { id: "line-3", name: "Workspace seat", qty: 14, rate: 180 },
    { id: "line-4", name: "Extra storage", qty: 1, rate: 66 },
  ],
  zoho_invoices: [
    { number: "INV/26-27/0516", lines: [{ name: "Google Workspace", qty: 15, rate: 180 }, { name: "Storage", qty: 1, rate: 48 }] },
    { number: "INV/26-27/0517", lines: [{ name: "Google Workspace", qty: 14, rate: 180 }, { name: "Storage", qty: 1, rate: 66 }] },
  ],
};

describe("R-2518 grouping script", () => {
  it("maps each app line to its Zoho invoice by quantity + rate", () => {
    expect(groupMergedSale(TWO_INV)).toEqual({
      invoiceId: "INV-A378-27-0490",
      groups: [
        { external_number: "INV/26-27/0516", line_ids: ["line-1", "line-2"] },
        { external_number: "INV/26-27/0517", line_ids: ["line-3", "line-4"] },
      ],
    });
  });
  it("prints a DRY-RUN call only (true), SQL-quoted", () => {
    const s = dryRunSql(groupMergedSale({ ...TWO_INV, invoice_id: "INV-O'1" }));
    expect(s).toMatch(/^select public\.repair_split_merged_bank_sale\('INV-O''1', '\[.*\]'::jsonb, true\);$/);
  });
  it("a line with no Zoho twin, or one Zoho invoice only → SKIP with the reason", () => {
    expect(dryRunSql(groupMergedSale({ ...TWO_INV, quote_lines: [...TWO_INV.quote_lines, { id: "line-5", name: "Setup", qty: 1, rate: 999 }] })))
      .toMatch(/^-- SKIP INV-A378-27-0490: no Zoho line with the same quantity and rate for: 1 × 999 Setup$/);
    expect(dryRunSql(groupMergedSale({ ...TWO_INV, zoho_invoices: [TWO_INV.zoho_invoices[0]] }))).toMatch(/^-- SKIP .*only 1 Zoho invoice/);
  });
  it("reads a JSON array or one object per line", () => {
    expect(readInput(JSON.stringify([TWO_INV]))).toHaveLength(1);
    expect(readInput(` grouping_input\n ${JSON.stringify(TWO_INV)}\n(1 row)\n`)).toHaveLength(1);
  });
});
