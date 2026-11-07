import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* R-2570 (7 Nov 2026): old bank lines still stored as 'manual' — a READ-ONLY count report (the manager
   runs it on staging) and a separate repair that is a dry run unless -v apply=1 (Pardeep's yes). Both
   must pick the SAME lines, so the plan block is one text in both files. */

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../scripts/ops/${f}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const REPORT = read("r2570-bank-line-type-report.sql");
const REPAIR = read("r2570-bank-line-type-repair.sql");

function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}
function plan(sql: string): string {
  const a = sql.indexOf("-- R2570-PLAN-BEGIN");
  const b = sql.indexOf("-- R2570-PLAN-END");
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return sql.slice(a, b);
}
const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop", "grant", "revoke",
  "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze", "reindex", "cluster", "refresh",
  "lock", "listen", "notify", "commit", "savepoint", "reset", "security", "into", "nextval", "setval",
  "set_config", "pg_read_file", "pg_write_file",
];

describe("R-2570 bank line type report — read-only", () => {
  it("runs inside begin; set transaction read only; … rollback; with no write or DDL", () => {
    const code = codeOnly(REPORT).toLowerCase();
    expect(code).toMatch(/^\s*begin;\s*set transaction read only;/m);
    expect(code.trim().endsWith("rollback;")).toBe(true);
    expect(WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code))).toEqual([]);
    for (const m of code.match(/\\[a-z!]+/g) ?? []) expect(["\\echo", "\\pset"]).toContain(m);
  });
  it("selects no contact field and no narration", () => {
    const code = codeOnly(REPORT).toLowerCase();
    expect(code).not.toMatch(/\b(email|phone|contact_email|contact_phone)\b/);
    expect(code).not.toMatch(/select[^;]*\bdescription\s+as\b/);
  });
});

describe("R-2570 bank line type repair — safe by default", () => {
  it("plans exactly the lines the report counts (one plan text)", () => {
    expect(plan(REPAIR)).toBe(plan(REPORT));
  });
  it("is a dry run (rollback) unless apply is exactly 1, clears apply after, and stops when the migration is missing", () => {
    expect(REPAIR).toContain("select (:'apply' = '1') as r2570_apply \\gset");
    expect(REPAIR).toMatch(/\\set r2570_apply false\n/);
    expect(REPAIR).toMatch(/\\if :r2570_apply\n\s+\\echo [^\n]*\n\s+commit;\n\\else\n\s+\\echo [^\n]*\n\s+rollback;\n\\endif\n\\unset apply\n/);
    expect(REPAIR).toMatch(/pg_get_constraintdef\(oid\) like '%employee_loan%'/);
    expect(REPAIR.indexOf("commit;")).toBeGreaterThan(REPAIR.indexOf("\\if :r2570_apply"));
  });
  it("leaves old Loans-given receipt lines manual (their un-reconcile would keep the line — review)", () => {
    expect(plan(REPAIR)).not.toContain("loan_repayments");
  });
  it("only retypes 'manual' lines with no id, and touches no money column", () => {
    const code = codeOnly(REPAIR).toLowerCase();
    expect(code).toMatch(/where t\.id = p\.id and t\.matched_to_type = '' and t\.matched_to_id is null/);
    const sets = [...code.matchAll(/\bset\s+([\s\S]*?)\bfrom\b/g)].map((m) => m[1]);
    expect(sets.join(" ")).not.toMatch(/\b(debit|credit|amount|txn_date|bank_account_id|tenant_id)\s*=/);
    expect(code).not.toMatch(/\bdelete\b/);
  });
  it("leaves lines alone that a type change would disturb (notes, reversal pairs, receipts, settlements, staff-advance links)", () => {
    const p = plan(REPORT);
    for (const s of ["reconcile_note is not null", "reversal_of = c.id", "public.payments p where p.bank_txn_id", "razorpay_settlement_recons", "employee_advance_bank_links"]) {
      expect(p).toContain(s);
    }
  });
});
