/**
 * One inbound support message, end to end: find its ticket, remember it, understand it, act.
 *
 * This is what the support webhooks call. It is the support-side twin of `run-sales-agent.ts`
 * and follows the same order for the same reasons.
 *
 * ─── ORDER OF OPERATIONS, AND WHY ───────────────────────────────────────────
 * 1. Find or open the ticket. Everything else hangs off a ticket id — the transcript's
 *    composite FK, the SLA clocks, the escalation flag — and a support request that is captured
 *    but unanswered is recoverable while one that was never recorded is not.
 * 2. Record the customer's turn. If anything below fails, their words are still in the
 *    transcript and the next reply has them as context.
 * 3. Clear the "waiting on the customer" clock. They wrote — so the 48-hour auto-close must not
 *    fire under their reply, and clearing it here means the row is corrected before the cron can
 *    ever see it.
 * 4. Read who they are and what they bought, run the agent, apply the hard rules.
 * 5. Dispatch: answer, ask, or escalate.
 *
 * ─── WHY A REPLY REOPENS A RESOLVED TICKET INSTEAD OF OPENING A NEW ONE ─────
 * The agent tells the customer, in the resolution note and implicitly by resolving, that
 * replying continues the conversation. If a reply opened a second ticket, the thread the rep
 * needs would be split across two rows with the history on the closed one — and the customer
 * would be answered by somebody reading half of it. So a reply inside the auto-close window
 * reopens. Outside it, a new problem gets a new ticket, which is what a fortnight-later "hello
 * again" actually is.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { newTicketId } from "@/lib/inbound/routing";
import { dispatchSupportDecision } from "./actions/support-dispatcher";
import { logAiAction } from "./autonomy.server";
import {
  loadSupportCustomerFacts,
  patchTicketAiFields,
  recordSupportTurn,
  runSupportAgent,
} from "./support-agent.server";
import { AUTO_CLOSE_AFTER_HOURS, type SupportChannel } from "./support-agent";

type Admin = ReturnType<typeof createAdminClient>;

/** Statuses where the ticket is still live and a new message belongs on it. */
const LIVE_STATUSES = ["open", "in_progress", "awaiting_customer"] as const;

export interface RunSupportAgentArgs {
  admin: Admin;
  tenantId: string;
  /** The customer's message, quoted thread already stripped by the caller. */
  incoming: string;
  /** Where the message came from, and where an answer would go. */
  customerContact: string;
  channel: SupportChannel;
  /** Mail subject, or "" on a channel that has none. */
  subject: string;
  /** Display name or WhatsApp profile name. May be empty. */
  senderName: string;
  /**
   * R-726: the channel proved the sender owns `customerContact` (Meta signature for WhatsApp;
   * DKIM/DMARC verdict for email, lib/inbound/sender-auth.ts). false → answered as a stranger.
   */
  senderVerified: boolean;
  /** An existing ticket to use, when the caller has already opened one. */
  ticketId?: string | null;
  /** Envelope sender for this deployment. */
  fromEmail: string;
  sellerName: string;
  supportEmail: string;
  appUrl: string;
}

export interface RunSupportAgentResult {
  ticketId: string | null;
  outcome: string;
  detail: string;
}

interface ExistingTicket {
  id: string;
  status: string;
  tier: "free" | "standard" | "enterprise" | null;
}

/**
 * A subject line for a channel that does not have one.
 *
 * The customer's own first line, truncated — not "WhatsApp support request". The Support screen
 * shows the subject as the ticket's title, and a column of identical titles is a list nobody can
 * scan; the first line of what somebody wrote is almost always what the ticket is about.
 */
function subjectFromMessage(message: string): string {
  const firstLine = message.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "(no subject)";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/**
 * The ticket this message belongs on, opening one if there is none.
 *
 * Matched on the CONTACT rather than on a mail thread id, deliberately: a customer replying from
 * their phone, forwarding to us, or writing again three hours later produces a different thread
 * id every time, and each one would be a fresh ticket. The address is the person.
 */
async function findOrOpenTicket(args: RunSupportAgentArgs): Promise<
  { ok: true; ticketId: string; tier: "free" | "standard" | "enterprise" | null; reopened: boolean }
  | { ok: false; error: string }
> {
  const { admin, tenantId, customerContact } = args;

  if (args.ticketId) {
    const { data } = await admin
      .from("support_tickets")
      .select("id, status, tier")
      .eq("tenant_id", tenantId)
      .eq("id", args.ticketId)
      .maybeSingle();
    const row = data as ExistingTicket | null;
    return { ok: true, ticketId: args.ticketId, tier: row?.tier ?? null, reopened: false };
  }

  const { data: live } = await admin
    .from("support_tickets")
    .select("id, status, tier")
    .eq("tenant_id", tenantId)
    .eq("raised_by_email", customerContact)
    .in("status", [...LIVE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const liveRow = live as ExistingTicket | null;
  if (liveRow?.id) return { ok: true, ticketId: liveRow.id, tier: liveRow.tier ?? null, reopened: false };

  /* A recently resolved ticket, reopened rather than duplicated — see the file header. The
     window is the same 48 hours the auto-close uses, so "resolved but still reopenable" and
     "closed for silence" are the same boundary rather than two numbers that can drift apart. */
  const cutoff = new Date(Date.now() - AUTO_CLOSE_AFTER_HOURS * 3_600_000).toISOString();
  const { data: recent } = await admin
    .from("support_tickets")
    .select("id, status, tier")
    .eq("tenant_id", tenantId)
    .eq("raised_by_email", customerContact)
    .eq("status", "resolved")
    .gte("resolved_at", cutoff)
    .order("resolved_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const recentRow = recent as ExistingTicket | null;
  if (recentRow?.id) {
    const patched = await patchTicketAiFields({
      tenantId,
      ticketId: recentRow.id,
      fields: {
        status: "open",
        /* Both cleared: the resolution no longer stands, and leaving `resolved_at` set would
           leave the ticket inside the reopen window forever, so every later message would
           reopen this same row instead of raising a new problem as a new ticket. */
        resolved_at: null,
        ai_awaiting_reply_since: null,
      },
    });
    if (!patched.ok) {
      console.error("[run-support-agent] could not reopen ticket:", patched.error);
      /* Fall through to opening a fresh ticket. A new ticket with the right content beats a
         reopened one whose status write failed and which therefore still reads as resolved. */
    } else {
      return { ok: true, ticketId: recentRow.id, tier: recentRow.tier ?? null, reopened: true };
    }
  }

  const ticketId = newTicketId();
  /* `customer_id` stays null — the sender may not be a known customer, and guessing one would
     attach a stranger's ticket to a real account. The Support screen shows raised_by_email, so
     nothing is lost by not guessing; `loadSupportCustomerFacts` does the matching for the PROMPT
     without writing it onto the row.

     `category` and `priority` are the untriaged defaults, exactly as the inbound-email webhook
     writes them. The agent sets both from its own read a moment later, so a value here would be
     a guess that survives for one second and confuses anybody reading the audit trail. */
  const { error } = await admin.from("support_tickets").insert({
    id: ticketId,
    tenant_id: tenantId,
    customer_id: null,
    customer_name: args.senderName || customerContact,
    raised_by_email: customerContact,
    raised_by_user: null,
    category: "other",
    priority: "normal",
    subject: args.subject.trim() || subjectFromMessage(args.incoming),
    body: args.incoming,
    status: "open",
  });

  if (error) return { ok: false, error: error.message };

  /* Read back the tier the INSERT trigger stamped. `stamp_support_ticket_sla` derives it from
     the customer's plan and also sets sla_due_at, so re-deriving it here would be a second
     source for a number the SLA is judged against — migration 20260817170100 says the row is
     the one place that matters. */
  const { data: fresh } = await admin
    .from("support_tickets")
    .select("tier")
    .eq("tenant_id", tenantId)
    .eq("id", ticketId)
    .maybeSingle();

  return {
    ok: true,
    ticketId,
    tier: (fresh as { tier?: "free" | "standard" | "enterprise" | null } | null)?.tier ?? null,
    reopened: false,
  };
}

/**
 * Never throws. Called from a webhook a provider is waiting on: the message is committed before
 * this runs, and losing a captured support request to protect an answer would be the wrong trade.
 */
export async function runSupportAgentForMessage(
  args: RunSupportAgentArgs,
): Promise<RunSupportAgentResult> {
  const { admin, tenantId } = args;

  const ticket = await findOrOpenTicket(args);
  if (!ticket.ok) {
    /* Loud, and it is the one failure here that loses something: with no ticket there is nowhere
       to put the transcript, the escalation flag or the answer. The caller returns a non-2xx so
       the provider retries. */
    console.error("[run-support-agent] could not open a ticket:", ticket.error);
    await logAiAction({
      tenantId,
      action: "support.reply.send",
      outcome: "failed",
      reason: `Could not open or find a support ticket: ${ticket.error}`,
      mode: "hold",
      entity: "support_ticket",
      entityId: null,
      facts: { channel: args.channel, contact: args.customerContact },
    });
    return { ticketId: null, outcome: "failed", detail: `Could not open a ticket — ${ticket.error}` };
  }

  const ticketId = ticket.ticketId;

  /* ── The customer's turn goes in first ── */
  await recordSupportTurn({
    tenantId,
    ticketId,
    channel: args.channel,
    customerContact: args.customerContact,
    role: "user",
    content: args.incoming,
  });

  /* ── They wrote, so nothing is waiting on them ──
     Also moves an `awaiting_customer` ticket back to `open`: the ball is ours again, and a
     ticket sitting in "awaiting customer" after the customer answered is how a request gets
     forgotten by everybody who filters that status out. */
  await patchTicketAiFields({
    tenantId,
    ticketId,
    fields: {
      ai_awaiting_reply_since: null,
      channel: args.channel,
      ...(ticket.reopened ? {} : { status: "open" }),
    },
  });

  /* ── Who is this, and what did they buy ── */
  const customer = await loadSupportCustomerFacts({
    admin,
    tenantId,
    channel: args.channel,
    customerContact: args.customerContact,
    fallbackName: args.senderName,
    senderVerified: args.senderVerified,
    ticketId,
    tier: ticket.tier,
  });

  /* ── Understand it ── */
  const run = await runSupportAgent({
    admin,
    tenantId,
    customer,
    incoming: args.incoming,
    sellerName: args.sellerName,
    supportEmail: args.supportEmail,
  });

  if (!run.ok) {
    /* The specific reason on the ticket. "The AI support agent has no Gemini key" is fixed on a
       settings page; "the agent failed" is fixed by asking an engineer.

       The ticket is deliberately left `open` and unescalated: nobody has answered the customer,
       which is exactly what `open` means, and flagging an escalation for a configuration fault
       would put "a person must look at this" on a queue for a reason no person can act on. */
    await recordSupportTurn({
      tenantId,
      ticketId,
      channel: args.channel,
      customerContact: args.customerContact,
      role: "system",
      content: `The AI support agent could not answer this message — ${run.reason}`,
      resolutionStatus: "none",
    });
    await logAiAction({
      tenantId,
      action: "support.reply.send",
      outcome: "failed",
      reason: run.reason,
      mode: "hold",
      entity: "support_ticket",
      entityId: ticketId,
      facts: { channel: args.channel },
    });
    return { ticketId, outcome: "failed", detail: run.reason };
  }

  /* ── Act ── */
  const dispatched = await dispatchSupportDecision({
    admin,
    tenantId,
    ticketId,
    customerContact: args.customerContact,
    customerName: customer.customerName,
    channel: args.channel,
    incomingSubject: args.subject,
    decision: run.decision,
    overruled: run.overruled,
    overruleReason: run.overruleReason,
    fromEmail: args.fromEmail,
    appUrl: args.appUrl,
  });

  return { ticketId, outcome: dispatched.outcome, detail: dispatched.detail };
}
