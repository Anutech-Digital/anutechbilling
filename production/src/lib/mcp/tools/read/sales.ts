/**
 * Read tools — Sales & CRM: leads, enquiries (the email inbox), deals, tasks.
 * RLS already narrows what each role sees (a sales rep: own leads and tasks); these tools add
 * paging, compact rows and masked contacts for roles without can_view_contact_details.
 */
import { z } from "zod";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { OPEN_DEAL_STAGES } from "@/lib/deals/pipeline-summary";
import { lossReasonLabel } from "@/lib/leads/loss-reasons";
import type { McpContext } from "@/lib/mcp/context";
import { contact, fromExGst, istDate, istDateTime, pageOf, paging, str, text } from "@/lib/mcp/format";
import { dbFail, defineTool, fail, ok } from "@/lib/mcp/tools/types";

const PAGE = { limit: z.number().int().min(1).max(50).optional().describe("Rows per page (default 20, max 50)"), offset: z.number().int().min(0).optional().describe("Rows to skip — use next_offset from the previous page") };
const ID = z.string().trim().min(1).max(80);

export const LEAD_STAGES = ["new", "contact", "demo", "trial", "quote", "won", "lost"] as const;

const LEAD_COLS = [
  "id", "company", "contact_name", "contact_email", "contact_phone", "stage", "source", "value", "seats", "plan",
  "owner_id", "follow_up_date", "expected_close_date", "created_at",
] as const;

type LeadRow = Record<(typeof LEAD_COLS)[number], unknown>;

function leadOut(ctx: McpContext, r: LeadRow) {
  return {
    id: r.id,
    company: text(r.company, 120),
    contact: text(r.contact_name, 80),
    phone: contact(ctx.role, r.contact_phone),
    email: contact(ctx.role, r.contact_email),
    stage: r.stage,
    source: str(r.source),
    plan: str(r.plan),
    seats: r.seats ?? null,
    value: r.value == null ? null : fromExGst(r.value),
    follow_up: istDate(r.follow_up_date),
    expected_close: istDate(r.expected_close_date),
    mine: r.owner_id === ctx.userId,
    created: istDate(r.created_at),
    open_in_app: `/leads?lead=${encodeURIComponent(String(r.id))}`,
  };
}

export const listLeads = defineTool({
  name: "list_leads",
  title: "List leads",
  description: "Leads (sales enquiries being worked), newest first. Filter by stage, by text (company / contact / email / phone), only mine, or only those whose follow-up is due today or earlier. Junk leads are hidden. Values are ex-GST with 18% GST shown separately.",
  kind: "read",
  page: "/leads",
  input: z.object({
    stage: z.enum(LEAD_STAGES).optional(),
    search: z.string().max(80).optional(),
    mine_only: z.boolean().optional(),
    follow_up_due: z.boolean().optional().describe("Only leads whose follow-up date is today or earlier (IST)"),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select<LeadRow>("leads", LEAD_COLS, { count: true }).eq("is_junk", false);
    if (i.stage) q = q.eq("stage", i.stage);
    if (i.mine_only) q = q.eq("owner_id", ctx.userId);
    if (i.follow_up_due) q = q.lte("follow_up_date", istToday(ctx.now)).not_null("follow_up_date");
    if (i.search) q = q.search(["company", "contact_name", "contact_email", "contact_phone"], i.search);
    const r = await q.order(i.follow_up_due ? "follow_up_date" : "created_at", { ascending: !!i.follow_up_due }).page(p.offset, p.limit);
    if (r.error) return dbFail("leads", r.error);
    return ok(pageOf((r.data ?? []).map((x) => leadOut(ctx, x)), p, r.count));
  },
});

export const getLead = defineTool({
  name: "get_lead",
  title: "Get one lead",
  description: "One lead with its latest 10 activities (calls, notes, emails) and its open tasks.",
  kind: "read",
  page: "/leads",
  input: z.object({ id: ID.describe("Lead id from list_leads") }).strict(),
  async run(ctx, i) {
    const cols = [...LEAD_COLS, "requirement", "notes", "lost_reason", "lost_note", "pipeline", "domain", "customer_id", "billing_cycle"] as const;
    const r = await ctx.db.select<Record<(typeof cols)[number], unknown>>("leads", cols).eq("id", i.id);
    if (r.error) return dbFail("the lead", r.error);
    const lead = r.data?.[0];
    if (!lead) return fail("not_found", `No lead ${i.id} that you can see. Check the id with list_leads.`);
    const [acts, tasks] = await Promise.all([
      ctx.db.select("lead_activities", ["id", "kind", "detail", "created_at"]).eq("lead_id", i.id).order("created_at", { ascending: false }).page(0, 10),
      ctx.db.select("tasks", ["id", "title", "kind", "due_at", "status"]).eq("lead_id", i.id).eq("status", "pending").order("due_at").page(0, 10),
    ]);
    return ok({
      ...leadOut(ctx, lead),
      requirement: text(lead.requirement, 500),
      notes: text(lead.notes, 500),
      lost_reason: lead.stage === "lost" ? lossReasonLabel(str(lead.lost_reason)) : null,
      lost_note: text(lead.lost_note, 300),
      pipeline: lead.pipeline,
      domain: str(lead.domain),
      customer_id: str(lead.customer_id),
      activities: acts.error ? `unavailable: ${acts.error.message}` : (acts.data ?? []).map((a) => ({ kind: a.kind, detail: text(a.detail, 300), at: istDateTime(a.created_at) })),
      open_tasks: tasks.error ? `unavailable: ${tasks.error.message}` : (tasks.data ?? []).map((t) => ({ id: t.id, title: text(t.title, 120), kind: t.kind, due: istDateTime(t.due_at) })),
    });
  },
});

export const listEnquiries = defineTool({
  name: "list_enquiries",
  title: "List enquiries (inbox)",
  description: "Emails that arrived in the Enquiries inbox, newest first — sender, subject, when, and the lead/ticket it was turned into. Archived ones are hidden unless asked.",
  kind: "read",
  page: "/enquiries",
  input: z.object({
    unread_only: z.boolean().optional(),
    include_archived: z.boolean().optional(),
    search: z.string().max(80).optional(),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    let q = ctx.db.select("inbound_emails", ["id", "from_name", "from_email", "subject", "status", "route", "created_at", "read_at", "lead_id", "ticket_id"], { count: true });
    if (!i.include_archived) q = q.is("archived_at", null);
    if (i.unread_only) q = q.is("read_at", null);
    if (i.search) q = q.search(["from_name", "from_email", "subject"], i.search);
    const r = await q.order("created_at", { ascending: false }).page(p.offset, p.limit);
    if (r.error) return dbFail("enquiries", r.error);
    return ok(pageOf((r.data ?? []).map((e) => ({
      id: e.id,
      from: text(e.from_name, 80),
      email: contact(ctx.role, e.from_email),
      subject: text(e.subject, 160),
      status: e.status,
      route: e.route,
      received: istDateTime(e.created_at),
      unread: e.read_at == null,
      lead_id: str(e.lead_id),
      ticket_id: str(e.ticket_id),
      open_in_app: "/enquiries",
    })), p, r.count));
  },
});

export const listDeals = defineTool({
  name: "list_deals",
  title: "List deals",
  description: "Deals = leads at demo / trial / quote (open), or won / lost. Open deals are sorted by expected close date. Values are ex-GST with GST shown separately.",
  kind: "read",
  page: "/deals",
  input: z.object({
    status: z.enum(["open", "won", "lost"]).optional().describe("Default open"),
    closing_within_days: z.number().int().min(0).max(365).optional().describe("Only open deals expected to close within N days (IST)"),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    const status = i.status ?? "open";
    let q = ctx.db.select<LeadRow>("leads", LEAD_COLS, { count: true }).eq("is_junk", false);
    q = status === "open" ? q.in("stage", OPEN_DEAL_STAGES) : q.eq("stage", status);
    if (status === "open" && i.closing_within_days !== undefined) {
      q = q.lte("expected_close_date", addDaysISO(istToday(ctx.now), i.closing_within_days)).not_null("expected_close_date");
    }
    const r = await q.order(status === "open" ? "expected_close_date" : "created_at", { ascending: status === "open" }).page(p.offset, p.limit);
    if (r.error) return dbFail("deals", r.error);
    return ok(pageOf((r.data ?? []).map((x) => ({ ...leadOut(ctx, x), open_in_app: `/deals?lead=${encodeURIComponent(String(x.id))}` })), p, r.count));
  },
});

export const listTasks = defineTool({
  name: "list_tasks",
  title: "List tasks",
  description: "Tasks and follow-ups. Default: my pending tasks, earliest due first. `due`: overdue | today | week | any (IST).",
  kind: "read",
  page: "/tasks",
  input: z.object({
    status: z.enum(["pending", "done", "snoozed", "cancelled"]).optional(),
    due: z.enum(["overdue", "today", "week", "any"]).optional(),
    everyone: z.boolean().optional().describe("Include tasks of other people you can see (default: only mine)"),
    lead_id: z.string().max(80).optional(),
    ...PAGE,
  }).strict(),
  async run(ctx, i) {
    const p = paging(i.limit, i.offset);
    const today = istToday(ctx.now);
    const startOfToday = new Date(`${today}T00:00:00+05:30`).toISOString();
    const endOf = (d: string) => new Date(`${addDaysISO(d, 1)}T00:00:00+05:30`).toISOString();
    let q = ctx.db.select("tasks", ["id", "title", "kind", "status", "priority", "due_at", "owner_id", "lead_id", "customer_id", "notes"], { count: true })
      .eq("status", i.status ?? "pending");
    if (!i.everyone) q = q.eq("owner_id", ctx.userId);
    if (i.lead_id) q = q.eq("lead_id", i.lead_id);
    if (i.due === "overdue") q = q.lt("due_at", startOfToday);
    if (i.due === "today") q = q.gte("due_at", startOfToday).lt("due_at", endOf(today));
    if (i.due === "week") q = q.lt("due_at", endOf(addDaysISO(today, 6)));
    const r = await q.order("due_at").page(p.offset, p.limit);
    if (r.error) return dbFail("tasks", r.error);
    return ok(pageOf((r.data ?? []).map((t) => ({
      id: t.id,
      title: text(t.title, 160),
      kind: t.kind,
      status: t.status,
      priority: t.priority,
      due: istDateTime(t.due_at),
      overdue: typeof t.due_at === "string" && t.due_at < startOfToday && t.status === "pending",
      mine: t.owner_id === ctx.userId,
      lead_id: str(t.lead_id),
      customer_id: str(t.customer_id),
      notes: text(t.notes, 200),
    })), p, r.count));
  },
});

export const SALES_READ_TOOLS = [listLeads, getLead, listEnquiries, listDeals, listTasks];
