/**
 * The 6 R-421 live-number tools, on the R-2774 registry contract (behaviour unchanged: same
 * reads, same helpers as the pages, same text). They read only through ctx.db — the tenant-scoped,
 * secret-free reader — and each result names its page (and row ids where it lists rows).
 */
import { z } from "zod";
import type { UserRole } from "@/lib/auth/roles";
import { drillHref } from "@/lib/navigation/drilldown";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { istToday } from "@/lib/dates/ist";
import { subscriptionSummary } from "@/lib/company/summary";
import { folderOf, daysToRenewal } from "@/lib/subscriptions/folders";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { rupee, num, formatDate } from "@/lib/utils";
import { defineHelpTool, type HelpSourceRef } from "./types";

/**
 * Who may run these through the registry. The legacy R-421 path keeps its own rule (any role
 * that can open the page — help-data-tools.ts); the registry path is owner-only for now
 * (G-HELPAI owner decision: owner first behind HELP_AI_V2, other roles card by card).
 */
const OWNER = ["owner"] as const satisfies readonly UserRole[];
const NO_INPUT = z.object({}).strict();

/** Lead stages (lead_stage enum). */
const LEAD_STAGES = ["new", "contact", "demo", "trial", "quote", "won", "lost"] as const;
/** Quote statuses that still wait on the customer (quote_status enum). */
const OPEN_QUOTE_STATUSES = ["draft", "sent", "viewed"] as const;

const P_ACTIVE = { page: drillHref("subsActive"), label: "Open active subscriptions" } as const;
const P_RENEW = { page: drillHref("subsExpiring"), label: "Open renewals due" } as const;
const P_OVERDUE = { page: drillHref("invoicesOverdue"), label: "Open overdue invoices" } as const;
const P_TODAY = { page: drillHref("leadsToday"), label: "Open today's follow-ups" } as const;
const P_QUOTES = { page: "/quotes", label: "Open Quotes" } as const;
const P_LEADS = { page: drillHref("leadsActive"), label: "Open Sales & Pipeline" } as const;

function plural(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

const src = (table: string, p: { page: string; label: string }, ids: string[] = []): HelpSourceRef => ({ table, ids, href: p.page, label: p.label });
const idsOf = (rows: readonly { id?: unknown }[]) => rows.map((r) => (r.id == null ? "" : String(r.id))).filter(Boolean);

export const activeSubscriptions = defineHelpTool({
  name: "active_subscriptions",
  describe: "active subscriptions right now: count and MRR (monthly recurring revenue, ₹)",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_ACTIVE,
  async run(_input, { db, now }) {
    type R = { status: string | null; renewal_date: string | null; mrr: number | null; plan: string | null; term_months: number | null };
    const rows = await fetchAllRows<R>((from, to) =>
      db.read<R>("subscriptions", "status, renewal_date, mrr, plan, term_months")
        .order("id", { ascending: true }).range(from, to));
    const s = subscriptionSummary(rows, now);
    return { text: `Active subscriptions: ${num(s.activeCount)}. MRR: ${rupee(s.mrr)} a month.`, sources: [src("subscriptions", P_ACTIVE)] };
  },
});

export const renewalsDue = defineHelpTool({
  name: "renewals_due",
  describe: "renewals due in the next 30 days (incl. ones already past their date and not renewed): count and the next 5",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_RENEW,
  async run(_input, { db, now }) {
    const today = istToday(now);
    type R = { id: string; customer_name: string | null; plan: string | null; status: string | null; renewal_date: string | null };
    const rows = await fetchAllRows<R>((from, to) =>
      db.read<R>("subscriptions", "id, customer_name, plan, status, renewal_date")
        .order("renewal_date", { ascending: true }).order("id", { ascending: true }).range(from, to));
    const due = rows.filter((r) => folderOf(r, today) === "expiring");
    const lapsed = due.filter((r) => (daysToRenewal(r.renewal_date, today) ?? 0) < 0).length;
    const lines = [`Renewals due in the next 30 days: ${num(due.length)}${lapsed ? ` (${num(lapsed)} already past the renewal date)` : ""}.`];
    const top = due.slice(0, 5);
    for (const r of top) {
      const d = daysToRenewal(r.renewal_date, today) ?? 0;
      const when = d < 0 ? `${-d} days late` : d === 0 ? "today" : `in ${d} days`;
      lines.push(`- ${r.customer_name || "Unnamed customer"} — ${r.plan || "plan not set"} — ${formatDate(r.renewal_date)} (${when})`);
    }
    return { text: lines.join("\n"), sources: [src("subscriptions", P_RENEW, idsOf(top))] };
  },
});

export const overdueInvoices = defineHelpTool({
  name: "overdue_invoices",
  describe: "overdue invoices: count and total still owed (₹)",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_OVERDUE,
  async run(_input, { db, now }) {
    const today = istToday(now);
    type R = { status: string; due_date: string | null; amount: number; net_payable: number | null; paid_amount: number | null };
    const rows = await fetchAllRows<R>((from, to) =>
      db.read<R>("invoices", "status, due_date, amount, net_payable, paid_amount")
        .in("status", ["pending", "overdue"]).is("written_off_at", null).order("id", { ascending: true }).range(from, to));
    const overdue = rows.filter((r) => invoiceIsOverdue(r, today));
    const owed = overdue.reduce((s, r) => s + invoiceBalance(r), 0);
    return { text: `Overdue invoices: ${num(overdue.length)}. Still owed on them: ${rupee(owed)}.`, sources: [src("invoices", P_OVERDUE)] };
  },
});

export const todaysFollowups = defineHelpTool({
  name: "todays_followups",
  describe: "lead follow-ups due today (and how many are already overdue), with the first 5 company names",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_TODAY,
  async run(_input, { db, now }) {
    const today = istToday(now);
    const open = () => db.read("leads", "id", { count: "exact", head: true })
      .eq("is_junk", false).not("stage", "in", "(won,lost)");
    const [due, late, top] = await Promise.all([
      open().eq("follow_up_date", today),
      open().lt("follow_up_date", today),
      db.read<{ id: string; company: string | null }>("leads", "id, company").eq("is_junk", false)
        .not("stage", "in", "(won,lost)").eq("follow_up_date", today)
        .order("value", { ascending: false, nullsFirst: false }).limit(5),
    ]);
    for (const r of [due, late, top]) if (r.error) throw r.error;
    const lines = [`Follow-ups due today: ${num(due.count ?? 0)}. Already overdue (earlier dates): ${num(late.count ?? 0)}.`];
    const leads = top.data ?? [];
    for (const l of leads) lines.push(`- ${l.company || "Unnamed lead"}`);
    return { text: lines.join("\n"), sources: [src("leads", P_TODAY, idsOf(leads))] };
  },
});

export const openQuotes = defineHelpTool({
  name: "open_quotes",
  describe: "open quotes (draft, sent or viewed, not yet invoiced): count and total value (₹)",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_QUOTES,
  async run(_input, { db }) {
    type R = { status: string; amount: number | null };
    const rows = await fetchAllRows<R>((from, to) =>
      db.read<R>("quotes", "status, amount")
        .in("status", [...OPEN_QUOTE_STATUSES]).is("invoice_id", null)
        .order("id", { ascending: true }).range(from, to));
    const value = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
    const byStatus = OPEN_QUOTE_STATUSES.map((st) => `${st} ${num(rows.filter((r) => r.status === st).length)}`).join(", ");
    return { text: `Open quotes: ${num(rows.length)} (${byStatus}). Total value: ${rupee(value)}.`, sources: [src("quotes", P_QUOTES)] };
  },
});

export const leadsByStage = defineHelpTool({
  name: "leads_by_stage",
  describe: "leads by pipeline stage (new, contact, demo, trial, quote, won, lost), junk left out",
  input: NO_INPUT,
  roles: OWNER,
  tier: "read",
  ...P_LEADS,
  async run(_input, { db }) {
    const counts = await Promise.all(LEAD_STAGES.map(async (stage) => {
      const r = await db.read("leads", "id", { count: "exact", head: true }).eq("is_junk", false).eq("stage", stage);
      if (r.error) throw r.error;
      return [stage, r.count ?? 0] as const;
    }));
    const open = counts.filter(([s]) => s !== "won" && s !== "lost").reduce((n, [, k]) => n + k, 0);
    return { text: `Open leads: ${plural(open, "lead", "leads")}. By stage: ${counts.map(([s, k]) => `${s} ${num(k)}`).join(", ")}.`, sources: [src("leads", P_LEADS)] };
  },
});

/** The R-421 six, in their original order. */
export const DATA_TOOLS = [activeSubscriptions, renewalsDue, overdueInvoices, todaysFollowups, openQuotes, leadsByStage] as const;
