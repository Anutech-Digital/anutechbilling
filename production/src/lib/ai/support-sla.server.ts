/**
 * Reading and writing the tickets the SLA sweep acts on. Decisions live in `support-sla.ts`.
 *
 * Bare client for the same measured reason as `support-agent.server.ts`: the nine columns
 * migration 20260824180000 adds to `support_tickets` are not in the generated `Database` type,
 * and registering a table took typecheck from 4 errors to 2,722 (measured 23 Aug 2026 on
 * `document_series`).
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every write below carries an
 * explicit `.eq("tenant_id", …)`. The two READS are cross-tenant BY DESIGN — a cron sweeps every
 * workspace — and each one says so at the query. That exception is the reason the writes are
 * separate functions taking an explicit `tenantId` rather than reusing a row object: it keeps
 * "this read is deliberately unscoped" from spreading into "this write forgot to scope".
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlaTicketFacts } from "./support-sla";

function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/** A ticket the sweep is considering, plus the fields it needs to report on it. */
export interface SweepTicket extends SlaTicketFacts {
  tenantId: string;
  customerName: string;
  raisedBy: string;
  subject: string;
  channel: string | null;
  priority: string;
}

interface TicketRow {
  id: string | null;
  tenant_id: string | null;
  customer_name: string | null;
  raised_by_email: string | null;
  subject: string | null;
  status: string | null;
  channel: string | null;
  priority: string | null;
  ai_escalated: boolean | null;
  ai_escalated_at: string | null;
  ai_awaiting_reply_since: string | null;
  assigned_agent: string | null;
  sla_alert_sent_at: string | null;
}

/* ONE STRING LITERAL, not a concatenation. supabase-js parses the select string at the TYPE
   level to infer the row shape; a value it cannot see as a literal degrades to
   GenericStringError[] and the cast to TicketRow[] then fails to compile. Splitting this over
   two lines with a `+` is what caused exactly that. */
const SELECT =
  "id, tenant_id, customer_name, raised_by_email, subject, status, channel, priority, ai_escalated, ai_escalated_at, ai_awaiting_reply_since, assigned_agent, sla_alert_sent_at";

function toSweepTicket(r: TicketRow): SweepTicket[] {
  if (!r.id || !r.tenant_id) return [];
  return [
    {
      ticketId: r.id,
      tenantId: r.tenant_id,
      customerName: r.customer_name ?? "(no name)",
      raisedBy: r.raised_by_email ?? "",
      subject: r.subject ?? "(no subject)",
      status: r.status ?? "open",
      channel: r.channel,
      priority: r.priority ?? "normal",
      escalated: r.ai_escalated === true,
      escalatedAt: r.ai_escalated_at ? new Date(r.ai_escalated_at) : null,
      awaitingReplySince: r.ai_awaiting_reply_since
        ? new Date(r.ai_awaiting_reply_since)
        : null,
      assignedAgent: r.assigned_agent,
      slaAlertSentAt: r.sla_alert_sent_at ? new Date(r.sla_alert_sent_at) : null,
      /* Filled by the caller from the transcript. Left null here rather than defaulted to a
         date, because "the customer has never written" and "we have not looked" must not be
         the same value — the first is a reason to close and the second is not. */
      lastCustomerMessageAt: null,
    },
  ];
}

/**
 * Tickets where the ball is with the customer, oldest first.
 *
 * CROSS-TENANT BY DESIGN — this is a cron sweeping every workspace. The `status` filter is here
 * rather than in `shouldAutoClose` because a closed ticket is not a candidate at all and
 * fetching thousands of them to reject each one would make the bound below meaningless.
 */
export async function loadTicketsAwaitingReply(limit: number): Promise<SweepTicket[]> {
  const db = bare();
  if (!db) return [];

  const { data, error } = await db
    .from("support_tickets")
    .select(SELECT)
    .not("ai_awaiting_reply_since", "is", null)
    .in("status", ["open", "in_progress", "awaiting_customer", "resolved"])
    .order("ai_awaiting_reply_since", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[support-sla] awaiting-reply read failed:", error.message);
    return [];
  }
  return ((data ?? []) as TicketRow[]).flatMap(toSweepTicket);
}

/**
 * Escalated tickets nobody has taken, oldest escalation first.
 *
 * CROSS-TENANT BY DESIGN, as above. `sla_alert_sent_at is null` is in the query rather than left
 * to the decision function so a workspace with a long backlog of already-alerted tickets cannot
 * push a newly escalated one past the row limit.
 */
export async function loadEscalatedUnassigned(limit: number): Promise<SweepTicket[]> {
  const db = bare();
  if (!db) return [];

  const { data, error } = await db
    .from("support_tickets")
    .select(SELECT)
    .eq("ai_escalated", true)
    .is("assigned_agent", null)
    .is("sla_alert_sent_at", null)
    /* An escalated ticket somebody closed or resolved without assigning it is HANDLED — see
       shouldAlertUnassigned. Filtered here too so a long history of them cannot push a newly
       escalated one past the row limit. */
    .in("status", ["open", "in_progress", "awaiting_customer"])
    .order("ai_escalated_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[support-sla] escalated-unassigned read failed:", error.message);
    return [];
  }
  return ((data ?? []) as TicketRow[]).flatMap(toSweepTicket);
}

/**
 * Close a ticket the customer never came back to, and say so on the row.
 *
 * `resolution_note` is APPENDED to rather than replaced: the agent's own note explains what was
 * answered, and overwriting it with "closed for silence" would delete the only record of what
 * the customer was told. Read-then-write for that reason; the REST API cannot concatenate.
 */
export async function closeTicketForSilence(args: {
  tenantId: string;
  ticketId: string;
  detail: string;
  now: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured" };

  const { data, error: readErr } = await db
    .from("support_tickets")
    .select("resolution_note")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.ticketId)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };

  const existing = (data as { resolution_note?: string | null } | null)?.resolution_note ?? "";
  const note = existing ? `${existing}\n\n${args.detail}` : args.detail;

  const { error } = await db
    .from("support_tickets")
    .update({
      status: "closed",
      resolution_note: note,
      /* Cleared, so a customer who writes back later starts a genuinely new conversation
         instead of the sweep finding this row again every hour for the rest of time. */
      ai_awaiting_reply_since: null,
      updated_at: args.now.toISOString(),
    })
    .eq("tenant_id", args.tenantId)
    .eq("id", args.ticketId)
    /* Idempotency, and it is the difference between one close and a close on every sweep: if
       two runs overlap, or a person closed it a second ago, this matches nothing and the caller
       reports "already closed" instead of writing over somebody's work. */
    .neq("status", "closed");

  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Stamp that the breach alert went, so it goes once. See `shouldAlertUnassigned`. */
export async function markSlaAlertSent(args: {
  tenantId: string;
  ticketId: string;
  at: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured" };

  const { error } = await db
    .from("support_tickets")
    .update({ sla_alert_sent_at: args.at.toISOString(), updated_at: args.at.toISOString() })
    .eq("tenant_id", args.tenantId)
    .eq("id", args.ticketId);

  return error ? { ok: false, error: error.message } : { ok: true };
}
