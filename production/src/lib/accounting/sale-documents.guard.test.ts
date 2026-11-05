/**
 * R-1739 ratchet — every reader of the invoices table has said whether it counts SALES.
 *
 * An invoice imported from Zoho Books (document_kind 'opening_invoice') is an open balance
 * only: its GST and revenue were reported from Zoho. Each reader that turns invoices into GST,
 * revenue, IRN or a Sales voucher must leave it out with the ONE shared rule —
 * SQL `public.invoice_is_sale(document_kind)`, TS `onlySaleInvoices` / `invoiceIsSale` /
 * `isTaxInvoiceRow` (lib/accounting/sale-documents.ts, lib/invoices/document-kind.ts).
 *
 * How it fails:
 *   - a NEW SQL function (newest definition across baseline + archive + migrations) or a NEW
 *     src file that reads `invoices` and is in neither list below → add it to SALE (and use
 *     the rule) or to NOT_SALE (with the reason it is not GST / revenue);
 *   - a SALE reader that no longer uses the rule.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

// ── SQL ────────────────────────────────────────────────────────────────────────────
const SQL_SALE = new Set([
  "report_pnl",            // revenue + output GST
  "report_pnl_monthly",    // revenue trend
  "report_pnl_revenue_lines", // R-2181: the documents behind Revenue per product family (R-1835 report_pnl_revenue_by_product is their sum)
  "report_balance_sheet",  // gst_output (receivables keep the open balance)
  "report_day_book",       // Sales vouchers
  "report_party_ledger",   // 'Opening balance' for opening_balance, not a Sales voucher
  "get_partner_metrics",   // invoiced this month (reseller children)
]);
const SQL_NOT_SALE: Record<string, string> = {
  tg_tenants_lut_to_fy: "R-2444: checks only whether 0% export Tax Invoices of one FY exist, so an old writer of tenants.lut_number never drops the LUT they rely on; no amounts or totals",
  delete_tenant_lut: "R-2444: counts the company's 0% export Tax Invoices of one FY (document_kind 'tax_invoice' — never an opening invoice) only to refuse deleting the LUT they rely on; no amounts or totals",
  bank_line_kept_receipt_ref: "R-2430: reads only the quote_id of the ONE invoice a bank line is being matched to (by id), to find a kept receipt on that quote (R-2466: or on that opening invoice) — no amounts, lists or totals",
  settle_invoice_payment_link: "R-2415: the invoices one paid Razorpay pay link was frozen for (by id) — checks each is open and its due, then record_payment books it; no list or total",
  personal_my_invoices: "R-2132: a personal login's own document list (like a customer portal) — shows each of its linked customer's invoices with its own amount and balance; it totals nothing and no report or GST figure reads it",
  quote_one_time_lines: "R-2095: only checks whether a live invoice already carries a quote's one-time lines (tag one_time_of) — no amounts",
  marketing_metrics_query: "R-2165: Neo's ad report — a received payment's own invoice by id for its taxable share (ex GST), same as R-1980 marketing-sales.ts; the revenue is the PAYMENT, not an invoice total",
  tg_queue_panel_account: "R-2103: reads only the customer of an opening-invoice payment, to queue their customer panel login — no amounts",
  queue_panel_account_backfill: "R-2103: finds the customer of opening-invoice payments to queue panel logins — no amounts",
  zoho_books_import_apply: "R-1753: open Zoho invoices go in through import_opening_invoices (opening, never a sale)",
  zoho_books_import_undo: "R-1753: refuses while a created customer has other invoices; removes its own opening invoices",
  accept_project_quote: "creates a project invoice of ours",
  bank_credit_open_items: "R-1838: lists a customer's unpaid invoices to take a bank receipt (R-2466: Zoho opening invoices too, kind opening — paid via _record_opening_invoice_payment); no totals",
  bank_old_one_off_bookings: "R-1863: lists bank lines booked as a one-off bank sale with their own invoice (only those reached through the line's payment → quote), to relink them",
  reconcile_bank_credit_to_item: "R-1838: records a bank receipt on the picked invoice via record_desk_payment / record_instalment_payment (R-2466: an opening invoice via _record_opening_invoice_payment)",
  reconcile_bank_credit_fx_invoice: "R-2427: an export receipt on the ONE picked invoice (by id, locked) — its currency, rate and due decide the receipt, Bank Charges and forex lines; no list or total",
  bank_credit_pay_item: "R-2098: the body of reconcile_bank_credit_to_item (shared with reconcile_bank_credit_split) — records a bank receipt on the picked invoice via record_desk_payment / record_instalment_payment (R-2466: an opening invoice via _record_opening_invoice_payment)",
  activate_quote_on_credit: "quote → our invoice",
  allocate_project_receipt: "payments on projects; sets paid_amount on the project invoice it raises (R-1995)",
  allocate_project_receipt_with_tds: "payments on projects + the customer's TDS; sets paid_amount on the project invoice it raises (R-1996; allocate_project_receipt calls it)",
  bill_late_charges: "late fee on an overdue balance (a new debit note of ours)",
  delete_customer: "refuses while invoices exist",
  delete_project_invoice: "draft project invoices only",
  delete_subscription_invoice: "draft invoices only",
  demo_data_add_invoices: "demo rows",
  demo_data_clear_invoices: "demo rows",
  generate_invoice: "issues our invoice",
  invoice_cost_fill_apply: "line costs of our invoices",
  invoice_cost_fill_preview: "line costs of our invoices",
  issue_credit_note_core: "a trigger refuses notes on an opening invoice",
  issue_debit_note: "a trigger refuses notes on an opening invoice",
  late_fee_effective: "late fee settings",
  nav_badges: "open balances — dues count, includes opening invoices on purpose",
  quote_open_balance: "per quote — opening invoices have no quote",
  raise_project_milestone_invoice: "issues our invoice",
  raise_subscription_billing: "issues our invoice",
  instalment_credit: "R-2044: one subscription's instalment invoices' paid_amount (credit already used) — not GST or revenue",
  instalment_credit_parts: "R-2095: instalment_credit's pool, incl. part invoices credit notes cancelled — not GST or revenue",
  invoice_fully_credited: "R-2095: do credit notes cover one invoice's value — frees its billing parts, not GST or revenue",
  split_sale_invoice_status: "R-2057: the amount of one part's instalment invoice, for the pending list — not GST or revenue",
  reconcile_bank_txn: "money in, not GST",
  record_desk_payment: "payments on quotes",
  record_instalment_payment: "payments on instalments",
  record_multi_invoice_payment: "money in; routes opening invoices to _record_opening_invoice_payment",
  record_payment: "payments on quotes",
  record_project_payment: "payments on projects",
  refund_payment: "money out",
  r2322_refund_scope: "R-2322: snapshot of the rows a customer refund touches (to undo it exactly) — not GST or revenue",
  set_late_fee_mode: "late fee settings",
  set_books_start_date: "R-2496: only the earliest dated invoice (not opening invoices) — refuses a books start after a money row; not GST or revenue",
  set_invoice_external_number: "R-2360: stores the Zoho invoice number on one invoice (duplicate check) — not GST or revenue",
  invoice_external_number_holder: "R-2360: which invoice already is a Zoho number (duplicate check) — not GST or revenue",
  split_outstanding_for: "per quote",
  sync_invoice_subscription_outstanding: "R-2178: one invoice's quote / billing-part link, to re-sync the subscriptions' stored balance after a credit / debit note — not GST or revenue",
  subscription_dues_drift: "R-2154: read-only report — only asks whether a quote has any invoice (then the invoice is the claim)",
  suggest_invoice_write_off: "open balances",
  suspend_subscription: "per subscription",
  cancel_subscription: "R-1711: what one subscription's open invoices still ask for, so a cancel never clears it (no money column changes on invoices)",
  write_off_subscription: "R-1635: stamps one subscription's open invoices written off (no money column changes)",
  write_off_small_invoice_balance: "R-2410: stamps ONE invoice (balance ₹1–₹500) written off + an audit row (no money column changes) — not GST or revenue",
  sync_project_invoice_paid: "project receipts",
  tg_payment_followups_same_tenant: "tenant check",
  tg_quotes_add_seats_take_back: "per quote",
  r1762_lead_money: "does the deal have money — any invoice that is not void blocks leaving Won",
  today_inbox: "overdue balances — includes opening invoices on purpose",
  unreconcile_bank_receipt: "money in",
  project_receipt_undo_preview: "R-1999: one invoice status by id per kist, before / after a rolled-back dry run of un-reconciling a project line — not GST or revenue",
  waive_late_charges: "late fee",
  // R-1739's own functions
  _opening_invoice_settle: "keeps an opening invoice's paid amount",
  _record_opening_invoice_payment: "payment on an opening invoice",
  import_opening_invoices: "writes opening invoices",
  remove_opening_invoice_import: "removes opening invoices",
  tg_note_not_on_opening_invoice: "refuses notes on an opening invoice",
  tg_payments_opening_invoice: "payment ↔ opening invoice",
  tg_partner_credit_note_to_child_bill: "R-2432: only checks the credit note's invoice belongs to the same company before reducing the reseller's mirrored bill",
};

function latestSqlFunctions(): Map<string, { file: string; body: string }> {
  const sources: string[] = [join(ROOT, "supabase", "baseline.sql")];
  for (const d of ["migrations-archive", "migrations"]) {
    const dir = join(ROOT, "supabase", d);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sources.push(join(dir, f));
  }
  const latest = new Map<string, { file: string; body: string }>();
  for (const file of sources) {
    const s = readFileSync(file, "utf8");
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)"?([a-z0-9_]+)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const rest = s.slice(m.index);
      const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(rest);
      if (!tag) continue;
      const start = m.index + tag.index + tag[0].length;
      const end = s.indexOf(tag[1], start);
      if (end < 0) continue;
      latest.set(m[1].toLowerCase(), { file: relative(ROOT, file), body: s.slice(start, end) });
    }
  }
  return latest;
}

const READS_INVOICES_SQL = /(?:from|join)\s+(?:"?public"?\.)?"?invoices"?\b/i;

describe("R-1739: SQL readers of invoices", () => {
  const fns = latestSqlFunctions();
  const readers = [...fns].filter(([, f]) => READS_INVOICES_SQL.test(f.body)).map(([n]) => n).sort();

  it("every SQL function that reads invoices is classified (sale or not)", () => {
    const unknown = readers.filter((n) => !SQL_SALE.has(n) && !(n in SQL_NOT_SALE));
    expect(unknown, `New SQL reader(s) of invoices — add to SQL_SALE (and use invoice_is_sale) or SQL_NOT_SALE with a reason: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every SALE function uses invoice_is_sale in its newest definition", () => {
    const missing = [...SQL_SALE].filter((n) => !/invoice_is_sale\s*\(/.test(fns.get(n)?.body ?? ""));
    expect(missing, `Sale readers without invoice_is_sale(): ${missing.map((n) => `${n} (${fns.get(n)?.file})`).join(", ")}`).toEqual([]);
  });

  it("the predicate is false only for opening_invoice", () => {
    const body = fns.get("invoice_is_sale")?.body ?? "";
    expect(body).toMatch(/<>\s*'opening_invoice'/);
  });
});

// ── TypeScript ─────────────────────────────────────────────────────────────────────
const TS_SALE = new Set([
  "src/app/(app)/accounting/gst/report.ts",                       // GSTR-1 / 3B
  "src/app/(app)/accounting/gst/composition-report.ts",           // CMP-08 — bill_of_supply only
  "src/lib/compliance/revised-invoice-query.ts",                  // revised invoices — bill_of_supply only
  "src/components/features/accounting/tally-daybook-button.tsx",  // Tally Sales vouchers
  "src/lib/queries/gst-health.ts",                                // GST checks of our invoices
  "src/lib/queries/month-close.ts",                               // month's output GST
  "src/app/api/v1/support/invoices/summary/route.ts",             // R-2079: support revenue for DSP
  "src/components/features/collections/owner-report.tsx",        // R-2414: invoiced in the last 30 days, for DSO / CEI
]);
const TS_NOT_SALE: Record<string, string> = {
  "src/lib/payments/payment-link.server.ts": "R-2415: the open invoices (by id) a Send-reminder pay link may carry, and their due for the stale-link sweep — not a list or a total",
  "src/app/(app)/renewals/last-paid-data.ts": "R-2422: the invoice numbers raised from one subscription's own quotes (by quote_id), to name what a payment paid on the Renewals row's Last paid — not a list or a total",
  "src/lib/payments/online-fee.server.ts": "R-2416: one invoice's online-fee waiver flag (by id) for the fee policy on capture — not a list or a total",
  "src/app/(app)/collections/leftover-tds-dialog.tsx": "R-2410: one invoice by id, to open its Record payment sheet in TDS mode — not a list or a total",
  "src/app/(public)/buy/workspace/thanks/fetch-order.ts": "R-1971: the number of this order's own GST invoice (by quote_id) for the buyer's thanks page — not a list or a total",
  "src/lib/exports/read-rows.server.ts": "R-1007: the invoice-register CSV lists every invoice the user ticked or can see (opening ones too, as the Invoices screen does) — not GST or revenue",
  "src/lib/integrations/zoho-books/import-store.ts": "R-1753: Zoho numbers already imported as opening invoices (so a second import skips them)",
  "src/app/api/integrations/zoho-books/bulk-match/customer-facts.ts": "R-2419: a customer's OPEN opening invoices (document_kind opening_invoice) so Reconcile from Zoho settles last year's invoice on them — never a sale, not GST or revenue",
  "src/components/features/banking/zoho-bulk-reconcile.tsx": "R-2474: reads back the opening invoice import_opening_invoices just made (by Zoho number) to pay it with the bank line — one invoice by number, not a list or a total, not GST or revenue",
  "src/lib/privacy/queries.ts": "R-2013: one person's own invoices for their DPDP data export (every kind, as the person sees them) — not GST or revenue",
  "src/app/(app)/accounting/aging/read.ts": "aging of open balances — includes opening invoices on purpose",
  "src/app/(app)/invoices/[id]/page.tsx": "one invoice; an opening invoice gets its own view",
  "src/app/(app)/quotes/[id]/invoice-created-at.ts": "R-1715: one invoice's created_at by id, for the quote's workflow history time — not a list or a total",
  "src/app/(app)/quotes/[id]/part-invoices.ts": "R-2101: the status (void or not) of the invoices a sale quote's parts point at, for its INVOICED step — not a list or a total",
  "src/app/(app)/online-orders/page.tsx":"R-1120: the order quote's own invoice by id (taxable, GST, split) for the drawer — not a list or a total",
  "src/lib/queries/marketing-sales.ts": "R-1980: a received payment's own invoice by id — its taxable share (ex GST) and quote link; the revenue is the PAYMENT, not an invoice total",
  "src/app/api/cron/billing/route.ts": "raises our subscription invoices",
  "src/app/api/cron/invoice-dunning/route.ts": "reminders on open balances — includes opening invoices",
  "src/app/api/invoices/[id]/pdf-link/route.ts": "refuses an opening invoice (isOpeningInvoice)",
  "src/app/api/invoices/series/route.ts": "our number series",
  "src/app/api/quality/platform/route.ts": "first invoice date per tenant (platform metric)",
  "src/app/api/tenant/invoice-code/route.ts": "our number series",
  "src/app/api/v1/customers/[id]/invoices/route.ts": "customer's invoices (statement API)",
  "src/app/api/v1/customers/[id]/payments/route.ts": "payment → invoice link",
  "src/app/api/v1/documents/invoice/[id]/pdf/route.ts": "refuses an opening invoice (isOpeningInvoice)",
  "src/components/features/collections/write-off-suggestions-card.tsx": "open balances",
  "src/components/features/invoices/issue-credit-note-dialog.tsx": "a trigger refuses notes on an opening invoice",
  "src/components/features/subscriptions/invoice-peek-dialog.tsx": "one subscription invoice",
  "src/components/features/subscriptions/use-expected-seat-rate.ts": "the last invoiced seat rate of one item (R-2292; skips opening invoices itself)",
  "src/lib/ai/help-data-tools.ts": "overdue balances",
  "src/lib/ai/performance.server.ts": "lead → invoice status",
  "src/lib/billing/sync-instalments.server.ts": "our instalment invoices",
  "src/lib/collections/overdue-suspension.server.ts": "overdue balances",
  "src/lib/collections/pending-dues.server.ts": "pending-dues statement — includes opening invoices",
  "src/lib/collections/reminder-draft.server.ts": "reminders on open balances",
  "src/lib/credit/queries.ts": "credit exposure on open balances",
  "src/lib/digest/owner-digest-facts.ts": "overdue balances",
  "src/lib/late-charges/load.ts": "late fee on overdue balances",
  "src/lib/quality/queries.ts": "first invoice date (platform metric)",
  "src/lib/queries/balance-sheet.ts": "Opening Balance Adjustments = sum(opening_balance)",
  "src/lib/queries/bank.ts": "match receipts to open invoices",
  "src/lib/queries/collections.ts": "open balances",
  "src/lib/queries/deal-history.ts": "invoices of a quote",
  "src/lib/queries/invoices.ts": "invoice list (badge shows imported ones)",
  "src/lib/queries/palette-search.ts": "Ctrl+K lookup by number or name (R-1121) — imported ones are findable too",
  "src/lib/queries/payments.ts": "open invoices to pay",
  "src/lib/queries/subscriptions.ts": "a subscription's invoice status",
  "src/lib/queries/tds-receivable.ts": "R-1670: the invoice number raised from a TDS entry's quote (a label on the row) — not GST or revenue",
  "src/lib/import/zoho-opening-invoices.queries.ts": "Zoho numbers already imported",
  "src/components/features/invoices/opening-invoice-dues-card.tsx": "balances on imported Zoho invoices (dues)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "generated" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const READS_INVOICES_TS = /\.from(?:<[^>]*>)?\(\s*["'`]invoices["'`]/;
const SALE_RULE_TS = /onlySaleInvoices\(|invoiceIsSale\(|isTaxInvoiceRow|\.eq\("document_kind", "bill_of_supply"\)/;

describe("R-1739: TypeScript readers of invoices", () => {
  const files = walk(join(ROOT, "src")).map((p) => relative(ROOT, p).replace(/\\/g, "/"));
  const readers = files.filter((f) => READS_INVOICES_TS.test(readFileSync(join(ROOT, f), "utf8"))).sort();

  it("every file that reads invoices is classified (sale or not)", () => {
    const unknown = readers.filter((f) => !TS_SALE.has(f) && !(f in TS_NOT_SALE));
    expect(unknown, `New reader(s) of invoices — add to TS_SALE (and use onlySaleInvoices) or TS_NOT_SALE with a reason: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every SALE file applies the sales-only rule", () => {
    const missing = [...TS_SALE].filter((f) => !SALE_RULE_TS.test(readFileSync(join(ROOT, f), "utf8")));
    expect(missing).toEqual([]);
  });

  it("the lists name only files that exist", () => {
    const gone = [...TS_SALE, ...Object.keys(TS_NOT_SALE)].filter((f) => !files.includes(f));
    expect(gone).toEqual([]);
  });
});
