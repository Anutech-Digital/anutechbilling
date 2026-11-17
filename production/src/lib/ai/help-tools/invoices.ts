/**
 * Help AI read tool: list_invoices (R-2776 / H-03, G-HELPAI).
 *
 * Mirrors the Invoices page (/invoices): the same `invoices` rows, and every number comes from the
 * same helpers that page uses — invoiceBalance (what is still owed: net of advances and receipts,
 * 0 when written off / paid / void), invoiceIsOverdue + the IST day (overdue is derived, R-060) and
 * the same Σ-in-list-order as invoiceKpis, so "owed" here is the page's Outstanding / Overdue
 * tile for the same set of invoices. Amounts are whole rupees as stored.
 *
 * Inputs the model may send: a customer id (uuid), a status choice (enum), a date range
 * (YYYY-MM-DD strings, checked), a row limit (1-20). The tenant is never an input.
 * Reads: one paged query (tenant filter by the reader); allow-listed columns only — no GSTIN,
 * address, IRN, PDF or line items. Shows at most 20 invoices ("showing N of M"); the total owed
 * is over ALL matches. More than INVOICE_SCAN_MAX matches → no total (never a partial sum).
 */
import { z } from "zod";
import type { UserRole } from "@/lib/auth/roles";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { istToday } from "@/lib/dates/ist";
import { invoiceIsOverdue, invoiceOverdueDays } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { rupee, num, formatDate } from "@/lib/utils";
import { defineHelpTool, type HelpSourceRef } from "./types";
import { cleanHelpText } from "./untrusted";

const OWNER = ["owner"] as const satisfies readonly UserRole[];

export const INVOICE_ROWS_MAX = 20;
const INVOICE_ROWS_DEFAULT = 10;
/** Most invoices read to make a total. Over this the tool says so instead of adding a partial sum. */
export const INVOICE_SCAN_MAX = 5000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An invoice number safe to put in a path as it is (series with a "/" or odd characters link to the list instead). */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A real calendar day written YYYY-MM-DD (a string, never a Date — the schema stays a plain string). */
function isRealDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false; // years 1900-2100 only (Postgres refuses year 0)
  return d <= daysInMonth(y, m);
}

/** Days in a month — a switch (no computed array read). */
function daysInMonth(y: number, m: number): number {
  switch (m) {
    case 2: return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    case 4: case 6: case 9: case 11: return 30;
    default: return 31;
  }
}
const DATE_INPUT = z.string().regex(DATE).refine(isRealDate, "not a real date (YYYY-MM-DD)");

export const INVOICE_STATUS_CHOICES = ["unpaid", "overdue", "paid", "draft", "void", "all"] as const;
type StatusChoice = (typeof INVOICE_STATUS_CHOICES)[number];

interface InvoiceRow {
  id: string;
  customer_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  status: string;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  written_off_at: string | null;
}

/** What each choice means, as the Invoices page tabs / tiles read it. A switch: the choice is never a key. */
function describeChoice(c: StatusChoice): string {
  switch (c) {
    case "unpaid": return "unpaid (still owed — the page's Outstanding)";
    case "overdue": return "overdue (past the due date and still owed)";
    case "paid": return "paid";
    case "draft": return "draft";
    case "void": return "void";
    case "all": return "of every status";
  }
}

export const listInvoices = defineHelpTool({
  name: "list_invoices",
  describe: "invoices for one customer (customer_id from find_customer) or for the whole company, by status (unpaid = still owed, overdue, paid, draft, void, all) and an optional invoice-date range (YYYY-MM-DD); gives how many match, the total still owed, and up to 20 invoices (newest first) with number, customer, dates, amount and balance",
  input: z.object({
    customer_id: z.string().uuid().optional(),
    status: z.enum(INVOICE_STATUS_CHOICES).optional(),
    from: DATE_INPUT.optional(),
    to: DATE_INPUT.optional(),
    limit: z.number().int().min(1).max(INVOICE_ROWS_MAX).optional(),
  }).strict(),
  roles: OWNER,
  tier: "read",
  page: "/invoices",
  label: "Open Invoices",
  maxRows: INVOICE_ROWS_MAX,
  async run({ customer_id, status, from, to, limit }, { db, now }) {
    const choice: StatusChoice = status ?? "unpaid";
    if (from && to && from > to) return { text: "No invoices were read: the start date is after the end date.", sources: [] };
    const today = istToday(now);
    const cap = limit ?? INVOICE_ROWS_DEFAULT;

    const rows = await fetchAllRows<InvoiceRow>((a, b) => {
      let q = db.read<InvoiceRow>("invoices", "id, customer_name, invoice_date, due_date, status, amount, net_payable, paid_amount, written_off_at");
      if (customer_id) q = q.eq("customer_id", customer_id);
      if (from) q = q.gte("invoice_date", from);
      if (to) q = q.lte("invoice_date", to);
      switch (choice) {
        case "unpaid":
        case "overdue":
          q = q.in("status", ["pending", "overdue"]).is("written_off_at", null);
          break;
        case "paid":
          q = q.eq("status", "paid");
          break;
        case "draft":
          q = q.eq("status", "draft");
          break;
        case "void":
          q = q.eq("status", "void");
          break;
        case "all":
          break;
      }
      /* The order ENDS on id (a total order, so pages never repeat or skip a row) — the page's own order. */
      return q.order("invoice_date", { ascending: false }).order("id", { ascending: true }).range(a, b);
    }, { maxRows: INVOICE_SCAN_MAX + 1 });

    const scope = customer_id ? "for this customer" : "in this company";
    const dates = from || to ? ` with invoice date ${from ? `from ${from} ` : ""}${to ? `to ${to}` : ""}`.trimEnd() : "";
    if (rows.length > INVOICE_SCAN_MAX) {
      return {
        text: `More than ${num(INVOICE_SCAN_MAX)} ${describeChoice(choice)} invoices ${scope}${dates} — too many to total here. Ask for one customer or a shorter date range, or open the Invoices page.`,
        sources: [],
      };
    }

    const matched = rows.filter((r) => (choice === "unpaid" ? invoiceBalance(r) > 0 : choice === "overdue" ? invoiceIsOverdue(r, today) : true));
    /* The same sum, in the same order, as the page's invoiceKpis: Σ invoiceBalance over the list. */
    let owed = 0;
    for (const r of matched) owed += invoiceBalance(r);
    const shown = matched.slice(0, cap);

    const head = `${num(matched.length)} ${describeChoice(choice)} invoice${matched.length === 1 ? "" : "s"} ${scope}${dates}.`;
    const lines = [head];
    if (customer_id) {
      /* R-2776 (checker BLOCK): in one customer's scope this is the OPEN-INVOICE balance only. The Customer page's
         Outstanding is the statement closing (R-2183) — it also takes off credit notes and unused advances — and is
         NOT computed here (R-2884). Say so, and link the page where the real figure is. */
      if (matched.length) lines.push(`Open-invoice balance on ${choice === "all" ? "them" : "these"} (open invoices only): ${rupee(owed)}.`);
      lines.push("This counts open invoices only. The Customer page's Outstanding also subtracts credit notes and unused advances, so open the customer's page for the real figure.");
    } else if (matched.length) lines.push(`Still owed on ${choice === "all" ? "them" : "these"} (Invoices page balance): ${rupee(owed)}.`);
    if (choice === "paid") lines.push("Paid here includes invoices closed by a credit note (the Invoices page shows those as Credited).");

    const sources: HelpSourceRef[] = [];
    const out = shown.map((r) => {
      const id = cleanHelpText(r.id, 80);
      const customer = cleanHelpText(r.customer_name) || "Unnamed customer";
      const overdue = invoiceIsOverdue(r, today);
      const bucket = overdue ? "overdue" : r.status;
      const balance = invoiceBalance(r);
      const days = invoiceOverdueDays(r, today);
      lines.push(`- ${id} — ${customer} — dated ${formatDate(r.invoice_date)} — due ${formatDate(r.due_date)} — total ${rupee(r.amount)} — owed ${rupee(balance)} — ${bucket}${days > 0 ? ` ${days} days` : ""}`);
      if (typeof r.id === "string" && PLAIN_ID.test(r.id)) {
        sources.push({ table: "invoices", ids: [r.id], href: `/invoices/${r.id}`, label: `Open invoice ${id}` });
      }
      return {
        invoice: id, customer, invoice_date: r.invoice_date ?? null, due_date: r.due_date ?? null,
        amount: r.amount, owed: balance, status: bucket,
      };
    });
    /* The customer's own page comes first (the real Outstanding); the schema allows 20 sources, so at most 19 invoices follow. */
    const cited: HelpSourceRef[] = customer_id && UUID.test(customer_id)
      ? [{ table: "customers", ids: [customer_id], href: `/customers/${customer_id}`, label: "Open this customer (its Outstanding)" }, ...sources.slice(0, 19)]
      : sources;
    return { text: lines.join("\n"), rows: out, total: matched.length, sources: cited };
  },
});

export const INVOICE_TOOLS = [listInvoices] as const;
