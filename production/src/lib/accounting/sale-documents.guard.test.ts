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
  "report_balance_sheet",  // gst_output (receivables keep the open balance)
  "report_day_book",       // Sales vouchers
  "report_party_ledger",   // 'Opening balance' for opening_balance, not a Sales voucher
  "get_partner_metrics",   // invoiced this month (reseller children)
]);
const SQL_NOT_SALE: Record<string, string> = {
  zoho_books_import_apply: "R-1753: open Zoho invoices go in through import_opening_invoices (opening, never a sale)",
  zoho_books_import_undo: "R-1753: refuses while a created customer has other invoices; removes its own opening invoices",
  accept_project_quote: "creates a project invoice of ours",
  activate_quote_on_credit: "quote → our invoice",
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
  reconcile_bank_txn: "money in, not GST",
  record_desk_payment: "payments on quotes",
  record_instalment_payment: "payments on instalments",
  record_multi_invoice_payment: "money in; routes opening invoices to _record_opening_invoice_payment",
  record_payment: "payments on quotes",
  record_project_payment: "payments on projects",
  refund_payment: "money out",
  set_late_fee_mode: "late fee settings",
  split_outstanding_for: "per quote",
  suggest_invoice_write_off: "open balances",
  suspend_subscription: "per subscription",
  sync_project_invoice_paid: "project receipts",
  tg_payment_followups_same_tenant: "tenant check",
  tg_quotes_add_seats_take_back: "per quote",
  today_inbox: "overdue balances — includes opening invoices on purpose",
  unreconcile_bank_receipt: "money in",
  waive_late_charges: "late fee",
  // R-1739's own functions
  _opening_invoice_settle: "keeps an opening invoice's paid amount",
  _record_opening_invoice_payment: "payment on an opening invoice",
  import_opening_invoices: "writes opening invoices",
  remove_opening_invoice_import: "removes opening invoices",
  tg_note_not_on_opening_invoice: "refuses notes on an opening invoice",
  tg_payments_opening_invoice: "payment ↔ opening invoice",
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
  "src/components/features/accounting/pnl-drilldown-dialog.tsx",  // P&L revenue rows
  "src/components/features/accounting/tally-daybook-button.tsx",  // Tally Sales vouchers
  "src/lib/queries/gst-health.ts",                                // GST checks of our invoices
  "src/lib/queries/month-close.ts",                               // month's output GST
]);
const TS_NOT_SALE: Record<string, string> = {
  "src/lib/integrations/zoho-books/import-store.ts": "R-1753: Zoho numbers already imported as opening invoices (so a second import skips them)",
  "src/app/(app)/accounting/aging/read.ts": "aging of open balances — includes opening invoices on purpose",
  "src/app/(app)/invoices/[id]/page.tsx": "one invoice; an opening invoice gets its own view",
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
  "src/lib/queries/payments.ts": "open invoices to pay",
  "src/lib/queries/subscriptions.ts": "a subscription's invoice status",
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
