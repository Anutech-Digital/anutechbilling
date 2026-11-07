import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* R-2538 (7 Nov 2026): the TDS-gross-vs-part-paid report only READS (the manager runs it on staging;
   repairs stay Pardeep's call). */

const FILE = fileURLToPath(new URL("../../scripts/ops/r2538-tds-gross-part-report.sql", import.meta.url));

function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}
const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop", "grant", "revoke",
  "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze", "reindex", "cluster", "refresh",
  "lock", "listen", "notify", "commit", "savepoint", "reset", "security", "into", "nextval", "setval",
  "set_config", "pg_read_file", "pg_write_file",
];

describe("R-2538 TDS gross report — read-only", () => {
  const sql = readFileSync(FILE, "utf8");
  it("runs inside begin; set transaction read only; … rollback; with no write or DDL", () => {
    const code = codeOnly(sql).toLowerCase();
    expect(code).toMatch(/^\s*begin;\s*set transaction read only;/m);
    expect(code.trim().endsWith("rollback;")).toBe(true);
    expect(WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code))).toEqual([]);
    for (const m of code.match(/\\[a-z!]+/g) ?? []) expect(["\\echo", "\\pset"]).toContain(m);
  });
  it("selects no contact field", () => {
    expect(codeOnly(sql).toLowerCase()).not.toMatch(/\b(email|phone|contact_email|contact_phone)\b/);
  });
  it("uses the same part-gross rule as bank_credit_tds_part_gross", () => {
    expect(sql).toMatch(/least\(b\.taxable, round\(b\.receipt_amount \* b\.taxable \/ b\.total\)\)/);
  });
});
