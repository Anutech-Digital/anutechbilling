import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* R-2479 (4 Nov 2026): scripts/ops/report-cross-tenant-bank-links.sql is run by Pardeep on staging
   and live (docs/playbooks/cross-tenant-bank-links.md) to find bank lines already linked to ANOTHER
   company's record before R-2472 closed the gap. It must only READ, and it must find a planted link.

   Part 1 (always): no write / DDL keyword outside comments and strings; begin + set transaction read
   only … rollback; no name / email / phone / description column.
   Part 2 (only where the local Supabase container runs — skipped in CI, which has no DB for vitest):
   the report runs on the LOCAL DB inside one transaction after a planted fixture (company A's line
   matched to company B's payment / salary, B's receipt pointing at A's line, plus a clean same-
   company link), then rolls everything back. Planted → found in every section; clean → 0 rows. */

const FILE = fileURLToPath(new URL("../../scripts/ops/report-cross-tenant-bank-links.sql", import.meta.url));
const SQL = readFileSync(FILE, "utf8");
const CONTAINER = "supabase_db_resellerosv3";

/** The SQL with -- comments, block comments, $q$ bodies kept but string literals blanked. */
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

const A = "e2479000-0000-4000-8000-0000000000a0"; // company A
const B = "e2479000-0000-4000-8000-0000000000b0"; // company B
const A_ACC = "e2479000-0000-4000-8000-0000000000a1";
const B_ACC = "e2479000-0000-4000-8000-0000000000b1";
const A_LINE_PAY = "e2479000-0000-4000-8000-00000000a001"; // A's line → B's payment (forward)
const A_LINE_SAL = "e2479000-0000-4000-8000-00000000a002"; // A's line → B's salary (forward + salary)
const A_LINE_REV = "e2479000-0000-4000-8000-00000000a003"; // B's project receipt points at this A line (reverse)
const A_LINE_OK = "e2479000-0000-4000-8000-00000000a004"; // A's line → A's own payment (clean)
const B_PAY = "e2479000-0000-4000-8000-00000000b011";
const B_SAL = "e2479000-0000-4000-8000-00000000b012";
const B_PROJ = "e2479000-0000-4000-8000-00000000b013";
const A_PAY = "e2479000-0000-4000-8000-00000000a011";
const EMP = "e2479000-0000-4000-8000-00000000b0e1";

/** Fixture rows. session_replication_role = replica skips triggers (R-2472's gate would refuse
    the planted link — that is the point of R-2472) and FK checks, so only the columns the report
    reads are needed. Rolled back with the report's own rollback. */
function fixture(cross: boolean, hideTable = false): string {
  const line = (id: string, t: string, acc: string, type: string, target: string | null, debit: number, credit: number) =>
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, matched_to_type, matched_to_id)
       values ('${id}', '${t}', '${acc}', date '2026-05-0${debit ? 2 : 1}', 'r2479 fixture', ${debit}, ${credit}, '${type}', ${target === null ? "null" : `'${target}'`});`;
  return [
    "set local session_replication_role = replica;",
    // An older DB (e.g. live before a deploy) may not have every mapped table: hide one.
    ...(hideTable ? ["alter table public.business_loan_drawdowns rename to r2479_hidden_drawdowns;"] : []),
    `insert into public.tenants (id, name, email) values ('${A}', 'R2479 A', 'r2479a@example.test'), ('${B}', 'R2479 B', 'r2479b@example.test');`,
    `insert into public.payments (id, tenant_id, quote_id, amount, method) values ('${B_PAY}', '${B}', '${EMP}', 1000, 'bank_transfer'), ('${A_PAY}', '${A}', '${EMP}', 500, 'bank_transfer');`,
    `insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net, paid_status, paid_amount)
       values ('${B_SAL}', '${B}', '${EMP}', '2026-04', date '2026-05-01', 30000, 30000, 'paid', 30000);`,
    `insert into public.project_payments (id, tenant_id, project_id, amount, bank_txn_id) values ('${B_PROJ}', '${B}', '${EMP}', 700, ${cross ? `'${A_LINE_REV}'` : "null"});`,
    line(A_LINE_PAY, A, A_ACC, "payment", cross ? B_PAY : A_PAY, 0, 1000),
    line(A_LINE_SAL, A, A_ACC, "salary", cross ? B_SAL.toUpperCase() : A_PAY, 30000, 0),
    line(A_LINE_REV, A, A_ACC, "manual", null, 0, 700),
    line(A_LINE_OK, A, A_ACC, "payment", A_PAY, 0, 500),
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit)
       values ('e2479000-0000-4000-8000-00000000b001', '${B}', '${B_ACC}', date '2026-05-01', 'r2479 fixture', 0, 1);`,
  ].join("\n");
}

/** The report with the fixture planted right after its own `begin;` (switching a transaction TO
    read only after writes is allowed), aligned unformatted output so rows can be grepped. */
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

const fixtureRows = (out: string) => out.split(/\r?\n/).filter((l) => l.includes("e2479000-"));

describe.skipIf(!localDbUp())("R-2479 report on the local DB (planted fixture, rolled back)", () => {
  it("finds the planted cross-company links in every section", () => {
    const rows = fixtureRows(runReport(true));
    const has = (section: string, line: string, linked: string) =>
      rows.some((r) => r.startsWith(section) && r.includes(line) && r.includes(linked));
    expect(has("A ", A_LINE_PAY, B_PAY)).toBe(true); // forward: A's line → B's payment
    expect(has("A ", A_LINE_SAL, B_SAL)).toBe(true); // forward: upper-case id still found
    expect(has("B ", A_LINE_REV, B_PROJ)).toBe(true); // reverse: B's project receipt → A's line
    expect(has("C ", A_LINE_SAL, B_SAL)).toBe(true); // salary paid from A's line
    expect(rows.some((r) => r.includes(A_LINE_OK))).toBe(false); // own-company link not reported
    expect(rows.every((r) => r.includes(A) && r.includes(B))).toBe(true); // both tenant ids shown
  });

  it("still runs when a mapped table does not exist on the DB (older schema)", () => {
    const rows = fixtureRows(runReport(true, true));
    expect(rows.some((r) => r.startsWith("A ") && r.includes(B_PAY))).toBe(true);
  });

  it("clean data (same-company links only) → 0 fixture rows", () => {
    expect(fixtureRows(runReport(false))).toEqual([]);
  });

  it("leaves nothing behind (rolled back)", () => {
    const r = spawnSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", "postgres",
        "-c", `select count(*) from public.tenants where id in ('${A}', '${B}')`],
      { encoding: "utf8" },
    );
    expect(r.stdout.trim()).toBe("0");
  });
});
