/**
 * S17 parity: SQL report functions == purana TS hisaab, ek hi data par.
 *
 * ─── KYA MILATA HAI ─────────────────────────────────────────────────────────
 * Ek hi rolled-back transaction me (LOCAL Postgres, kabhi production nahi):
 *   1. migration 20260928110000 lagao,
 *   2. supabase/tests/report_functions.test.sql ka fixture (FIXTURE:BEGIN … END) daalo,
 *   3. tenant A ke user ki tarah (role authenticated + JWT sub, RLS chalu) do cheezein nikalo:
 *      - wahi rows jo purane browser hooks supabase-js se padhte the (same filters), aur
 *      - naye RPCs ka jawab,
 *   4. rollback.
 * Phir purani rows → reports-reference.ts (purana hisaab, jaisa ka taisa) aur RPC →
 * naya mapper, aur dono ka nateeja `toEqual`.
 *
 * ─── KAB CHALTA HAI ─────────────────────────────────────────────────────────
 * Sirf jab PARITY_PG_URL diya ho (aur psql mile — PARITY_PSQL ya PATH). Warna skip, aur
 * skip ka kaaran naam se likha jaata hai — "pass" jaisa dikhne wala chup-chaap skip nahi.
 * `vitest run` default me DB nahi chhoota (unit suite DB-free rehta hai).
 *
 *   PARITY_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   PARITY_PSQL="C:/Program Files/PostgreSQL/16/bin/psql.exe" npx vitest run tests/parity
 *
 * Guard: URL localhost/127.0.0.1 ke alawa ho to test FAIL karta hai (skip nahi) — ye file
 * fixture INSERT karti hai; rollback par bharosa karke bhi remote DB par nahi chalni chahiye.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { balanceSheetFromRpc, type BalanceSheetRpcRow } from "@/lib/accounting/report-rpc";
import { assemblePnl, type PnlRpcRow, type PnlMasters, type PnLNumbers } from "@/lib/accounting/pnl-assemble";
import {
  referenceBalanceSheet, referencePnl, referencePnlMonthlyRows,
  referenceCustomerLedgerEntries, referenceVendorLedgerEntries, referenceLedgerVendors,
  type BsRawRows, type PnlRawRows,
} from "@/lib/accounting/reports-reference";
import { buildLedger, fyPeriod, customPeriod, type LedgerPeriod } from "@/lib/accounting/ledger";
import { statementFromRpc, type PartyLedgerRpc } from "@/lib/queries/ledger";
import { monthlySeries } from "@/lib/accounting/pnl-charts";

const URL = process.env.PARITY_PG_URL ?? "";
const PSQL = process.env.PARITY_PSQL ?? "psql";
const ROOT = process.cwd();

const USER_A = "d1700000-0000-0000-0000-0000000000a2";
const CUST_1 = "d1700000-0000-0000-0000-00000000c001";
const PROJ_1 = "d1700000-0000-0000-0000-00000000f001";
const PNL_RANGE = { from: "2026-04-01", to: "2026-09-30" };
const FY26 = fyPeriod(2026);
const Q2: LedgerPeriod = customPeriod("2026-07-01", "2026-09-30");

/** Purane hooks ke reads, SQL me — har ek ke saath wo supabase-js call jiska ye aaina hai. */
const RAW_AND_RPC_SQL = `
select json_build_object(
  'bs', json_build_object(
    -- from("bank_accounts").select("id, opening_balance, account_type")
    'accounts',  (select coalesce(json_agg(json_build_object('id', id, 'opening_balance', opening_balance, 'account_type', account_type)), '[]') from public.bank_accounts),
    -- rpc("bank_account_current_balance", { p_account_id }) har account ke liye
    'balanceOf', (select coalesce(json_object_agg(id, public.bank_account_current_balance(id)), '{}') from public.bank_accounts),
    'openInv',   (select coalesce(json_agg(json_build_object('id', id, 'amount', amount, 'net_payable', net_payable, 'paid_amount', paid_amount, 'status', status)), '[]') from public.invoices where status in ('pending','overdue')),
    -- R-179: receipts jin par koi bank line match nahi (undeposited funds); S45: us payment ka TDS
    'unbankedPays',     (select coalesce(json_agg(json_build_object('amount', amount, 'tds', (select sum(t.tds_amount) from public.tds_receivable t where t.payment_id = p.id))), '[]') from public.payments p where status = 'received' and not exists (select 1 from public.bank_transactions t where t.matched_to_type = 'payment' and t.matched_to_id = p.id::text)),
    -- S45: quote ka ek hi, non-project invoice — mila vs invoice ± notes
    'invoicedQuotes', (select coalesce(json_agg(json_build_object(
        'received', (select coalesce(sum(p.amount), 0) from public.payments p where p.quote_id = q.id and p.status = 'received'),
        'invoice_amount', i.amount,
        'credit_notes', (select coalesce(sum(c.amount), 0) from public.credit_notes c where c.invoice_id = i.id),
        'debit_notes', (select coalesce(sum(d.amount), 0) from public.debit_notes d where d.invoice_id = i.id))), '[]')
       from public.quotes q join public.invoices i on i.id = q.invoice_id
      where i.status in ('pending','paid','overdue')
        and not exists (select 1 from public.invoices i2 where i2.quote_id = q.id and i2.id <> i.id)
        and not exists (select 1 from public.project_milestones pm where pm.invoice_id = i.id)),
    'unbankedProjPays', (select coalesce(json_agg(json_build_object('amount', amount)), '[]') from public.project_payments where bank_txn_id is null),
    'msInv',     (select coalesce(json_agg(json_build_object('invoice_id', invoice_id)), '[]') from public.project_milestones where invoice_id is not null),
    'recdPays',  (select coalesce(json_agg(json_build_object('quote_id', quote_id, 'amount', amount, 'status', status)), '[]') from public.payments where status = 'received'),
    'quoteInv',  (select coalesce(json_agg(json_build_object('id', id, 'invoice_id', invoice_id)), '[]') from public.quotes),
    'projs',     (select coalesce(json_agg(json_build_object('id', id)), '[]') from public.project_sales where status in ('active','completed')),
    'ms',        (select coalesce(json_agg(json_build_object('project_id', project_id, 'total_amount', total_amount, 'invoice_id', invoice_id)), '[]') from public.project_milestones where project_id in (select id from public.project_sales where status in ('active','completed'))),
    'projPays',  (select coalesce(json_agg(json_build_object('project_id', project_id, 'amount', amount)), '[]') from public.project_payments where project_id in (select id from public.project_sales where status in ('active','completed'))),
    'tds',       (select coalesce(json_agg(json_build_object('tds_amount', tds_amount, 'status', status)), '[]') from public.tds_receivable where status in ('pending_cert','cert_received','verified_26as')),
    'loans',     (select coalesce(json_agg(json_build_object('id', id, 'principal', principal)), '[]') from public.employee_loans),
    'loanReps',  (select coalesce(json_agg(json_build_object('amount', amount)), '[]') from public.employee_loan_repayments),
    'advs',      (select coalesce(json_agg(json_build_object('total_amount', total_amount, 'consumed_amount', consumed_amount)), '[]') from public.prepaid_advances),
    'emiP',      (select coalesce(json_agg(json_build_object('id', id, 'total_cost', total_cost, 'financed', financed)), '[]') from public.emi_purchases),
    'emiPay',    (select coalesce(json_agg(json_build_object('principal_part', principal_part)), '[]') from public.emi_payments),
    'fa',        (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'block', block, 'cost', cost, 'put_to_use', put_to_use, 'disposed_on', disposed_on, 'disposal_value', disposal_value, 'emi_purchase_id', emi_purchase_id)), '[]') from public.fixed_assets),
    'bizLoans',  (select coalesce(json_agg(json_build_object('id', id, 'principal', principal)), '[]') from public.business_loans),
    'bizPays',   (select coalesce(json_agg(json_build_object('principal_part', principal_part)), '[]') from public.business_loan_payments),
    'bills',     (select coalesce(json_agg(json_build_object('total', total, 'paid_amount', paid_amount, 'status', status)), '[]') from public.vendor_bills where status <> 'paid'),
    'salRows',   (select coalesce(json_agg(json_build_object('net', net, 'paid_amount', paid_amount, 'tds', tds, 'pf', pf, 'esi', esi, 'pf_employer', pf_employer, 'esi_employer', esi_employer, 'paid_status', paid_status)), '[]') from public.salary_payments),
    'duesPaid',  (select coalesce(json_agg(json_build_object('kind', kind, 'amount', amount)), '[]') from public.statutory_dues_payments),
    'vendorTdsRows', (select coalesce(json_agg(json_build_object('tds_amount', tds_amount)), '[]') from public.expenses where tds_amount > 0),
    'reimb',     (select coalesce(json_agg(json_build_object('amount', amount, 'status', status)), '[]') from public.reimbursements where status = 'pending'),
    'invoices',  (select coalesce(json_agg(json_build_object('amount', amount, 'tax_amount', tax_amount, 'tax_rate', tax_rate, 'invoice_date', invoice_date, 'status', status)), '[]') from public.invoices where invoice_date <= (now() at time zone 'Asia/Kolkata')::date and status in ('pending','paid','overdue')),
    'cnFy',      (select coalesce(json_agg(json_build_object('tax_amount', tax_amount, 'credit_date', credit_date)), '[]') from public.credit_notes where credit_date <= (now() at time zone 'Asia/Kolkata')::date),
    'dnFy',      (select coalesce(json_agg(json_build_object('tax_amount', tax_amount, 'debit_date', debit_date)), '[]') from public.debit_notes where debit_date <= (now() at time zone 'Asia/Kolkata')::date),
    'fyBills',   (select coalesce(json_agg(json_build_object('cgst', cgst, 'sgst', sgst, 'igst', igst, 'bill_date', bill_date)), '[]') from public.vendor_bills where bill_date <= (now() at time zone 'Asia/Kolkata')::date),
    'fyExp',     (select coalesce(json_agg(json_build_object('gst_paid', gst_paid, 'expense_date', expense_date, 'vendor_id', vendor_id, 'bill_type', bill_type, 'category', category)), '[]') from public.expenses where expense_date <= (now() at time zone 'Asia/Kolkata')::date),
    'vendorRows',(select coalesce(json_agg(json_build_object('id', id, 'gstin', gstin)), '[]') from public.vendors),
    'taxRows',   (select coalesce(json_agg(json_build_object('kind', kind, 'amount', amount, 'period', period, 'fy', fy)), '[]') from public.tax_payments)
  ),
  'bsRpc', (select row_to_json(r) from public.report_balance_sheet(null) r),
  'pnl', json_build_object(
    'invoices',  (select coalesce(json_agg(json_build_object('id', id, 'amount', amount, 'status', status, 'invoice_date', invoice_date, 'net_payable', net_payable, 'taxable_value', taxable_value, 'tax_amount', tax_amount, 'tax_rate', tax_rate)), '[]') from public.invoices where invoice_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}' and status in ('pending','paid','overdue')),
    'cnP',       (select coalesce(json_agg(json_build_object('invoice_id', invoice_id, 'taxable_value', taxable_value, 'tax_amount', tax_amount, 'credit_date', credit_date)), '[]') from public.credit_notes where credit_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}'),
    'dnP',       (select coalesce(json_agg(json_build_object('invoice_id', invoice_id, 'taxable_value', taxable_value, 'tax_amount', tax_amount, 'debit_date', debit_date)), '[]') from public.debit_notes where debit_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}'),
    'bills',     (select coalesce(json_agg(json_build_object('total', total, 'subtotal', subtotal, 'cgst', cgst, 'sgst', sgst, 'igst', igst, 'category', category)), '[]') from public.vendor_bills where bill_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}' and category like 'COGS-%'),
    'expenses',  (select coalesce(json_agg(json_build_object('amount', amount, 'gst_paid', gst_paid, 'category', category, 'vendor_name', vendor_name, 'vendor_id', vendor_id, 'bill_type', bill_type, 'expense_date', expense_date, 'project_id', project_id, 'description', description)), '[]') from public.expenses where expense_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}'),
    'vendorRows',(select coalesce(json_agg(json_build_object('id', id, 'gstin', gstin)), '[]') from public.vendors),
    'comms',     (select coalesce(json_agg(json_build_object('gross_commission', gross_commission, 'earned_date', earned_date, 'status', status)), '[]') from public.referral_commissions where earned_date between '${PNL_RANGE.from}' and '${PNL_RANGE.to}' and status <> 'cancelled'),
    'milestones',(select coalesce(json_agg(json_build_object('project_id', project_id, 'invoice_id', invoice_id)), '[]') from public.project_milestones where invoice_id is not null)
  ),
  'pnlRpc', (select row_to_json(r) from public.report_pnl('${PNL_RANGE.from}', '${PNL_RANGE.to}') r),
  'trend', json_build_object(
    'inv', (select coalesce(json_agg(json_build_object('invoice_date', invoice_date, 'amount', amount, 'taxable_value', taxable_value, 'tax_rate', tax_rate)), '[]') from public.invoices where invoice_date between '2026-04-01' and '2027-03-31' and status in ('pending','paid','overdue')),
    'exp', (select coalesce(json_agg(json_build_object('expense_date', expense_date, 'amount', amount)), '[]') from public.expenses where expense_date between '2026-04-01' and '2027-03-31'),
    'cn', (select coalesce(json_agg(json_build_object('credit_date', credit_date, 'taxable_value', taxable_value)), '[]') from public.credit_notes where credit_date between '2026-04-01' and '2027-03-31'),
    'dn', (select coalesce(json_agg(json_build_object('debit_date', debit_date, 'taxable_value', taxable_value)), '[]') from public.debit_notes where debit_date between '2026-04-01' and '2027-03-31'),
    'rpc', public.report_pnl_monthly('2026-04-01', '2027-03-31')
  ),
  'ledger', json_build_object(
    'inv', (select coalesce(json_agg(json_build_object('id', id, 'invoice_date', invoice_date, 'amount', amount, 'customer_name', customer_name, 'status', status)), '[]') from public.invoices where customer_id = '${CUST_1}' and status <> 'void'),
    'pay', (select coalesce(json_agg(json_build_object('id', id, 'receipt_voucher_no', receipt_voucher_no, 'amount', amount, 'received_at', received_at, 'refunded_at', refunded_at, 'status', status, 'method', method, 'reference', reference)), '[]') from public.payments where customer_id = '${CUST_1}'),
    'cn',  (select coalesce(json_agg(json_build_object('id', id, 'credit_date', credit_date, 'amount', amount, 'reason', reason, 'invoice_id', invoice_id)), '[]') from public.credit_notes where customer_id = '${CUST_1}'),
    'dn',  (select coalesce(json_agg(json_build_object('id', id, 'debit_date', debit_date, 'amount', amount, 'reason', reason, 'invoice_id', invoice_id)), '[]') from public.debit_notes where customer_id = '${CUST_1}'),
    'vend', (select coalesce(json_agg(json_build_object('id', id, 'bill_no', bill_no, 'category', category, 'amount', amount, 'expense_date', expense_date, 'paid', paid, 'paid_date', paid_date, 'payment_method', payment_method)), '[]') from public.expenses where vendor_name = 'Acme Cloud'),
    'vendorsRaw', (select coalesce(json_agg(json_build_object('vendor_name', vendor_name, 'amount', amount, 'category', category)), '[]') from (select * from public.expenses where vendor_name is not null limit 2000) x),
    'custFy', public.report_party_ledger('customer', '${CUST_1}', '${FY26.from}', '${FY26.to}'),
    'custQ2', public.report_party_ledger('customer', '${CUST_1}', '${Q2.from}', '${Q2.to}'),
    'vendFy', public.report_party_ledger('vendor', 'Acme Cloud', '${FY26.from}', '${FY26.to}'),
    'vendQ2', public.report_party_ledger('vendor', 'Acme Cloud', '${Q2.from}', '${Q2.to}'),
    'vendors', public.report_ledger_vendors()
  )
);`;

function isLocal(u: string): boolean {
  return /@(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(u);
}

type Dump = {
  bs: BsRawRows; bsRpc: BalanceSheetRpcRow;
  pnl: PnlRawRows; pnlRpc: PnlRpcRow;
  trend: { inv: Parameters<typeof referencePnlMonthlyRows>[0]; exp: Parameters<typeof referencePnlMonthlyRows>[1]; cn: NonNullable<Parameters<typeof referencePnlMonthlyRows>[2]>; dn: NonNullable<Parameters<typeof referencePnlMonthlyRows>[3]>; rpc: { month: string; revenue: number; expenses: number }[] };
  ledger: {
    inv: Parameters<typeof referenceCustomerLedgerEntries>[0]["inv"];
    pay: Parameters<typeof referenceCustomerLedgerEntries>[0]["pay"];
    cn: Parameters<typeof referenceCustomerLedgerEntries>[0]["cn"];
    dn: Parameters<typeof referenceCustomerLedgerEntries>[0]["dn"];
    vend: Parameters<typeof referenceVendorLedgerEntries>[0];
    vendorsRaw: Parameters<typeof referenceLedgerVendors>[0];
    custFy: PartyLedgerRpc; custQ2: PartyLedgerRpc; vendFy: PartyLedgerRpc; vendQ2: PartyLedgerRpc;
    vendors: ReturnType<typeof referenceLedgerVendors>;
  };
};

function dump(): Dump {
  /* S17 + S39 (IST ledger dates, credit notes in the trend) — wahi kram jo production par lagega. */
  const migration = [
    "supabase/migrations/20260928110000_report_functions.sql",
    "supabase/migrations/20260928190000_report_fixes_ist_ledger_trend_cn.sql",
    "supabase/migrations/20261006140000_undeposited_funds.sql",
    "supabase/migrations/20261007290000_tb_customer_balances.sql",
  ].map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");
  const testSql = readFileSync(join(ROOT, "supabase/tests/report_functions.test.sql"), "utf8");
  const fixture = testSql.split("-- FIXTURE:BEGIN")[1]?.split("-- FIXTURE:END")[0];
  if (!fixture) throw new Error("FIXTURE:BEGIN / FIXTURE:END markers missing from report_functions.test.sql");

  const sql = [
    "\\set ON_ERROR_STOP 1",
    "begin;",
    // PostgREST timestamptz UTC me deta hai; purana ledger usi string ka slice(0, 10) leta tha.
    "set local timezone = 'UTC';",
    /* S45: 20260928110000 ka `create or replace` purane RETURNS TABLE se hai; jis DB par
       20261006140000 (undeposited_funds column) lag chuka, wahan wo "cannot change return
       type" deta tha — parity test local DB par chalta hi nahi tha. Rollback ke andar hai. */
    "drop function if exists public.report_balance_sheet(date);",
    migration,
    "do $$ begin perform set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true); end $$;",
    fixture,
    `do $$ begin perform set_config('request.jwt.claims', '{"sub":"${USER_A}","role":"authenticated"}', true); end $$;`,
    "set local role authenticated;",
    RAW_AND_RPC_SQL,
    "rollback;",
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "s17parity-"));
  const file = join(dir, "parity.sql");
  writeFileSync(file, sql);
  try {
    const r = spawnSync(PSQL, ["-X", "-q", "-A", "-t", "-d", URL, "-f", file], { encoding: "utf8", timeout: 60_000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`psql exit ${r.status}: ${r.stderr}`);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
    if (!line) throw new Error(`no JSON row from psql. stdout: ${r.stdout.slice(0, 400)} stderr: ${r.stderr.slice(0, 400)}`);
    return JSON.parse(line) as Dump;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MASTERS: PnlMasters = {
  vendors: [],
  allocations: [],
  monthlyGross: new Map(),
  projects: [{ id: PROJ_1, title: "S17 Project", customer_name: "S17 Customer One", start_date: null }],
  employeeNames: new Map(),
};

/** Barabar total wali categories ka order purane code me DB row-order par tha — tay nahi. */
function normaliseCats(p: PnLNumbers) {
  return {
    ...p,
    expensesByCategory: [...p.expensesByCategory].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
  };
}

const run = URL ? describe : describe.skip;
if (!URL) {
  // eslint-disable-next-line no-console
  console.info("[reports-parity] SKIPPED: PARITY_PG_URL not set — the SQL↔TS parity check did not run.");
}

run("S17 parity — report_* SQL functions reproduce the old TS numbers", () => {
  it("refuses to run against anything but a local database", () => {
    expect(isLocal(URL), `PARITY_PG_URL must point at localhost/127.0.0.1, got ${URL.replace(/:[^:@/]*@/, ":***@")}`).toBe(true);
  });

  const d = isLocal(URL) ? dump() : null;

  it("balance sheet: every figure", () => {
    const got = balanceSheetFromRpc(d!.bsRpc);
    const want = referenceBalanceSheet(d!.bs, d!.bsRpc.as_of);
    expect(got).toEqual(want);
    // Fixture ne sach me kuch ginaya — sab-zero par toEqual khaali jeet hoti (L7/L14).
    expect(want.cashAndBank).toBe(130500);
    expect(want.salaryDuesPayable).toBe(6450);
    expect(want.fixedAssets).toBe(60000 + 9000 + 15000);
  });

  it("P&L: every figure, model and project cost included", () => {
    const got = normaliseCats(assemblePnl(PNL_RANGE, d!.pnlRpc, MASTERS));
    const want = normaliseCats(referencePnl(PNL_RANGE, d!.pnl, MASTERS));
    expect(got).toEqual(want);
    expect(want.revenue).toBe(76873);
    expect(want.expensesCount).toBe(6);
    expect(want.itcBlocked).toBe(180);
    expect(want.projectCost.direct).toBe(3000);
  });

  it("P&L monthly trend", () => {
    const today = "2027-03-31";
    const legacy = referencePnlMonthlyRows(d!.trend.inv, d!.trend.exp, d!.trend.cn, d!.trend.dn);
    const want = monthlySeries({ fyStartYear: 2026, ...legacy, cogsRatio: 0.3, today });
    const got = monthlySeries({
      fyStartYear: 2026, cogsRatio: 0.3, today,
      revenue: d!.trend.rpc.map((m) => ({ date: `${m.month}-01`, amount: m.revenue })),
      expenses: d!.trend.rpc.map((m) => ({ date: `${m.month}-01`, amount: m.expenses })),
    });
    expect(got).toEqual(want);
  });

  it("customer ledger: FY and a mid-year quarter (opening carries the earlier months)", () => {
    const entries = referenceCustomerLedgerEntries(d!.ledger);
    expect(statementFromRpc("customer", d!.ledger.custFy, FY26)).toEqual(buildLedger("customer", entries, FY26));
    const q2 = buildLedger("customer", entries, Q2);
    expect(statementFromRpc("customer", d!.ledger.custQ2, Q2)).toEqual(q2);
    expect(q2.openingBalance).not.toBe(0);
  });

  it("vendor ledger and vendor picker", () => {
    const entries = referenceVendorLedgerEntries(d!.ledger.vend);
    expect(statementFromRpc("vendor", d!.ledger.vendFy, FY26)).toEqual(buildLedger("vendor", entries, FY26));
    expect(statementFromRpc("vendor", d!.ledger.vendQ2, Q2)).toEqual(buildLedger("vendor", entries, Q2));
    expect(d!.ledger.vendors).toEqual(referenceLedgerVendors(d!.ledger.vendorsRaw));
  });
});
