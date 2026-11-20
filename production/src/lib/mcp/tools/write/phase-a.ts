/**
 * Phase A write tools — Sales & CRM, tasks and support notes only (outside Billing &
 * Subscriptions). Each one writes exactly what the app's own screen writes, through the same
 * table or RPC, as the signed-in person (RLS + triggers apply unchanged).
 *
 * Never built (docs/MCP.md): deletes, sending email / WhatsApp, refunds, GST settings, roles or
 * passwords, finalized invoices, vault, telecalling — and nothing in the billing section.
 */
import { z } from "zod";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { LOSS_REASONS, lossReasonLabel } from "@/lib/leads/loss-reasons";
import type { McpContext } from "@/lib/mcp/context";
import type { McpJson } from "@/lib/mcp/db";
import { istDateTime, text } from "@/lib/mcp/format";
import { fail } from "@/lib/mcp/tools/types";
import { randomToken } from "@/lib/mcp/crypto";
import { defineWriteTool } from "./two-step";

const LEAD_ID = z.string().trim().min(1).max(80);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM (24h, IST)");
const PHONE = z.string().trim().max(20).regex(/^[+0-9 ()-]{6,20}$/, "digits, spaces, + - ( ) only");

/** "2026-11-21" + "10:30" IST → ISO instant. */
export function istInstant(date: string, time = "10:00"): string {
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}

/** Same shape as the Add lead form's id ("L-" + base36 time), plus 3 random chars against a same-ms clash. */
function newLeadId(now: Date): string {
  return `L-${now.getTime().toString(36).toUpperCase()}${randomToken(3).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase()}`;
}

async function readLead(ctx: McpContext, id: string) {
  const r = await ctx.db.select<{ id: string; company: string; stage: string; follow_up_date: string | null; lost_reason: string | null; owner_id: string | null }>(
    "leads", ["id", "company", "stage", "follow_up_date", "lost_reason", "owner_id"]).eq("id", id);
  if (r.error) return fail("error", `Could not read the lead: ${r.error.message}`);
  return r.data?.[0] ?? fail("not_found", `No lead ${id} that you can see. Check the id with list_leads.`);
}

// ── add_lead ──────────────────────────────────────────────────────────────────────────

export const addLead = defineWriteTool({
  name: "add_lead",
  title: "Add a lead",
  description: "Create a new lead (stage New, owned by you, source Manual). The preview lists possible duplicates already in the system.",
  page: "/leads",
  fields: {
    company: z.string().trim().min(2).max(120),
    contact_name: z.string().trim().max(80).optional(),
    contact_phone: PHONE.optional(),
    contact_email: z.string().trim().email().max(120).optional(),
    requirement: z.string().trim().max(500).optional().describe("What they asked for, e.g. '20 users Google Workspace Business Starter'"),
    seats: z.number().int().min(1).max(100000).optional(),
    follow_up_date: DATE.optional(),
  },
  async prepare(ctx, i) {
    const dup = await ctx.db.rpc<{ id: string; company: string; stage: string; matched_on: string[] }[]>("find_lead_duplicates", {
      p_company: i.company, p_email: i.contact_email ?? "", p_phone: i.contact_phone ?? "",
    });
    const dups = Array.isArray(dup.data) ? dup.data.slice(0, 5).map((d) => ({ id: d.id, company: text(d.company, 100), stage: d.stage, matched_on: d.matched_on })) : [];
    return {
      before: null,
      summary: `Add lead "${i.company}"${i.contact_name ? ` (${i.contact_name})` : ""}, stage New, owner: you.${dups.length ? ` ⚠️ ${dups.length} possible duplicate(s): ${dups.map((d) => `${d.company} [${d.id}]`).join(", ")}.` : ""}`,
    };
  },
  async apply(ctx, i) {
    const id = newLeadId(ctx.now);
    const row: Record<string, McpJson> = {
      id, company: i.company, stage: "new", source: "manual", owner_id: ctx.userId, created_by: ctx.userId,
      contact_name: i.contact_name ?? null, contact_phone: i.contact_phone ?? null, contact_email: i.contact_email ?? null,
      requirement: i.requirement ?? null, seats: i.seats ?? null, follow_up_date: i.follow_up_date ?? null,
    };
    const r = await ctx.db.insert<{ id: string; company: string; stage: string }>("leads", row, ["id", "company", "stage"]);
    if (r.error || !r.data) return fail("error", `The lead was not saved: ${r.error?.message ?? "no row returned"}.`);
    return { after: { id: r.data.id, company: r.data.company, stage: r.data.stage, open_in_app: `/leads?lead=${encodeURIComponent(r.data.id)}` }, summary: `Lead ${r.data.id} "${r.data.company}" added.` };
  },
});

// ── update_lead_status ────────────────────────────────────────────────────────────────

const SETTABLE_STAGES = ["new", "contact", "demo", "trial", "quote", "lost"] as const;

export const updateLeadStatus = defineWriteTool({
  name: "update_lead_status",
  title: "Move a lead to another stage",
  description: "Change a lead's stage: new, contact, demo, trial, quote or lost (lost needs a reason). 'Won' is not available here — a lead is won when its quote is accepted in ResellerOS.",
  page: "/leads",
  fields: {
    id: LEAD_ID,
    stage: z.enum(SETTABLE_STAGES),
    lost_reason: z.enum(LOSS_REASONS.map((r) => r.code) as [string, ...string[]]).optional().describe("Required when stage=lost: price, competitor, no_response, timing, not_qualified, other"),
    lost_note: z.string().trim().max(300).optional(),
  },
  async prepare(ctx, i) {
    const lead = await readLead(ctx, i.id);
    if ("ok" in lead) return lead;
    if (lead.stage === "won") return fail("invalid", `${lead.company} is already won — its stage is changed from the quote / customer in ResellerOS, not here.`);
    if (lead.stage === i.stage) return fail("invalid", `${lead.company} is already at stage ${i.stage}.`);
    if (i.stage === "lost" && !i.lost_reason) return fail("invalid", "Say why it was lost: lost_reason = price, competitor, no_response, timing, not_qualified or other.");
    return {
      before: { stage: lead.stage, lost_reason: lead.lost_reason },
      summary: `Move ${lead.company} [${lead.id}] from ${lead.stage} → ${i.stage}${i.stage === "lost" ? ` (reason: ${lossReasonLabel(i.lost_reason)})` : ""}.`,
    };
  },
  async apply(ctx, i, prep) {
    const patch: Record<string, McpJson> = { stage: i.stage };
    if (i.stage === "lost") { patch.lost_reason = i.lost_reason ?? null; patch.lost_note = i.lost_note ?? null; }
    const r = await ctx.db.updateById<{ id: string; stage: string }>("leads", i.id, patch, ["id", "stage"]);
    if (r.error || !r.data) return fail("error", `The stage was not changed: ${r.error?.message ?? "you cannot edit this lead"}.`);
    return { after: { stage: r.data.stage, lost_reason: i.stage === "lost" ? i.lost_reason ?? null : null }, summary: `Lead ${i.id} moved from ${(prep.before as { stage: string }).stage} to ${r.data.stage}.` };
  },
});

// ── add_lead_note ─────────────────────────────────────────────────────────────────────

export const addLeadNote = defineWriteTool({
  name: "add_lead_note",
  title: "Add a note to a lead",
  description: "Add a note to a lead's activity timeline (as you).",
  page: "/leads",
  fields: { id: LEAD_ID, note: z.string().trim().min(1).max(2000) },
  async prepare(ctx, i) {
    const lead = await readLead(ctx, i.id);
    if ("ok" in lead) return lead;
    return { before: null, summary: `Add note to ${lead.company} [${lead.id}]: "${text(i.note, 200)}"` };
  },
  async apply(ctx, i) {
    const r = await ctx.db.rpc("log_lead_activity", { p_lead_id: i.id, p_kind: "note", p_detail: i.note });
    if (r.error) return fail("error", `The note was not saved: ${r.error.message}.`);
    return { after: { lead_id: i.id, note: text(i.note, 300) }, summary: `Note added to lead ${i.id}.` };
  },
});

// ── tasks ─────────────────────────────────────────────────────────────────────────────

export const createTask = defineWriteTool({
  name: "create_task",
  title: "Create a task",
  description: "Create a task for yourself, due on a date (and optional time, IST), optionally linked to a lead or customer.",
  page: "/tasks",
  fields: {
    title: z.string().trim().min(2).max(160),
    due_date: DATE,
    due_time: TIME.optional().describe("Default 10:00 IST"),
    kind: z.enum(["call", "email", "meeting", "followup", "custom"]).optional(),
    lead_id: LEAD_ID.optional(),
    customer_id: z.string().uuid().optional(),
    notes: z.string().trim().max(1000).optional(),
  },
  async prepare(ctx, i) {
    if (i.due_date < addDaysISO(istToday(ctx.now), -1)) return fail("invalid", "The due date is in the past. Pick today or later.");
    if (i.lead_id) { const l = await readLead(ctx, i.lead_id); if ("ok" in l) return l; }
    return { before: null, summary: `Create task "${i.title}" for you, due ${istDateTime(istInstant(i.due_date, i.due_time))}${i.lead_id ? `, on lead ${i.lead_id}` : ""}.` };
  },
  async apply(ctx, i) {
    const r = await ctx.db.insert<{ id: string; title: string; due_at: string }>("tasks", {
      title: i.title, due_at: istInstant(i.due_date, i.due_time), kind: i.kind ?? "custom", owner_id: ctx.userId,
      lead_id: i.lead_id ?? null, customer_id: i.customer_id ?? null, notes: i.notes ?? null, status: "pending",
    }, ["id", "title", "due_at"]);
    if (r.error || !r.data) return fail("error", `The task was not saved: ${r.error?.message ?? "no row returned"}.`);
    return { after: { id: r.data.id, title: r.data.title, due: istDateTime(r.data.due_at) }, summary: `Task "${r.data.title}" created.` };
  },
});

export const completeTask = defineWriteTool({
  name: "complete_task",
  title: "Mark a task done",
  description: "Mark a pending task as done.",
  page: "/tasks",
  fields: { id: z.string().uuid() },
  async prepare(ctx, i) {
    const r = await ctx.db.select<{ id: string; title: string; status: string }>("tasks", ["id", "title", "status"]).eq("id", i.id);
    if (r.error) return fail("error", `Could not read the task: ${r.error.message}`);
    const t = r.data?.[0];
    if (!t) return fail("not_found", `No task ${i.id} that you can see.`);
    if (t.status !== "pending" && t.status !== "snoozed") return fail("invalid", `"${t.title}" is already ${t.status}.`);
    return { before: { status: t.status }, summary: `Mark task "${text(t.title, 120)}" as done.` };
  },
  async apply(ctx, i) {
    const r = await ctx.db.updateById<{ id: string; status: string }>("tasks", i.id, { status: "done" }, ["id", "status"]);
    if (r.error || !r.data) return fail("error", `The task was not updated: ${r.error?.message ?? "you cannot edit this task"}.`);
    return { after: { status: r.data.status }, summary: "Task marked done." };
  },
});

export const setFollowupReminder = defineWriteTool({
  name: "set_followup_reminder",
  title: "Set a follow-up reminder on a lead",
  description: "Schedule a follow-up for a lead on a date (and optional time, IST): creates a follow-up task for you with a reminder, which also sets the lead's follow-up date.",
  page: "/leads",
  fields: {
    lead_id: LEAD_ID,
    date: DATE,
    time: TIME.optional().describe("Default 10:00 IST"),
    note: z.string().trim().max(300).optional(),
    remind_minutes_before: z.number().int().min(0).max(1440).optional().describe("Default 15"),
  },
  async prepare(ctx, i) {
    const lead = await readLead(ctx, i.lead_id);
    if ("ok" in lead) return lead;
    if (i.date < istToday(ctx.now)) return fail("invalid", "That date is in the past. Pick today or later.");
    return {
      before: { follow_up_date: lead.follow_up_date },
      summary: `Follow up ${lead.company} [${lead.id}] on ${istDateTime(istInstant(i.date, i.time))} (reminder ${i.remind_minutes_before ?? 15} min before). Current follow-up: ${lead.follow_up_date ?? "none"}.`,
    };
  },
  async apply(ctx, i) {
    const lead = await readLead(ctx, i.lead_id);
    if ("ok" in lead) return lead;
    const r = await ctx.db.insert<{ id: string; due_at: string }>("tasks", {
      title: `Follow up: ${lead.company}`.slice(0, 160), kind: "followup", due_at: istInstant(i.date, i.time), owner_id: ctx.userId,
      lead_id: i.lead_id, notes: i.note ?? null, status: "pending", reminder_minutes_before: i.remind_minutes_before ?? 15,
    }, ["id", "due_at"]);
    if (r.error || !r.data) return fail("error", `The follow-up was not saved: ${r.error?.message ?? "no row returned"}.`);
    return { after: { task_id: r.data.id, due: istDateTime(r.data.due_at), lead_id: i.lead_id }, summary: `Follow-up set for ${lead.company}.` };
  },
});

// ── support ───────────────────────────────────────────────────────────────────────────

export const addSupportTicketNote = defineWriteTool({
  name: "add_support_ticket_note",
  title: "Add an internal note to a support ticket",
  description: "Add an INTERNAL note to a support ticket (the customer does not see it; nothing is emailed).",
  page: "/support",
  action: "support.update",
  fields: { ticket_id: z.string().trim().min(1).max(80), note: z.string().trim().min(1).max(2000) },
  async prepare(ctx, i) {
    const r = await ctx.db.select<{ id: string; subject: string; status: string }>("support_tickets", ["id", "subject", "status"]).eq("id", i.ticket_id);
    if (r.error) return fail("error", `Could not read the ticket: ${r.error.message}`);
    const t = r.data?.[0];
    if (!t) return fail("not_found", `No ticket ${i.ticket_id} that you can see.`);
    return { before: null, summary: `Add internal note to ticket "${text(t.subject, 120)}": "${text(i.note, 200)}"` };
  },
  async apply(ctx, i) {
    const r = await ctx.db.insert<{ id: string }>("support_ticket_notes", {
      ticket_id: i.ticket_id, author_id: ctx.userId, author_name: ctx.fullName ?? ctx.email, body: i.note,
    }, ["id"]);
    if (r.error || !r.data) return fail("error", `The note was not saved: ${r.error?.message ?? "no row returned"}.`);
    return { after: { note_id: r.data.id, ticket_id: i.ticket_id }, summary: "Internal note added." };
  },
});

export const PHASE_A_WRITE_TOOLS = [addLead, updateLeadStatus, addLeadNote, createTask, completeTask, setFollowupReminder, addSupportTicketNote];
