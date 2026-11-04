import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* R-2479 (4 Nov 2026): scripts/ops/report-cross-tenant-bank-links.sql is run by Pardeep on staging
   and live (docs/playbooks/cross-tenant-bank-links.md) to find bank lines already linked to ANOTHER
   company's record before R-2472 closed the gap. It must only READ, and it must find a planted link.

   Part 1 (always): no write / DDL keyword outside comments and strings; begin + set transaction read
   only … rollback; no name / email / phone / description column; R-2472's map inlined, the same in
   both statements that use it.
   Part 2 (only where the local Supabase container runs — skipped in CI, which has no DB for vitest):
   the report runs on the LOCAL DB inside one transaction after a planted fixture (company A's lines
   linked to company B's records in every way the report knows, plus a clean same-company link),
   then rolls everything back. Planted → found in its section; clean → 0 rows; a missing table is
   skipped and listed. */

const FILE = fileURLToPath(new URL("../../scripts/ops/report-cross-tenant-bank-links.sql", import.meta.url));
const SQL = readFileSync(FILE, "utf8");
const CONTAINER = "supabase_db_resellerosv3";

/** The SQL with -- comments and block comments removed and string literals blanked. */
function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}

const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop",
  "grant", "revoke", "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze",
  "reindex", "cluster", "refresh", "lock", "listen", "notify", "commit", "savepoint", "reset",
  "security", "into", "nextval", "setval", "dblink", "lo_import", "lo_export", "pg_terminate_backend",
  "pg_cancel_backend", "pg_advisory_lock", "set_config", "pg_read_file", "pg_write_file",
];

/** Forbidden words found; "set" only as `set transaction read only`; psql only \echo / \pset. */
function forbidden(sql: string): string[] {
  const code = codeOnly(sql).toLowerCase();
  const hits = WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code));
  for (const s of code.match(/(^|[^\\\w])set\b[^;]*/g) ?? []) {
    if (!/set\s+transaction\s+read\s+only\s*$/.test(s.trim())) hits.push(`set: ${s.trim().slice(0, 40)}`);
  }
  for (const m of code.match(/\\[a-z!]+/g) ?? []) {
    if (m !== "\\echo" && m !== "\\pset") hits.push(m);
  }
  return hits;
}

describe("R-2479 cross-tenant bank links report — read-only", () => {
  it("has no write, DDL or side-effect keyword outside comments", () => {
    expect(forbidden(SQL)).toEqual([]);
  });

  it("runs inside begin; set transaction read only; … rollback;", () => {
    const code = codeOnly(SQL).toLowerCase().replace(/\s+/g, " ").trim();
    expect(code.startsWith("begin; set transaction read only;")).toBe(true);
    expect(code.endsWith("rollback;")).toBe(true);
    expect(code.match(/\bbegin\b/g)?.length).toBe(1);
  });

  it("selects only ids, tenant ids, dates, amounts and match types — no names or contact fields", () => {
    expect(codeOnly(SQL)).not.toMatch(/email|phone|mobile|description|customer_name|vendor_name|narration|\bname\b/i);
  });

  it("inlines R-2472's match-type → table map (works without bank_match_target_tenant)", () => {
    expect(codeOnly(SQL)).not.toMatch(/bank_match_target_tenant|bank_match_uuid/);
    for (const [type, table] of [
      ["payment", "payments"], ["expense", "expenses"], ["vendor_bill", "vendor_bills"],
      ["project", "project_payments"], ["salary", "salary_payments"], ["transfer", "bank_transactions"],
      ["other_income", "other_incomes"], ["loan_given", "loan_repayments"], ["loan_given", "loans_given"],
      ["business_loan", "business_loans"], ["loan_drawdown", "business_loan_drawdowns"],
      ["loan_repayment", "business_loan_payments"],
    ]) {
      expect(SQL).toContain(`('${type}', '${table}')`);
    }
    for (const t of ["payments", "project_payments", "prepaid_advances", "tax_payments", "statutory_dues_payments",
      "balance_sheet_items", "bank_vendor_payment_lines", "owner_equity_movements", "emi_payments"]) {
      expect(SQL).toContain(`('${t}', 'bank_txn_id')`);
    }
    expect(SQL).toContain("('expenses', 'reconciled_txn_id')");
    expect(SQL).toContain("('salary_payments', 'reconciled_txn_id')");
  });

  it("the map block is the same in section 0b and section 1", () => {
    const blocks = SQL.split("-- MAPS BEGIN").slice(1).map((b) => b.split("-- MAPS END")[0]);
    expect(blocks.length).toBe(2);
    expect(blocks[1]).toBe(blocks[0]);
  });

  it("the checker itself catches a write (mutation check)", () => {
    expect(forbidden("begin; set transaction read only; update public.payments set amount = 0; rollback;")).toContain("update");
    expect(forbidden("set role postgres;")).not.toEqual([]);
    expect(forbidden("\\i other.sql")).toContain("\\i");
    expect(forbidden("select 'please delete' as note -- insert here is a comment")).toEqual([]);
  });
});

/* ── Part 2: on the local DB ─────────────────────────────────────────────────────────────── */

function localDbUp(): boolean {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.split(/\r?\n/).includes(CONTAINER);
}

const id = (n: string) => `e2479000-0000-4000-8000-${n.padStart(12, "0")}`;
const A = id("a0"); // company A
const B = id("b0"); // company B
const A_ACC = id("a1");
const B_ACC = id("b1");
const EMP = id("e1"); // placeholder employee / quote / project id (FK checks are off)
// A's bank lines
const A_LINE_PAY = id("a001"); // → B's payment                     (A forward, uuid id)
const A_LINE_SAL = id("a002"); // → B's salary, id upper-case       (A forward + C salary)
const A_LINE_REV = id("a003"); // B's project receipt + B's loan point here (B reverse: list + FK)
const A_LINE_OK = id("a004"); // → A's own payment                  (clean, never reported)
const A_LINE_EXP = id("a005"); // → B's expense (text id)           (A forward, text id)
const A_LINE_TRF = id("a006"); // → B's bank line                   (A forward, transfer)
const A_LINE_REC = id("a007"); // B's salary.reconciled_txn_id here (C salary + B reverse)
const A_LINE_PRE = id("a008"); // 'prepaid' → B's prepaid advance   (D other type)
// B's records
const B_LINE = id("b001");
const B_PAY = id("b011");
const B_SAL = id("b012");
const B_PROJ = id("b013");
const B_SAL2 = id("b014");
const B_PRE = id("b015");
const B_LOAN = id("b016");
const B_EXP = "R2479-EXP-B";
const A_PAY = id("a011");

/** Fixture rows. session_replication_role = replica skips triggers (R-2472's gate would refuse
    the planted link — that is the point of R-2472) and FK checks, so only the columns the report
    reads (and NOT NULL ones) are needed. Rolled back with the report's own rollback.
    cross = false: the same lines point only at A's own records (or at nothing). */
function fixture(cross: boolean, hideTable = false): string {
  const q = (v: string | null) => (v === null ? "null" : `'${v}'`);
  const x = (crossValue: string | null, cleanValue: string | null) => (cross ? crossValue : cleanValue);
  const line = (lid: string, type: string | null, target: string | null, debit: number, credit: number) =>
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, matched_to_type, matched_to_id)
       values ('${lid}', '${A}', '${A_ACC}', date '2026-05-0${debit ? 2 : 1}', 'r2479 fixture', ${debit}, ${credit}, ${q(type)}, ${q(target)});`;
  return [
    "set local session_replication_role = replica;",
    "set local lock_timeout = '30s';", // other workers' SQL tests may hold a table for a moment
    // An older DB (e.g. live before a deploy) may not have every mapped table: hide one.
    ...(hideTable ? ["alter table public.business_loan_drawdowns rename to r2479_hidden_drawdowns;"] : []),
    `insert into public.payments (id, tenant_id, quote_id, amount, method) values ('${B_PAY}', '${B}', '${EMP}', 1000, 'bank_transfer'), ('${A_PAY}', '${A}', '${EMP}', 500, 'bank_transfer');`,
    `insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net, paid_status, paid_amount, reconciled_txn_id)
       values ('${B_SAL}', '${B}', '${EMP}', '2026-04', date '2026-05-01', 30000, 30000, 'paid', 30000, null),
              ('${B_SAL2}', '${B}', '${EMP}', '2026-03', date '2026-04-01', 20000, 20000, 'paid', 20000, ${q(x(A_LINE_REC, null))});`,
    `insert into public.project_payments (id, tenant_id, project_id, amount, bank_txn_id) values ('${B_PROJ}', '${B}', '${EMP}', 700, ${q(x(A_LINE_REV, null))});`,
    `insert into public.expenses (id, tenant_id, category, expense_date, amount) values ('${B_EXP}', '${B}', 'r2479', date '2026-05-01', 400);`,
    `insert into public.prepaid_advances (id, tenant_id, vendor_name, total_amount) values ('${B_PRE}', '${B}', 'r2479', 900);`,
    `insert into public.business_loans (id, tenant_id, lender, principal, disbursed_on, disbursal_bank_txn_id)
       values ('${B_LOAN}', '${B}', 'r2479', 5000, date '2026-05-01', ${q(x(A_LINE_REV, null))});`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit)
       values ('${B_LINE}', '${B}', '${B_ACC}', date '2026-05-01', 'r2479 fixture', 0, 1);`,
    line(A_LINE_PAY, "payment", x(B_PAY, A_PAY), 0, 1000),
    line(A_LINE_SAL, "salary", x(B_SAL.toUpperCase(), A_PAY), 30000, 0),
    line(A_LINE_REV, "manual", null, 0, 700),
    line(A_LINE_OK, "payment", A_PAY, 0, 500),
    line(A_LINE_EXP, "expense", x(B_EXP, "R2479-EXP-NONE"), 400, 0),
    line(A_LINE_TRF, "transfer", x(B_LINE, A_LINE_OK), 1, 0),
    line(A_LINE_REC, null, null, 20000, 0),
    line(A_LINE_PRE, "prepaid", x(B_PRE, A_PAY), 900, 0),
  ].join("\n");
}

/** The report with the fixture planted right after its own `begin;` (switching a transaction TO
    read only after writes is allowed), unaligned output so rows can be split on "|". */
function runReport(cross: boolean, hideTable = false): string {
  const input = "\\pset format unaligned\n" + SQL.replace(/^begin;/m, `begin;\n${fixture(cross, hideTable)}\n`);
  expect(input).not.toBe(SQL);
  const r = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input, encoding: "utf8", timeout: 120_000 },
  );
  expect(r.stderr).not.toMatch(/ERROR/);
  expect(r.status).toBe(0);
  return r.stdout;
}

/** Section 1 rows that involve the fixture. */
const fixtureRows = (out: string) =>
  (out.split("=== 1.")[1] ?? "").split(/\r?\n/).filter((l) => l.includes("e2479000-"));

/** Section 0b rows (checks skipped / rows that may be hidden). */
function skippedChecks(out: string): string[] {
  const part = out.split("=== 0b.")[1]?.split("=== 1.")[0] ?? "";
  return part.split(/\r?\n/).filter((l) => /^[ABD] /.test(l));
}

describe.skipIf(!localDbUp())("R-2479 report on the local DB (planted fixture, rolled back)", () => {
  it("finds every planted cross-company link in its section", () => {
    const out = runReport(true);
    const rows = fixtureRows(out);
    const has = (section: string, line: string, table: string, linked: string) =>
      rows.some((r) => {
        const c = r.split("|");
        return c[0].startsWith(section) && c[2] === line && c[3] === A && c[7] === table && c[8] === linked && c[9] === B;
      });
    expect(has("A ", A_LINE_PAY, "payments", B_PAY)).toBe(true);
    expect(has("A ", A_LINE_SAL, "salary_payments", B_SAL)).toBe(true); // upper-case id still found
    expect(has("A ", A_LINE_EXP, "expenses", B_EXP)).toBe(true); // text id
    expect(has("A ", A_LINE_TRF, "bank_transactions", B_LINE)).toBe(true); // transfer
    expect(has("B ", A_LINE_REV, "project_payments.bank_txn_id", B_PROJ)).toBe(true);
    expect(has("B ", A_LINE_REV, "business_loans.disbursal_bank_txn_id", B_LOAN)).toBe(true); // found via FK
    expect(has("B ", A_LINE_REC, "salary_payments.reconciled_txn_id", B_SAL2)).toBe(true);
    expect(has("C ", A_LINE_SAL, "salary_payments", B_SAL)).toBe(true); // 'salary' line
    expect(has("C ", A_LINE_REC, "salary_payments", B_SAL2)).toBe(true); // reconciled_txn_id
    expect(has("D ", A_LINE_PRE, "prepaid_advances", B_PRE)).toBe(true); // own-flow type
    expect(rows.some((r) => r.includes(`${A_LINE_OK}|`))).toBe(false); // own-company link not reported
    expect(skippedChecks(out)).toEqual([]); // every check ran on the full local schema
  });

  it("still runs when a mapped table does not exist (older schema) and lists the skipped checks", () => {
    const out = runReport(true, true);
    expect(fixtureRows(out).some((r) => r.startsWith("A ") && r.includes(B_PAY))).toBe(true);
    const skipped = skippedChecks(out);
    expect(skipped.some((l) => l.startsWith("A forward|business_loan_drawdowns|loan_drawdown|f"))).toBe(true);
    expect(skipped.some((l) => l.startsWith("B reverse|business_loan_drawdowns|bank_txn_id|f"))).toBe(true);
  });

  it("clean data (same-company links only) → 0 fixture rows", () => {
    expect(fixtureRows(runReport(false))).toEqual([]);
  });

  it("leaves nothing behind (rolled back)", () => {
    const r = spawnSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", "postgres", "-c",
        `select ((select count(*) from public.tenants where id in ('${A}', '${B}'))
               + (select count(*) from public.bank_transactions where id::text like 'e2479000-%')
               + (select count(*) from public.payments where id::text like 'e2479000-%')
               + (select count(*) from public.salary_payments where id::text like 'e2479000-%')
               + (select count(*) from public.expenses where id = '${B_EXP}')
               + (select count(*) from public.business_loans where id::text like 'e2479000-%'))::text
              || ' ' || (to_regclass('public.business_loan_drawdowns') is not null)::text
              || ' ' || (to_regclass('public.r2479_hidden_drawdowns') is null)::text`],
      { encoding: "utf8" },
    );
    expect(r.stdout.trim()).toBe("0 true true");
  });
});
