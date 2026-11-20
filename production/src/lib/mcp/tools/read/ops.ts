/**
 * Read tools — Today, dashboard, books, team and support, plus a cross-module search.
 */
import { z } from "zod";
import { addDaysISO, fyBounds, istMonth, istToday, monthBounds } from "@/lib/dates/ist";
import { canSeeDeals } from "@/lib/deals/access";
import { OPEN_DEAL_STAGES, type DealRow } from "@/lib/deals/pipeline-summary";
import { dealTodayItems } from "@/lib/today/deals";
import { kindMeta, rankTodayItems, type TodayItem } from "@/lib/today/inbox";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import type { McpContext } from "@/lib/mcp/context";
import { contact, fromExGst, inr, istDate, istDateTime, pageOf, paging, str, text } from "@/lib/mcp/format";
import { dbFail, defineTool, deniedReason, fail, ok, type McpToolDef } from "@/lib/mcp/tools/types";
import { roleLabel } from "@/lib/auth/roles";
import { rupee } from "@/lib/utils";

const PAGE = { limit: z.number().int().min(1).max(50).optional().describe("Rows per page (default 20, max 50)"), offset: z.number().int().min(0).optional().describe("Rows to skip — use next_offset from the previous page") };
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");

/** May this role see what a page shows? Same rule as the tools (nav + permissions). */
function sees(ctx: McpContext, page: string, extra?: Partial<Pick<McpToolDef, "roles" | "permission">>): boolean {
  return deniedReason(ctx.role, { page, title: page, ...extra }) === null;
}

// ── Today ─────────────────────────────────────────────────────────────────────────────

export const getTodayQueue = defineTool({
  name: "get_today_queue",
  title: "Today's queue",
  description: "Everything that wants attention today, ranked like the /today page: tasks, enquiries, support, renewals, overdue invoices, failed payments, approvals, and (if you can see deals) deals closing or stale. GST/TDS deadlines are on /compliance and not repeated here.",
  kind: "read",
  page: "/today",
  input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  async run(ctx, i) {
    const r = await ctx.db.rpc<TodayItem[]>("today_inbox");
    if (r.error) return dbFail("today's queue", r.error);
    let items: TodayItem[] = Array.isArray(r.data) ? r.data : [];
    let dealsNote: string | null = null;
    if (canSeeDeals(ctx.role)) {
      const d = await ctx.db.select<DealRow>("leads", ["id", "company", "stage", "value", "expected_close_date", "stage_changed_at", "created_at", "owner_id"])
        .in("stage", OPEN_DEAL_STAGES).eq("is_junk", false).page(0, 200);
      if (d.error) dealsNote = `Deal rows unavailable: ${d.error.message}`;
      else items = [...items, ...dealTodayItems(d.data ?? [], null, ctx.now)];
    }
    const ranked = rankTodayItems(items).slice(0, i.limit ?? 30);
    return ok({
      date: istDate(istToday(ctx.now)),
      total: items.length,
      items: ranked.map((x) => ({ kind: kindMeta(x.kind).label, title: text(x.title, 200), due: istDateTime(x.due_at), priority: x.priority, urgent: x.priority >= 75, open_in_app: x.href })),
      note: dealsNote,
    });
  },
});

// ── Dashboard ─────────────────────────────────────────────────────────────────────────

function periodRange(period: "today" | "this_week" | "this_month" | "this_fy", now: Date): { from: string; to: string; label: string } {
  const today = istToday(now);
  if (period === "today") return { from: today, to: today, label: "Today" };
  if (period === "this_week") {
    const dow = new Date(`${today}T12:00:00+05:30`).getUTCDay();   // 0 = Sunday
    const monday = addDaysISO(today, -((dow + 6) % 7));
    return { from: monday, to: today, label: "This week (Mon–today)" };
  }
  if (period === "this_month") return { from: monthBounds(istMonth(now)).start, to: today, label: "This month" };
  const fy = fyBounds(today);
  return { from: fy.start, to: today, label: `This financial year (from ${fy.start})` };
}

const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString();
const istEndExcl = (d: string) => new Date(`${addDaysISO(d, 1)}T00:00:00+05:30`).toISOString();

export const getDashboardSummary = defineTool({
  name: "get_dashboard_summary",
  title: "Dashboard summary",
  description: "Headline numbers for a period (today, this_week, this_month, this_fy — IST): new leads, open deals, invoiced (with GST), money received, overdue invoices, renewals due in 30 days, my overdue tasks, open support tickets. Parts your role cannot see are left out and say so.",
  kind: "read",
  page: "/dashboard",
  input: z.object({ period: z.enum(["today", "this_week", "this_month", "this_fy"]).optional() }).strict(),
  async run(ctx, i) {
    const range = periodRange(i.period ?? "this_month", ctx.now);
    const today = istToday(ctx.now);
    const out: Record<string, unknown> = { period: range.label, from: istDate(range.from), to: istDate(range.to) };
    const hidden: string[] = [];
    const jobs: Promise<void>[] = [];

    if (sees(ctx, "/leads")) jobs.push((async () => {
      const r = await ctx.db.select("leads", ["id"], { count: true }).eq("is_junk", false).gte("created_at", istStart(range.from)).lt("created_at", istEndExcl(range.to)).page(0, 1);
      out.new_leads = r.error ? "unavailable" : r.count ?? 0;
    })()); else hidden.push("leads");

    if (canSeeDeals(ctx.role)) jobs.push((async () => {
      const r = await ctx.db.select<{ value: number | null }>("leads", ["value"]).in("stage", OPEN_DEAL_STAGES).eq("is_junk", false).page(0, 1000);
      out.open_deals = r.error ? "unavailable" : { count: (r.data ?? []).length, value: fromExGst((r.data ?? []).reduce((s, x) => s + (x.value ?? 0), 0)) };
    })()); else hidden.push("deals");

    if (sees(ctx, "/invoices")) jobs.push((async () => {
      const [issued, owed] = await Promise.all([
        ctx.db.select<{ taxable_value: number | null; tax_amount: number | null; amount: number | null }>("invoices", ["taxable_value", "tax_amount", "amount"])
          .in("status", ["pending", "overdue", "paid"]).gte("invoice_date", range.from).lte("invoice_date", range.to).page(0, 1000),
        ctx.db.select<{ status: string; due_date: string | null; amount: number | null; net_payable: number | null; paid_amount: number | null; written_off_at: string | null }>(
          "invoices", ["status", "due_date", "amount", "net_payable", "paid_amount", "written_off_at"]).in("status", ["pending", "overdue"]).is("written_off_at", null).page(0, 1000),
      ]);
      if (issued.error) out.invoiced = "unavailable";
      else {
        const rows = issued.data ?? [];
        const sum = (k: "taxable_value" | "tax_amount" | "amount") => rows.reduce((s, x) => s + (x[k] ?? 0), 0);
        out.invoiced = { count: rows.length, ex_gst: rupee(sum("taxable_value"), { decimals: 2 }), gst: rupee(sum("tax_amount"), { decimals: 2 }), total: rupee(sum("amount"), { decimals: 2 }) };
      }
      if (owed.error) out.overdue_invoices = "unavailable";
      else {
        const rows = (owed.data ?? []).map((x) => ({ ...x, amount: x.amount ?? 0, paid_amount: x.paid_amount ?? 0 }));
        const late = rows.filter((x) => invoiceIsOverdue(x, today));
        out.overdue_invoices = { count: late.length, balance_due: rupee(late.reduce((s, x) => s + invoiceBalance(x), 0), { decimals: 2 }) };
        out.total_receivable = rupee(rows.reduce((s, x) => s + invoiceBalance(x), 0), { decimals: 2 });
      }
    })()); else hidden.push("invoices");

    if (sees(ctx, "/payments")) jobs.push((async () => {
      const r = await ctx.db.select<{ amount: number | null }>("payments", ["amount"]).gte("received_at", istStart(range.from)).lt("received_at", istEndExcl(range.to)).is("refunded_at", null).page(0, 1000);
      out.received = r.error ? "unavailable" : { count: (r.data ?? []).length, amount: rupee((r.data ?? []).reduce((s, x) => s + (x.amount ?? 0), 0), { decimals: 2 }) };
    })()); else hidden.push("payments");

    if (sees(ctx, "/renewals")) jobs.push((async () => {
      const r = await ctx.db.select<{ mrr: number | null }>("subscriptions", ["mrr"], { count: true }).eq("status", "active").lte("renewal_date", addDaysISO(today, 30)).not_null("renewal_date").page(0, 1000);
      out.renewals_next_30_days = r.error ? "unavailable" : { count: r.count ?? (r.data ?? []).length, mrr: fromExGst((r.data ?? []).reduce((s, x) => s + (x.mrr ?? 0), 0)) };
    })()); else hidden.push("renewals");

    if (sees(ctx, "/tasks")) jobs.push((async () => {
      const r = await ctx.db.select("tasks", ["id"], { count: true }).eq("status", "pending").eq("owner_id", ctx.userId).lt("due_at", istStart(today)).page(0, 1);
      out.my_overdue_tasks = r.error ? "unavailable" : r.count ?? 0;
    })());

    if (sees(ctx, "/support")) jobs.push((async () => {
      const r = await ctx.db.select("support_tickets", ["id"], { count: true }).is("resolved_at", null).page(0, 1);
      out.open_support_tickets = r.error ? "unavailable" : r.count ?? 0;
    })()); else hidden.push("support");

    await Promise.all(jobs);
    if (hidden.length) out.not_shown_for_your_role = hidden;
    out.note = "Totals over 1,000 rows are capped — open /dashboard for the full figures.";
    return ok(out);
  },
});

// ── Books ─────────────────────────────────────────────────────────────────────────────

export const listUnmatchedBankEntries = defineTool({
  name: "list_unmatched_bank_entries",
  title: "Unmatched bank entries",
  description: "Bank statement lines not yet matched to an invoice, payment, bill or expense — newest first. Optional date range (YYYY-MM-DD) and direction (credit = money in, debit = money out).",
  kind: "read",
  page: "/accounting/banking",
  input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), direction: z.enum(["credit", "debit"]).optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select("bank_transactions", ["id", "bank_account_id", "txn_date", "description", "credit", "debit", "reference", "category"], { count: true })
      .is("matched_at", null);
    if (i.from) q = q.gte("txn_date", i.from);
    if (i.to) q = q.lte("txn_date", i.to);
    if (i.direction === "credit") q = q.gt("credit", 0);
    if (i.direction === "debit") q = q.gt("debit", 0);
    const r = await q.order("txn_date", { ascending: false }).page(p.offset, p.limit);
    if (r.error) return dbFail("bank entries", r.error);
    return ok(pageOf((r.data ?? []).map((t) => ({
      id: t.id, date: istDate(t.txn_date), description: text(t.description, 160), money_in: Number(t.credit) > 0 ? inr(t.credit) : null,
      money_out: Number(t.debit) > 0 ? inr(t.debit) : null, reference: text(t.reference, 60), category: str(t.category), bank_account_id: t.bank_account_id,
    })), p, r.count));
  },
});

interface PnlRow {
  inv_taxable: number; inv_tax: number; revenue_count: number; cn_taxable: number; cn_tax: number; dn_taxable: number; dn_tax: number;
  cogs: number; cogs_count: number; commissions: number;
  expense_groups: { category: string | null; amount: number }[] | null;
}

export const getPnlSummary = defineTool({
  name: "get_pnl_summary",
  title: "Profit & loss summary",
  description: "Headline P&L for a period on the GST (as-invoiced) basis: revenue ex-GST (after credit/debit notes), output GST, cost of goods, expenses, commissions, and profit before depreciation. Owner and accountant only. The full report (depreciation, payroll moves, management basis) is /accounting/pnl.",
  kind: "read",
  page: "/accounting/pnl",
  roles: ["owner", "accountant"],
  permission: "can_view_financials",
  input: z.object({ period: z.enum(["this_month", "last_month", "this_fy", "last_fy"]).optional(), month: MONTH.optional().describe("A specific month instead of period") }).strict(),
  async run(ctx, i) {
    const today = istToday(ctx.now);
    let from: string; let to: string; let label: string;
    if (i.month) { const b = monthBounds(i.month); from = b.start; to = b.end; label = i.month; }
    else {
      const per = i.period ?? "this_month";
      if (per === "this_month") { from = monthBounds(istMonth(ctx.now)).start; to = today; label = "This month"; }
      else if (per === "last_month") { const b = monthBounds(addDaysISO(monthBounds(istMonth(ctx.now)).start, -1).slice(0, 7)); from = b.start; to = b.end; label = "Last month"; }
      else if (per === "this_fy") { const b = fyBounds(today); from = b.start; to = today; label = "This financial year"; }
      else { const b = fyBounds(addDaysISO(fyBounds(today).start, -1)); from = b.start; to = b.end; label = "Last financial year"; }
    }
    const r = await ctx.db.rpc<PnlRow | PnlRow[]>("report_pnl", { p_from: from, p_to: to });
    if (r.error) return dbFail("the P&L", r.error);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row) return fail("error", "The P&L report returned nothing for that period. Open /accounting/pnl to check.");
    const revenue = (row.inv_taxable ?? 0) - (row.cn_taxable ?? 0) + (row.dn_taxable ?? 0);
    const outputGst = (row.inv_tax ?? 0) - (row.cn_tax ?? 0) + (row.dn_tax ?? 0);
    const expenses = (row.expense_groups ?? []).reduce((s, g) => s + (Number(g.amount) || 0), 0);
    const byCat = new Map<string, number>();
    for (const g of row.expense_groups ?? []) byCat.set(g.category ?? "Uncategorised", (byCat.get(g.category ?? "Uncategorised") ?? 0) + (Number(g.amount) || 0));
    const profit = revenue - (row.cogs ?? 0) - expenses - (row.commissions ?? 0);
    return ok({
      period: label, from: istDate(from), to: istDate(to), basis: "GST (as invoiced)",
      revenue_ex_gst: rupee(revenue, { decimals: 2 }), invoices: row.revenue_count,
      output_gst: rupee(outputGst, { decimals: 2 }),
      cost_of_goods: rupee(row.cogs ?? 0, { decimals: 2 }),
      gross_margin: rupee(revenue - (row.cogs ?? 0), { decimals: 2 }),
      expenses: rupee(expenses, { decimals: 2 }),
      top_expense_heads: [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ head: k, amount: rupee(v, { decimals: 2 }) })),
      commissions: rupee(row.commissions ?? 0, { decimals: 2 }),
      profit_before_depreciation: rupee(profit, { decimals: 2 }),
      not_included: "Depreciation, project labour allocation and director-payroll moves — see /accounting/pnl for the final figure.",
      open_in_app: "/accounting/pnl",
    });
  },
});

// ── Team ──────────────────────────────────────────────────────────────────────────────

export const listStaff = defineTool({
  name: "list_staff",
  title: "List staff",
  description: "People who can log in to this company's ResellerOS, with their role. Inactive people hidden unless asked.",
  kind: "read",
  page: "/team",
  input: z.object({ include_inactive: z.boolean().optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select("users", ["id", "full_name", "email", "phone", "role", "is_active", "manager_id"], { count: true });
    if (!i.include_inactive) q = q.eq("is_active", true);
    const r = await q.order("full_name").page(p.offset, p.limit);
    if (r.error) return dbFail("staff", r.error);
    return ok(pageOf((r.data ?? []).map((u) => ({
      id: u.id, name: text(u.full_name, 80), role: roleLabel(str(u.role)), active: u.is_active !== false,
      email: contact(ctx.role, u.email), phone: contact(ctx.role, u.phone), manager_id: str(u.manager_id), is_me: u.id === ctx.userId,
    })), p, r.count));
  },
});

export const getAttendanceSummary = defineTool({
  name: "get_attendance_summary",
  title: "Attendance summary",
  description: "Attendance for one day (who checked in / out, IST) or one month (days present per employee). Default: today.",
  kind: "read",
  page: "/accounting/attendance",
  input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), month: MONTH.optional() }).strict(),
  async run(ctx, i) {
    const emps = await ctx.db.select<{ id: string; name: string; is_active: boolean }>("employees", ["id", "name", "is_active"]).eq("is_active", true).order("name").page(0, 500);
    if (emps.error) return dbFail("employees", emps.error);
    const names = new Map((emps.data ?? []).map((e) => [e.id, e.name]));
    if (i.month) {
      const b = monthBounds(i.month);
      const r = await ctx.db.select<{ employee_id: string; work_date: string; check_in: string | null }>("attendance", ["employee_id", "work_date", "check_in"])
        .gte("work_date", b.start).lte("work_date", b.end).page(0, 5000);
      if (r.error) return dbFail("attendance", r.error);
      const days = new Map<string, Set<string>>();
      for (const a of r.data ?? []) if (a.check_in) (days.get(a.employee_id) ?? days.set(a.employee_id, new Set()).get(a.employee_id)!).add(a.work_date);
      return ok({
        month: i.month,
        employees: [...names.entries()].map(([id, name]) => ({ id, name: text(name, 80), days_present: days.get(id)?.size ?? 0 })),
        open_in_app: "/accounting/attendance",
      });
    }
    const day = i.date ?? istToday(ctx.now);
    const r = await ctx.db.select<{ employee_id: string; check_in: string | null; check_out: string | null; source: string | null }>("attendance", ["employee_id", "check_in", "check_out", "source"]).eq("work_date", day).page(0, 500);
    if (r.error) return dbFail("attendance", r.error);
    const byEmp = new Map((r.data ?? []).map((a) => [a.employee_id, a]));
    const rows = [...names.entries()].map(([id, name]) => {
      const a = byEmp.get(id);
      return { id, name: text(name, 80), present: !!a?.check_in, check_in: istDateTime(a?.check_in ?? null), check_out: istDateTime(a?.check_out ?? null) };
    });
    return ok({ date: istDate(day), present: rows.filter((x) => x.present).length, absent_or_not_marked: rows.filter((x) => !x.present).length, employees: rows, open_in_app: "/accounting/attendance" });
  },
});

export const getSalarySummary = defineTool({
  name: "get_salary_summary",
  title: "Salary summary",
  description: "Salaries booked for a month (YYYY-MM): gross, deductions (PF, ESI, TDS, LOP), net, paid and still to pay — per employee and in total. Owner and manager only.",
  kind: "read",
  page: "/accounting/salary-register",
  roles: ["owner", "manager"],
  input: z.object({ month: MONTH.describe("e.g. 2026-10") }).strict(),
  async run(ctx, i) {
    const [sal, emps] = await Promise.all([
      ctx.db.select<{ employee_id: string; gross: number; net: number; paid_amount: number; paid_status: string; pay_date: string | null; tds: number; pf: number; esi: number; lop_amount: number; incentive: number }>(
        "salary_payments", ["employee_id", "gross", "net", "paid_amount", "paid_status", "pay_date", "tds", "pf", "esi", "lop_amount", "incentive"]).eq("period", i.month).page(0, 500),
      ctx.db.select<{ id: string; name: string }>("employees", ["id", "name"]).page(0, 1000),
    ]);
    if (sal.error) return dbFail("salaries", sal.error);
    const names = new Map((emps.data ?? []).map((e) => [e.id, e.name]));
    const rows = sal.data ?? [];
    const sum = (k: "gross" | "net" | "paid_amount" | "tds" | "pf" | "esi" | "lop_amount") => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    return ok({
      month: i.month,
      employees: rows.map((x) => ({
        name: text(names.get(x.employee_id) ?? x.employee_id, 80), gross: inr(x.gross), incentive: inr(x.incentive), pf: inr(x.pf), esi: inr(x.esi), tds: inr(x.tds),
        lop: inr(x.lop_amount), net: inr(x.net), paid: inr(x.paid_amount), status: x.paid_status, paid_on: istDate(x.pay_date),
      })),
      totals: {
        people: rows.length, gross: rupee(sum("gross")), pf: rupee(sum("pf")), esi: rupee(sum("esi")), tds: rupee(sum("tds")), lop: rupee(sum("lop_amount")),
        net: rupee(sum("net")), paid: rupee(sum("paid_amount")), still_to_pay: rupee(Math.max(0, sum("net") - sum("paid_amount"))),
      },
      note: rows.length === 0 ? "No salary booked for this month yet." : null,
      open_in_app: "/accounting/salary-register",
    });
  },
});

// ── Support ───────────────────────────────────────────────────────────────────────────

export const listSupportTickets = defineTool({
  name: "list_support_tickets",
  title: "List support tickets",
  description: "Support tickets, newest first. Default: open ones. Filter by status, priority, or only those assigned to me.",
  kind: "read",
  page: "/support",
  input: z.object({ status: z.string().max(30).regex(/^[a-z_]+$/).optional(), priority: z.string().max(20).regex(/^[a-z_]+$/).optional(), mine_only: z.boolean().optional(), ...PAGE }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select("support_tickets", ["id", "subject", "status", "priority", "category", "customer_name", "customer_id", "assigned_agent", "created_at", "sla_due_at", "resolved_at", "channel"], { count: true });
    q = i.status ? q.eq("status", i.status) : q.is("resolved_at", null);
    if (i.priority) q = q.eq("priority", i.priority);
    if (i.mine_only) q = q.eq("assigned_agent", ctx.userId);
    const r = await q.order("created_at", { ascending: false }).page(p.offset, p.limit);
    if (r.error) return dbFail("support tickets", r.error);
    return ok(pageOf((r.data ?? []).map((t) => ({
      id: t.id, subject: text(t.subject, 160), status: t.status, priority: t.priority, category: str(t.category), customer: text(t.customer_name, 120),
      customer_id: str(t.customer_id), assigned_to_me: t.assigned_agent === ctx.userId, opened: istDateTime(t.created_at), sla_due: istDateTime(t.sla_due_at), channel: str(t.channel),
      open_in_app: "/support",
    })), p, r.count));
  },
});

// ── Search ────────────────────────────────────────────────────────────────────────────

export const search = defineTool({
  name: "search",
  title: "Search",
  description: "Search leads, customers, quotes, invoices and support tickets by name / company / number / email at once (top 5 of each you are allowed to see). Use the get_* tools for details.",
  kind: "read",
  page: "/dashboard",
  input: z.object({ query: z.string().trim().min(2).max(80) }).strict(),
  async run(ctx, i) {
    const out: Record<string, unknown> = {};
    const jobs: PromiseLike<void>[] = [];
    if (sees(ctx, "/leads")) jobs.push(ctx.db.select("leads", ["id", "company", "stage"]).eq("is_junk", false).search(["company", "contact_name", "contact_email", "contact_phone"], i.query).page(0, 5)
      .then((r) => { out.leads = r.error ? "unavailable" : (r.data ?? []).map((x) => ({ id: x.id, company: text(x.company, 100), stage: x.stage })); }));
    if (sees(ctx, "/customers")) jobs.push(ctx.db.select("customers", ["id", "name", "customer_number"]).search(["name", "display_name", "customer_number", "contact_email", "gstin"], i.query).page(0, 5)
      .then((r) => { out.customers = r.error ? "unavailable" : (r.data ?? []).map((x) => ({ id: x.id, name: text(x.name, 100), number: str(x.customer_number) })); }));
    if (sees(ctx, "/quotes")) jobs.push(ctx.db.select("quotes", ["id", "customer_name", "status", "amount"]).search(["id", "customer_name", "plan"], i.query).page(0, 5)
      .then((r) => { out.quotes = r.error ? "unavailable" : (r.data ?? []).map((x) => ({ id: x.id, customer: text(x.customer_name, 100), status: x.status, total: inr(x.amount) })); }));
    if (sees(ctx, "/invoices")) jobs.push(ctx.db.select("invoices", ["id", "customer_name", "status", "amount", "invoice_date"]).search(["id", "customer_name"], i.query).page(0, 5)
      .then((r) => { out.invoices = r.error ? "unavailable" : (r.data ?? []).map((x) => ({ id: x.id, customer: text(x.customer_name, 100), status: x.status, total: inr(x.amount), date: istDate(x.invoice_date) })); }));
    if (sees(ctx, "/support")) jobs.push(ctx.db.select("support_tickets", ["id", "subject", "status", "customer_name"]).search(["subject", "customer_name"], i.query).page(0, 5)
      .then((r) => { out.support_tickets = r.error ? "unavailable" : (r.data ?? []).map((x) => ({ id: x.id, subject: text(x.subject, 120), status: x.status, customer: text(x.customer_name, 100) })); }));
    await Promise.all(jobs);
    return ok(out);
  },
});

export const OPS_READ_TOOLS = [
  getTodayQueue, getDashboardSummary, listUnmatchedBankEntries, getPnlSummary, listStaff, getAttendanceSummary,
  getSalarySummary, listSupportTickets, search,
];
