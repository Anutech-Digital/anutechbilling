/**
 * Help AI read tool: customer_overview (R-2884 / H-03b, G-HELPAI).
 *
 * THE OWNER'S RULE: the AI's number must EQUAL the number on the page. The Customer page's
 * Outstanding is its Statement's closing (R-2183) — invoices + debit notes − payments − credit notes +
 * refunds, less what a write-off cleared, plus subscription instalments owed before an invoice exists —
 * split into Outstanding / credit by deriveCustomerInsights. That arithmetic lives in
 * lib/customers/statement-core.ts (pure, no React, no client imports): the page calls the same
 * functions, so there is no second copy here to drift. This file only READS the rows the page reads,
 * through the tenant-scoped reader and its column allowlists (reader.ts), and prints.
 *
 * Input: one customer id (uuid), strict. The tenant is never an input. Rows read (all `customer_id = id`,
 * the company filter added by the reader): customers (does it exist?), invoices, quotes (their ids, for
 * payments taken before the lead was converted), payments (own customer_id, or on one of those quotes —
 * the /payments rule), credit notes, debit notes, project payments (of the customer's projects),
 * subscriptions. Money columns and ids only — never a GSTIN, PAN, phone, e-mail, address, bank account,
 * UTR, receipt file or note. Over OVERVIEW_SCAN_MAX rows in any table → no number at all (never a
 * partial sum).
 *
 * The answer names its scope (one customer) and its period (first to last record, as of today, IST).
 */
import { z } from "zod";
import type { UserRole } from "@/lib/auth/roles";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { istToday, toIstDate } from "@/lib/dates/ist";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { cashReceived } from "@/lib/payments/cash-received";
import { customerBalance, type StatementProjectPayment } from "@/lib/customers/statement-core";
import { rupee, num } from "@/lib/utils";
import { defineHelpTool } from "./types";
import { cleanHelpText } from "./untrusted";
import type { HelpQuery } from "./reader";

const OWNER = ["owner"] as const satisfies readonly UserRole[];

/** Most rows read from any one table. Over this the tool gives no number rather than a partial one. */
export const OVERVIEW_SCAN_MAX = 5000;
/** Ids in one in() list (the reader allows 200). */
const IN_CHUNK = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface InvoiceRow {
  id: string; invoice_date: string; due_date: string | null; status: string; amount: number; net_payable: number | null;
  paid_amount: number | null; written_off_at: string | null; document_kind: string | null; opening_balance: number | null; quote_id: string | null;
}
interface PaymentRow {
  id: string; customer_id: string | null; quote_id: string | null; invoice_id: string | null; amount: number | null; status: string;
  credit_applied: number | null; received_at: string; refunded_at: string | null;
}
interface CreditNoteRow { id: string; invoice_id: string | null; credit_date: string; amount: number | null }
interface DebitNoteRow { id: string; invoice_id: string | null; debit_date: string; amount: number | null }
interface ProjectPaymentRow { id: string; project_id: string; amount: number | null; received_at: string; method: string | null }
interface SubscriptionRow {
  id: string; quote_id: string | null; outstanding_amount: number | null; written_off_at: string | null; status: string | null;
  mrr: number | null; start_date: string | null;
}

/** Thrown inside the tool when a table is too big to total — turned into a plain answer, never shown as an error. */
class TooMany extends Error {
  readonly what: string;
  constructor(what: string) { super(`too many ${what}`); this.name = "TooMany"; this.what = what; }
}

/** Every row of one query, over a total order (the caller ends it on id). More than OVERVIEW_SCAN_MAX → TooMany. */
async function readAll<T>(what: string, page: (from: number, to: number) => HelpQuery<T>): Promise<T[]> {
  const rows = await fetchAllRows<T>((a, b) => page(a, b), { maxRows: OVERVIEW_SCAN_MAX + 1 });
  if (rows.length > OVERVIEW_SCAN_MAX) throw new TooMany(what);
  return rows;
}

/** Every row whose key column is in `ids`, a chunk at a time. */
async function readAllIn<T>(what: string, ids: readonly string[], page: (chunk: string[], from: number, to: number) => HelpQuery<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    for (const r of await readAll<T>(what, (a, b) => page(chunk, a, b))) out.push(r);
    if (out.length > OVERVIEW_SCAN_MAX) throw new TooMany(what);
  }
  return out;
}

/** A day (YYYY-MM-DD) for a stored date or timestamp: a plain date stays as it is, a timestamp is the IST day. */
function dayOf(v: string): string {
  return PLAIN_DAY.test(v) ? v : v.length > 10 ? toIstDate(v) : v;
}

const PAY_COLUMNS = "id, customer_id, quote_id, invoice_id, amount, status, credit_applied, received_at, refunded_at";

export const customerOverview = defineHelpTool({
  name: "customer_overview",
  describe: "one customer's money position (customer_id from find_customer): what they owe — the same Outstanding the Customer page shows — any credit or unused advance, open and overdue invoices, last payment and monthly recurring revenue",
  input: z.object({ customer_id: z.string().uuid() }).strict(),
  roles: OWNER,
  tier: "read",
  page: "/customers",
  label: "Open Customers",
  maxRows: 1,
  async run({ customer_id }, { db, now }) {
    const today = istToday(now);
    if (!UUID.test(customer_id)) return { text: "No customer was looked up: that is not a customer id.", sources: [] };

    const found = await db.read<{ id: string; name: string | null }>("customers", "id, name").eq("id", customer_id).limit(1);
    if (found.error) throw found.error;
    const [customer] = found.data ?? [];
    if (!customer) return { text: "No customer with that id exists in this company.", rows: [], total: 0, sources: [] };
    const name = cleanHelpText(customer.name) || "Unnamed customer";
    const cited = [{ table: "customers", ids: [customer_id], href: `/customers/${customer_id}`, label: "Open this customer (its Outstanding)" }];

    try {
      const invoices = await readAll<InvoiceRow>("invoices", (a, b) => db
        .read<InvoiceRow>("invoices", "id, invoice_date, due_date, status, amount, net_payable, paid_amount, written_off_at, document_kind, opening_balance, quote_id")
        .eq("customer_id", customer_id).order("invoice_date", { ascending: false }).order("id", { ascending: true }).range(a, b));
      const quotes = await readAll<{ id: string }>("quotes", (a, b) => db
        .read<{ id: string }>("quotes", "id").eq("customer_id", customer_id).order("id", { ascending: true }).range(a, b));
      const own = await readAll<PaymentRow>("payments", (a, b) => db
        .read<PaymentRow>("payments", PAY_COLUMNS).eq("customer_id", customer_id)
        .order("received_at", { ascending: false }).order("id", { ascending: true }).range(a, b));
      /* The /payments rule: a receipt taken before the lead was converted has no customer_id — its quote is this customer's. */
      const viaQuote = await readAllIn<PaymentRow>("payments", quotes.map((q) => q.id), (ids, a, b) => db
        .read<PaymentRow>("payments", PAY_COLUMNS).in("quote_id", ids)
        .order("received_at", { ascending: false }).order("id", { ascending: true }).range(a, b));
      const seen = new Set<string>();
      const payments: PaymentRow[] = [];
      for (const p of [...own, ...viaQuote]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        payments.push(p);
      }
      const creditNotes = await readAll<CreditNoteRow>("credit notes", (a, b) => db
        .read<CreditNoteRow>("credit_notes", "id, invoice_id, credit_date, amount")
        .eq("customer_id", customer_id).order("id", { ascending: true }).range(a, b));
      const debitNotes = await readAll<DebitNoteRow>("debit notes", (a, b) => db
        .read<DebitNoteRow>("debit_notes", "id, invoice_id, debit_date, amount")
        .eq("customer_id", customer_id).order("id", { ascending: true }).range(a, b));
      const projects = await readAll<{ id: string }>("projects", (a, b) => db
        .read<{ id: string }>("project_sales", "id").eq("customer_id", customer_id).order("id", { ascending: true }).range(a, b));
      const projectPays = await readAllIn<ProjectPaymentRow>("project payments", projects.map((p) => p.id), (ids, a, b) => db
        .read<ProjectPaymentRow>("project_payments", "id, project_id, amount, received_at, method").in("project_id", ids)
        .order("received_at", { ascending: false }).order("id", { ascending: true }).range(a, b));
      const subscriptions = await readAll<SubscriptionRow>("subscriptions", (a, b) => db
        .read<SubscriptionRow>("subscriptions", "id, quote_id, outstanding_amount, written_off_at, status, mrr, start_date")
        .eq("customer_id", customer_id).order("start_date", { ascending: false }).order("id", { ascending: true }).range(a, b));

      /* The Customer page's own working (statement-core): same inputs, same functions, same number. */
      const projectPayments: StatementProjectPayment[] = projectPays.map((p) => ({
        received_at: p.received_at, amount: p.amount, project_title: "Project", project_id: p.project_id, method: p.method,
      }));
      const balance = customerBalance({ invoices, payments, creditNotes, debitNotes, projectPayments, subscriptions });

      /* Open / overdue invoices: the Invoices page's rule, the same as list_invoices (R-2776). */
      const open = invoices.filter((r) => (r.status === "pending" || r.status === "overdue") && r.written_off_at == null && invoiceBalance(r) > 0);
      const overdue = open.filter((r) => invoiceIsOverdue(r, today));
      let openOwed = 0;
      for (const r of open) openOwed += invoiceBalance(r);
      let overdueOwed = 0;
      for (const r of overdue) overdueOwed += invoiceBalance(r);

      /* Last money in: a received payment (the cash part) or a project receipt that is not a TDS part. */
      let last: { day: string; at: string; amount: number } | null = null;
      for (const p of payments) {
        if (p.status !== "received") continue;
        const cand = { day: dayOf(p.received_at), at: p.received_at, amount: cashReceived({ amount: p.amount ?? 0, credit_applied: p.credit_applied }) };
        if (!last || cand.day > last.day || (cand.day === last.day && cand.at > last.at)) last = cand;
      }
      for (const p of projectPays) {
        if (p.method === "tds") continue;
        const cand = { day: dayOf(p.received_at), at: p.received_at, amount: p.amount ?? 0 };
        if (!last || cand.day > last.day || (cand.day === last.day && cand.at > last.at)) last = cand;
      }
      let mrr = 0;
      for (const s of subscriptions) if (s.status === "active") mrr += s.mrr ?? 0;

      const rowsOut = balance.statement.rows;
      const [firstEntry] = rowsOut;
      const [lastEntry] = rowsOut.slice(-1);
      const first = firstEntry ? dayOf(firstEntry.date) : null;
      const lastRow = lastEntry ? dayOf(lastEntry.date) : null;
      const period = first && lastRow ? `all records from ${first} to ${lastRow}` : "no records yet";

      const lines = [
        `Customer: ${name}. Scope: this one customer only — ${period}, as of ${today} (IST).`,
        balance.credit > 0
          ? `Outstanding (the Customer page's Outstanding): ${rupee(0)} — nothing is owed. The customer has ${rupee(balance.credit)} credit with us (unused advance or credit).`
          : `Outstanding (the Customer page's Outstanding): ${rupee(balance.outstanding)}${balance.outstanding > 0 ? " owed" : " — all clear"}.`,
        "This is the Statement closing: invoices + debit notes − payments − credit notes + refunds, less written-off amounts, plus instalments due before an invoice exists.",
        `Open invoices: ${num(open.length)} owing ${rupee(openOwed)}. Overdue: ${num(overdue.length)} owing ${rupee(overdueOwed)}.`,
        last ? `Last payment: ${last.day}, ${rupee(last.amount)} received.` : "Last payment: none on record.",
        `Monthly recurring revenue (active subscriptions): ${rupee(mrr)}.`,
      ];
      for (const n of balance.statement.advanceNotes) lines.push(cleanHelpText(n, 200));

      return {
        text: lines.join("\n"),
        rows: [{
          customer: name, outstanding: balance.outstanding, credit: balance.credit, open_invoices: open.length, open_invoices_owed: openOwed,
          overdue_invoices: overdue.length, overdue_owed: overdueOwed, last_payment_date: last?.day ?? null, last_payment_amount: last?.amount ?? null, mrr,
        }],
        total: 1,
        sources: cited,
      };
    } catch (e) {
      if (e instanceof TooMany) {
        return {
          text: `${name} has more than ${num(OVERVIEW_SCAN_MAX)} ${e.what} — too many to total here, so no figure is given. Open the Customer page for the Outstanding.`,
          sources: cited,
        };
      }
      throw e;
    }
  },
});

export const CUSTOMER_OVERVIEW_TOOLS = [customerOverview] as const;
