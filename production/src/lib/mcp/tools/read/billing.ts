/**
 * Read tools — Billing & Subscriptions (customers, quotes, invoices, payments, renewals,
 * subscriptions). READ ONLY: nothing here writes a billing table, and the only billing code
 * used is imported pure helpers (invoice balance / overdue rules) so the numbers match the app.
 */
import { z } from "zod";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { invoiceIsOverdue, invoiceOverdueDays } from "@/lib/invoices/overdue";
import type { McpContext } from "@/lib/mcp/context";
import { contact, fromExGst, fromStored, inr, istDate, istDateTime, numOrNull, pageOf, paging, str, text } from "@/lib/mcp/format";
import { dbFail, defineTool, fail, ok } from "@/lib/mcp/tools/types";
import { rupee } from "@/lib/utils";

const PAGE = { limit: z.number().int().min(1).max(50).optional().describe("Rows per page (default 20, max 50)"), offset: z.number().int().min(0).optional().describe("Rows to skip — use next_offset from the previous page") };
const ID = z.string().trim().min(1).max(80);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const INVOICE_COLS = [
  "id", "customer_id", "customer_name", "invoice_date", "due_date", "status", "amount", "taxable_value", "tax_amount",
  "tax_rate", "net_payable", "paid_amount", "paid_date", "document_kind", "inter_state", "written_off_at",
] as const;
type InvoiceRow = {
  id: string; customer_id: string | null; customer_name: string | null; invoice_date: string | null; due_date: string | null;
  status: string; amount: number | null; taxable_value: number | null; tax_amount: number | null; tax_rate: number | null;
  net_payable: number | null; paid_amount: number | null; paid_date: string | null; document_kind: string | null;
  inter_state: boolean | null; written_off_at: string | null;
};

function invoiceOut(r: InvoiceRow, today: string) {
  const inv = { ...r, amount: r.amount ?? 0, paid_amount: r.paid_amount ?? 0 };
  const balance = invoiceBalance(inv);
  return {
    id: r.id,
    customer: text(r.customer_name, 120),
    customer_id: r.customer_id,
    date: istDate(r.invoice_date),
    due: istDate(r.due_date),
    status: invoiceIsOverdue(inv, today) ? "overdue" : r.status,
    overdue_days: invoiceOverdueDays(inv, today) || null,
    money: fromStored(r.taxable_value, r.tax_amount, r.amount, r.tax_rate, r.inter_state),
    paid: inr(r.paid_amount ?? 0),
    balance_due: rupee(balance, { decimals: 2 }),
    written_off: !!r.written_off_at,
    open_in_app: `/invoices/${encodeURIComponent(r.id)}`,
  };
}

// ── Customers ─────────────────────────────────────────────────────────────────────────

const CUSTOMER_COLS = ["id", "name", "display_name", "customer_number", "customer_type", "contact_name", "contact_email", "contact_phone", "city", "state", "gstin", "is_active", "since"] as const;

function customerOut(ctx: McpContext, c: Record<(typeof CUSTOMER_COLS)[number], unknown>) {
  return {
    id: c.id,
    name: text(c.display_name, 120) ?? text(c.name, 120),
    number: str(c.customer_number),
    type: str(c.customer_type),
    contact: text(c.contact_name, 80),
    phone: contact(ctx.role, c.contact_phone),
    email: contact(ctx.role, c.contact_email),
    city: str(c.city),
    state: str(c.state),
    gstin: str(c.gstin),
    active: c.is_active !== false,
    since: istDate(c.since),
    open_in_app: `/customers/${encodeURIComponent(String(c.id))}`,
  };
}

export const listCustomers = defineTool({
  name: "list_customers",
  title: "List customers",
  description: "Customers, A→Z. Search by name, number, contact, email or GSTIN. Inactive customers hidden unless asked.",
  kind: "read",
  page: "/customers",
  input: z.object({ search: z.string().max(80).optional(), include_inactive: z.boolean().optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select<Record<(typeof CUSTOMER_COLS)[number], unknown>>("customers", CUSTOMER_COLS, { count: true });
    if (!i.include_inactive) q = q.eq("is_active", true);
    if (i.search) q = q.search(["name", "display_name", "customer_number", "contact_name", "contact_email", "gstin"], i.search);
    const r = await q.order("name").page(p.offset, p.limit);
    if (r.error) return dbFail("customers", r.error);
    return ok(pageOf((r.data ?? []).map((c) => customerOut(ctx, c)), p, r.count));
  },
});

export const getCustomer = defineTool({
  name: "get_customer",
  title: "Get one customer",
  description: "One customer with its subscriptions, latest 10 invoices and dues (unpaid invoice balance). For the full statement with credit notes and advances, open the customer page in ResellerOS.",
  kind: "read",
  page: "/customers",
  input: z.object({ id: ID.describe("Customer id from list_customers") }).strict(),
  async run(ctx, i) {
    const r = await ctx.db.select<Record<(typeof CUSTOMER_COLS)[number], unknown>>("customers", CUSTOMER_COLS).eq("id", i.id);
    if (r.error) return dbFail("the customer", r.error);
    const c = r.data?.[0];
    if (!c) return fail("not_found", `No customer ${i.id} that you can see. Check the id with list_customers.`);
    const today = istToday(ctx.now);
    const [subs, invs, owed] = await Promise.all([
      ctx.db.select("subscriptions", ["id", "plan", "vendor", "seats", "mrr", "status", "billing_cycle", "renewal_date", "domain"]).eq("customer_id", i.id).order("renewal_date").page(0, 50),
      ctx.db.select<InvoiceRow>("invoices", INVOICE_COLS).eq("customer_id", i.id).order("invoice_date", { ascending: false }).page(0, 10),
      ctx.db.select<InvoiceRow>("invoices", INVOICE_COLS).eq("customer_id", i.id).in("status", ["pending", "overdue"]).is("written_off_at", null).page(0, 200),
    ]);
    let dues: unknown = "unavailable";
    if (!owed.error) {
      const rows = (owed.data ?? []).map((x) => ({ ...x, amount: x.amount ?? 0, paid_amount: x.paid_amount ?? 0 }));
      const total = rows.reduce((s, x) => s + invoiceBalance(x), 0);
      const overdue = rows.filter((x) => invoiceIsOverdue(x, today)).reduce((s, x) => s + invoiceBalance(x), 0);
      dues = { unpaid_invoices: rows.filter((x) => invoiceBalance(x) > 0).length, balance_due_incl_gst: rupee(total, { decimals: 2 }), of_which_overdue: rupee(overdue, { decimals: 2 }) };
    }
    return ok({
      ...customerOut(ctx, c),
      dues,
      subscriptions: subs.error ? `unavailable: ${subs.error.message}` : (subs.data ?? []).map((s) => ({
        id: s.id, plan: text(s.plan, 80), vendor: s.vendor, seats: s.seats, status: s.status, cycle: s.billing_cycle,
        mrr: fromExGst(s.mrr), renews: istDate(s.renewal_date), domain: str(s.domain),
      })),
      recent_invoices: invs.error ? `unavailable: ${invs.error.message}` : (invs.data ?? []).map((x) => invoiceOut(x, today)),
    });
  },
});

// ── Quotes ────────────────────────────────────────────────────────────────────────────

const QUOTE_COLS = ["id", "customer_id", "customer_name", "lead_id", "status", "approval_status", "plan", "seats", "billing_cycle", "subtotal", "tax_rate", "amount", "created_date", "expires_date", "invoice_id", "is_renewal", "payment_status"] as const;
type QuoteRow = Record<(typeof QUOTE_COLS)[number], unknown>;

function quoteOut(q: QuoteRow) {
  return {
    id: q.id,
    customer: text(q.customer_name, 120),
    customer_id: str(q.customer_id),
    lead_id: str(q.lead_id),
    status: q.status,
    approval: q.approval_status,
    plan: text(q.plan, 80),
    seats: q.seats ?? null,
    cycle: q.billing_cycle,
    money: q.subtotal != null
      ? { ...fromExGst(q.subtotal, q.tax_rate ?? 18), total: inr(q.amount) }
      : { ex_gst: "unknown", gst: "unknown", gst_rate: `${numOrNull(q.tax_rate) ?? 18}%`, total: inr(q.amount) },
    created: istDate(q.created_date),
    expires: istDate(q.expires_date),
    renewal: q.is_renewal === true,
    invoice_id: str(q.invoice_id),
    payment: q.payment_status ?? null,
    open_in_app: `/quotes/${encodeURIComponent(String(q.id))}`,
  };
}

export const listQuotes = defineTool({
  name: "list_quotes",
  title: "List quotes",
  description: "Quotes, newest first. Filter by status (draft, sent, viewed, accepted, rejected, expired …) or customer.",
  kind: "read",
  page: "/quotes",
  input: z.object({ status: z.string().max(30).regex(/^[a-z_]+$/).optional(), customer_id: z.string().max(80).optional(), search: z.string().max(80).optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select<QuoteRow>("quotes", QUOTE_COLS, { count: true });
    if (i.status) q = q.eq("status", i.status);
    if (i.customer_id) q = q.eq("customer_id", i.customer_id);
    if (i.search) q = q.search(["customer_name", "plan", "id"], i.search);
    const r = await q.order("created_date", { ascending: false }).page(p.offset, p.limit);
    if (r.error) return dbFail("quotes", r.error);
    return ok(pageOf((r.data ?? []).map(quoteOut), p, r.count));
  },
});

export const getQuote = defineTool({
  name: "get_quote",
  title: "Get one quote",
  description: "One quote with its money split (ex-GST, GST, total), status, approval and linked invoice.",
  kind: "read",
  page: "/quotes",
  input: z.object({ id: ID }).strict(),
  async run(ctx, i) {
    const r = await ctx.db.select<QuoteRow>("quotes", QUOTE_COLS).eq("id", i.id);
    if (r.error) return dbFail("the quote", r.error);
    const q = r.data?.[0];
    if (!q) return fail("not_found", `No quote ${i.id} that you can see.`);
    return ok(quoteOut(q));
  },
});

// ── Invoices ──────────────────────────────────────────────────────────────────────────

export const listInvoices = defineTool({
  name: "list_invoices",
  title: "List invoices",
  description: "Invoices, newest first. status: unpaid (money still owed) | overdue (past due date, money owed) | paid. Optional invoice date range (YYYY-MM-DD) and customer. Amounts show taxable value, GST (CGST+SGST or IGST) and total.",
  kind: "read",
  page: "/invoices",
  input: z.object({
    status: z.enum(["unpaid", "overdue", "paid"]).optional(),
    from: DATE.optional(), to: DATE.optional(),
    customer_id: z.string().max(80).optional(),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    const today = istToday(ctx.now);
    let q = ctx.db.select<InvoiceRow>("invoices", INVOICE_COLS, { count: true });
    if (i.status === "paid") q = q.eq("status", "paid");
    if (i.status === "unpaid" || i.status === "overdue") q = q.in("status", ["pending", "overdue"]).is("written_off_at", null);
    if (i.status === "overdue") q = q.lt("due_date", today);
    if (i.from) q = q.gte("invoice_date", i.from);
    if (i.to) q = q.lte("invoice_date", i.to);
    if (i.customer_id) q = q.eq("customer_id", i.customer_id);
    const r = await q.order(i.status === "overdue" ? "due_date" : "invoice_date", { ascending: i.status === "overdue" }).page(p.offset, p.limit);
    if (r.error) return dbFail("invoices", r.error);
    const rows = (r.data ?? []).map((x) => invoiceOut(x, today));
    /* The status filter is in SQL; "money still owed" is the app's own rule (invoiceBalance), applied here. */
    const items = i.status === "unpaid" || i.status === "overdue" ? rows.filter((x) => x.balance_due !== "₹0.00") : rows;
    return ok(pageOf(items, p, r.count));
  },
});

export const getInvoice = defineTool({
  name: "get_invoice",
  title: "Get one invoice",
  description: "One invoice: dates, taxable value, GST split, total, paid, balance due, and payments received against it.",
  kind: "read",
  page: "/invoices",
  input: z.object({ id: ID }).strict(),
  async run(ctx, i) {
    const r = await ctx.db.select<InvoiceRow>("invoices", INVOICE_COLS).eq("id", i.id);
    if (r.error) return dbFail("the invoice", r.error);
    const inv = r.data?.[0];
    if (!inv) return fail("not_found", `No invoice ${i.id} that you can see.`);
    const pays = await ctx.db.select("payments", ["id", "amount", "method", "status", "received_at", "receipt_voucher_no"]).eq("invoice_id", i.id).order("received_at").page(0, 50);
    return ok({
      ...invoiceOut(inv, istToday(ctx.now)),
      payments: pays.error ? `unavailable: ${pays.error.message}` : (pays.data ?? []).map((x) => ({
        id: x.id, amount: inr(x.amount), method: x.method, status: x.status, received: istDate(x.received_at), receipt: str(x.receipt_voucher_no),
      })),
    });
  },
});

// ── Payments ──────────────────────────────────────────────────────────────────────────

export const listPayments = defineTool({
  name: "list_payments",
  title: "List payments received",
  description: "Payments received, newest first, optionally in a date range (YYYY-MM-DD, IST) or for one customer. Amounts are what was received (GST-inclusive).",
  kind: "read",
  page: "/payments",
  input: z.object({ from: DATE.optional(), to: DATE.optional(), customer_id: z.string().max(80).optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select("payments", ["id", "customer_id", "invoice_id", "amount", "method", "status", "received_at", "refunded_at", "receipt_voucher_no"], { count: true });
    if (i.from) q = q.gte("received_at", new Date(`${i.from}T00:00:00+05:30`).toISOString());
    if (i.to) q = q.lt("received_at", new Date(`${addDaysISO(i.to, 1)}T00:00:00+05:30`).toISOString());
    if (i.customer_id) q = q.eq("customer_id", i.customer_id);
    const r = await q.order("received_at", { ascending: false }).page(p.offset, p.limit);
    if (r.error) return dbFail("payments", r.error);
    return ok(pageOf((r.data ?? []).map((x) => ({
      id: x.id, customer_id: str(x.customer_id), invoice_id: str(x.invoice_id), amount: inr(x.amount), method: x.method,
      status: x.status, received: istDateTime(x.received_at), refunded: x.refunded_at ? istDate(x.refunded_at) : null, receipt: str(x.receipt_voucher_no),
    })), p, r.count));
  },
});

// ── Subscriptions & renewals ──────────────────────────────────────────────────────────

const SUB_COLS = ["id", "customer_id", "customer_name", "plan", "vendor", "seats", "mrr", "term_amount", "status", "billing_cycle", "renewal_date", "renewal_state", "auto_renew", "domain", "outstanding_amount"] as const;
type SubRow = Record<(typeof SUB_COLS)[number], unknown>;

function subOut(s: SubRow, today: string) {
  const renew = str(s.renewal_date);
  return {
    id: s.id,
    customer: text(s.customer_name, 120),
    customer_id: str(s.customer_id),
    plan: text(s.plan, 80),
    vendor: s.vendor,
    seats: s.seats,
    status: s.status,
    cycle: s.billing_cycle,
    mrr: fromExGst(s.mrr),
    renews: istDate(renew),
    days_to_renewal: renew ? Math.round((Date.parse(`${renew.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null,
    renewal_state: s.renewal_state,
    auto_renew: s.auto_renew === true,
    domain: str(s.domain),
    outstanding: inr(s.outstanding_amount),
    open_in_app: "/subscriptions",
  };
}

export const listSubscriptions = defineTool({
  name: "list_subscriptions",
  title: "List subscriptions",
  description: "Subscriptions (Google Workspace, Microsoft 365, Zoho, hosting, domains …). Filter by status, vendor or customer. MRR is ex-GST with GST shown separately.",
  kind: "read",
  page: "/subscriptions",
  input: z.object({
    status: z.enum(["active", "paused", "expired", "cancelled"]).optional(),
    vendor: z.string().max(30).regex(/^[a-z_]+$/).optional(),
    customer_id: z.string().max(80).optional(),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select<SubRow>("subscriptions", SUB_COLS, { count: true });
    if (i.status) q = q.eq("status", i.status);
    if (i.vendor) q = q.eq("vendor", i.vendor);
    if (i.customer_id) q = q.eq("customer_id", i.customer_id);
    const r = await q.order("renewal_date").page(p.offset, p.limit);
    if (r.error) return dbFail("subscriptions", r.error);
    const today = istToday(ctx.now);
    return ok(pageOf((r.data ?? []).map((s) => subOut(s, today)), p, r.count));
  },
});

export const listRenewals = defineTool({
  name: "list_renewals",
  title: "List renewals due",
  description: "Active subscriptions whose renewal date falls within the next N days (IST; default 30), soonest first — including ones already past their date. Filter by product text (plan name).",
  kind: "read",
  page: "/renewals",
  input: z.object({
    due_within_days: z.number().int().min(0).max(365).optional(),
    product: z.string().max(60).optional().describe("Plan name contains this text, e.g. 'Workspace', 'Business Starter'"),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    const today = istToday(ctx.now);
    let q = ctx.db.select<SubRow>("subscriptions", SUB_COLS, { count: true })
      .eq("status", "active")
      .lte("renewal_date", addDaysISO(today, i.due_within_days ?? 30))
      .not_null("renewal_date");
    if (i.product) q = q.search(["plan"], i.product);
    const r = await q.order("renewal_date").page(p.offset, p.limit);
    if (r.error) return dbFail("renewals", r.error);
    return ok(pageOf((r.data ?? []).map((s) => ({ ...subOut(s, today), open_in_app: "/renewals" })), p, r.count));
  },
});

export const BILLING_READ_TOOLS = [listCustomers, getCustomer, listQuotes, getQuote, listInvoices, getInvoice, listPayments, listSubscriptions, listRenewals];
