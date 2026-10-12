/**
 * Carry out what the support agent decided: answer and resolve, ask for more, or fetch a person.
 *
 * ─── THE DIAL COVERS WHATSAPP TOO, AND THAT NEEDED WRITING BY HAND ──────────
 * `sendEmail` is the chokepoint for mail: pass `automated` and it resolves the autonomy dial,
 * logs the outcome, and refuses if the kill switch is on (lib/email/send.ts). WhatsApp has no
 * such chokepoint — `sendWhatsApp` posts straight to Meta. An agent that respected the brake on
 * email and ignored it on WhatsApp would be a brake in name only, and the kill switch is the
 * control somebody reaches for when a wrong instruction has already gone out. So the WhatsApp
 * path resolves the dial and writes the log here, in the same shape send.ts uses and the same
 * shape `quote-dispatcher.ts` uses.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not decide anything. Whether this answer may be sent unattended was decided by
 * `applyEscalationRules` in support-agent.ts, and re-deciding here would mean two places that
 * could disagree about the same draft. This file writes the outcome to the ticket and moves the
 * message.
 *
 * It also does not invent a ticket. The caller opens the ticket before the agent runs, because a
 * support request that is captured but unanswered is recoverable and one that was never recorded
 * is not.
 *
 * ─── THE ESCALATION ALERT IS NOT GATED, AND THAT IS ON PURPOSE ──────────────
 * The customer-facing answer goes through the dial. The mail that says "this ticket needs
 * somebody" goes to OUR OWN desk and is ungated — see the comment beside `support.reply.send` in
 * lib/ai/autonomy.ts. A kill switch that also silenced the escalation alarm would turn one busy
 * morning into a customer discovering we never answered.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { sendCustomerEmail, sendCustomerWhatsApp, sendInternalEmail } from "@/lib/messaging";
import { replySubject } from "@/lib/email/reply-subject";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { resolveAutonomy } from "../autonomy";
import { loadAutonomyPolicy, logAiAction } from "../autonomy.server";
import {
  patchTicketAiFields,
  recordSupportTurn,
  stampFirstResponse,
} from "../support-agent.server";
import {
  categoryForTopic,
  priorityForSeverity,
  resolutionStatusFor,
  type SupportChannel,
  type SupportDecision,
} from "../support-agent";

/* Typed as the RETURN of createAdminClient — hand-rolling this shape is what produced the
   TS2589 "excessively deep" failure in lib/email/owner-alert.ts. */
type Admin = ReturnType<typeof createAdminClient>;

/** The one dial entry this file is gated on. A literal, so the chokepoint scan can see it. */
const SUPPORT_SEND = "support.reply.send" as const;

export interface SupportDispatchArgs {
  admin: Admin;
  tenantId: string;
  ticketId: string;
  /** Email address or E.164 phone number, matching `channel`. */
  customerContact: string;
  /**
   * The subject the CUSTOMER wrote, so the answer stays in their own thread.
   *
   * Same defect as the sales path had until 31 Aug 2026: the model named the conversation,
   * Gmail filed the reply separately, and the person waiting saw silence. Optional because
   * WhatsApp has no subject.
   */
  incomingSubject?: string | null;
  customerName: string;
  channel: SupportChannel;
  decision: SupportDecision;
  /** True when applyEscalationRules overruled the model — logged, not re-decided. */
  overruled: boolean;
  overruleReason: string;
  /** Envelope sender for this deployment. */
  fromEmail: string;
  /** Where the app lives, for the link in the escalation alert. */
  appUrl: string;
}

export interface SupportDispatchResult {
  /** What actually happened, for the caller's log line. */
  outcome: "resolved" | "asked_for_more" | "held" | "escalated" | "failed";
  /** One sentence a non-engineer can act on. */
  detail: string;
}

/* ── Escalation ──────────────────────────────────────────────────────────── */

/**
 * Flag the ticket, raise its priority, and tell somebody — in that order.
 *
 * The order matters. The flag is what the Support screen reads and what the SLA cron counts
 * from, so it is written first and its failure is loud: an escalation that silently failed to
 * flag would leave a customer waiting on a person who was never told, which is worse than an
 * unanswered ticket because the log would say it was handled.
 *
 * Nothing is sent to the customer. That is the point of an escalation: the draft may be
 * perfectly good, but a draft that goes out unread is not an escalation, it is a send with
 * extra steps.
 */
async function escalate(
  args: SupportDispatchArgs,
  reason: string,
): Promise<SupportDispatchResult> {
  const { tenantId, ticketId, decision } = args;
  const now = new Date().toISOString();

  const patched = await patchTicketAiFields({
    tenantId,
    ticketId,
    fields: {
      /* `open`, NOT a new "escalated_to_human" status. `status` is a closed vocabulary the
         Support screen renders one filter tab and one count per value from, so a sixth value
         would create tickets that appear in no tab and in no count — the ones needing a person
         most. The escalation is a fact on the row instead. See the migration header. */
      status: "open",
      priority: priorityForSeverity(decision.severity_level),
      category: categoryForTopic(decision.issue_category),
      channel: args.channel,
      ai_escalated: true,
      ai_escalation_reason: reason,
      ai_escalated_at: now,
      ai_answered_at: now,
      /* Cleared: nobody is waiting on the CUSTOMER now, we are the ones who owe an answer. If
         this were left set, the 48-hour sweep would eventually close an escalation nobody had
         picked up — the exact ticket that must never close itself. */
      ai_awaiting_reply_since: null,
    },
  });

  if (!patched.ok) {
    console.error("[support-dispatcher] could not flag the ticket for escalation:", patched.error);
    await logAiAction({
      tenantId,
      action: SUPPORT_SEND,
      outcome: "failed",
      reason: `Escalation needed but the ticket could not be flagged: ${patched.error}`,
      mode: "hold",
      entity: "support_ticket",
      entityId: ticketId,
    });
    return {
      outcome: "failed",
      detail: `Escalation flag failed — ${patched.error}. The reason was: ${reason}`,
    };
  }

  /* The draft is kept, unsent, on the transcript. A rep taking the ticket on sees what the
     agent was going to say — which is usually most of the answer and occasionally the reason
     it was stopped. */
  await recordSupportTurn({
    tenantId,
    ticketId,
    channel: args.channel,
    customerContact: args.customerContact,
    role: "system",
    content:
      `Escalated to a person — ${reason}\n\n` +
      `The agent had drafted (NOT sent):\nSubject: ${decision.generated_response.email_subject}\n\n` +
      decision.generated_response.body_text,
    intent: decision.issue_category,
    resolutionStatus: "escalated",
    confidence: decision.confidence_score,
  });

  await notifySupportDesk(args, reason);

  await logAiAction({
    tenantId,
    action: SUPPORT_SEND,
    outcome: "held",
    reason,
    mode: "hold",
    entity: "support_ticket",
    entityId: ticketId,
    facts: {
      channel: args.channel,
      issue: decision.issue_category,
      severity: decision.severity_level,
      confidence: decision.confidence_score,
      overruled: args.overruled,
    },
  });

  return { outcome: "escalated", detail: reason };
}

/**
 * Tell the support desk a ticket is waiting on them.
 *
 * Best-effort and never fatal: the flag on the ticket is the durable record, and failing the
 * whole escalation because a notification bounced would throw away the part that works. But it
 * IS logged loudly — an alert nobody received and nobody knows was not received is the
 * "half a monitoring setup" failure in AGENTS.md L40.
 */
async function notifySupportDesk(args: SupportDispatchArgs, reason: string): Promise<void> {
  const { admin, tenantId, ticketId, decision } = args;

  const { alert } = await loadOwnerAlert(admin, tenantId);
  if (!alert.ok) {
    console.error(`[support-dispatcher] escalation alert not sent — ${alert.reason}`);
    return;
  }

  const lines = [
    `A support ticket needs a person.`,
    "",
    `Ticket:    ${ticketId}`,
    `Customer:  ${args.customerName} <${args.customerContact}>`,
    `Channel:   ${args.channel}`,
    `Issue:     ${decision.issue_category}`,
    `Severity:  ${decision.severity_level}`,
    "",
    `Why the AI stopped: ${reason}`,
    "",
    "What the customer said, and what the agent had drafted, are both on the ticket:",
    `${args.appUrl}/support`,
    "",
    "Nothing has been sent to the customer.",
  ];

  const res = await sendInternalEmail({
    to: alert.to,
    from: args.fromEmail,
    subject: `[${decision.severity_level}] Support ticket ${ticketId} needs a person — ${args.customerName}`,
    text: lines.join("\n"),
    route: { tenantId },
    kind: "ai_support_escalation",
    /* NOT marked `automated`. This is mail to our own desk about our own queue; the dial and
       the kill switch exist to stop what goes OUT to other people. See the file header. */
  });

  if (res.status === "failed") {
    console.error(
      `[support-dispatcher] escalation alert for ${ticketId} failed to send — ${res.errorMessage ?? "no reason given"}`,
    );
  }
}

/* ── Answering ───────────────────────────────────────────────────────────── */

/**
 * The agent's TRIAGE — what kind of problem this is and how badly it hurts.
 *
 * ─── WHY THIS IS WRITTEN EVEN WHEN NOTHING IS SENT ──────────────────────────
 * Measured on a live probe, 24 Aug 2026: a DNS ticket the agent had correctly read as
 * `dns_records` sat on the Support screen as category `other`, priority `normal` — the
 * untriaged defaults — because the only place that wrote them was the successful-send path.
 *
 * Triage is not a send. The whole argument for `hold` (lib/ai/autonomy.ts) is that the work is
 * done and the operator's next action is one tap rather than a blank page; a held ticket that
 * is also mis-filed loses half of that. The Support screen filters by category and sorts by
 * priority, so an untriaged row is one a rep does not find.
 *
 * Status and the two clocks are deliberately NOT here — those are facts about a message
 * actually reaching the customer, and writing them on a held draft would say something untrue.
 */
function triageFields(
  args: SupportDispatchArgs,
): Parameters<typeof patchTicketAiFields>[0]["fields"] {
  return {
    priority: priorityForSeverity(args.decision.severity_level),
    category: categoryForTopic(args.decision.issue_category),
    channel: args.channel,
  };
}

/**
 * What the ticket becomes once the answer has actually gone out.
 *
 * `resolved` closes the loop and starts the 48-hour silence clock; `awaiting_customer` says we
 * asked them something. Both are values the Support screen already knows, so a ticket the agent
 * touched sorts and filters exactly like one a person touched.
 */
function fieldsForSentAnswer(
  args: SupportDispatchArgs,
  nowIso: string,
): Parameters<typeof patchTicketAiFields>[0]["fields"] {
  const { decision } = args;
  const resolving = decision.action_required === "AUTO_REPLY_AND_RESOLVE";

  return {
    status: resolving ? "resolved" : "awaiting_customer",
    priority: priorityForSeverity(decision.severity_level),
    category: categoryForTopic(decision.issue_category),
    channel: args.channel,
    ai_answered_at: nowIso,
    /* The clock the 48-hour auto-close counts from, started for BOTH outcomes: a resolution
       the customer never acknowledges and a question they never answer both end the same way.
       Cleared the moment they write back (see run-support-agent.ts). */
    ai_awaiting_reply_since: nowIso,
    ...(resolving
      ? {
          resolved_at: nowIso,
          /* Named as the agent's, not as a person's. `resolved_by` stays null — it is a
             FK to auth.users and the agent is not a user; writing somebody's id there would
             credit a colleague with an answer they never read. */
          resolution_note:
            `Answered by the AI support agent (${decision.issue_category}, ` +
            `confidence ${decision.confidence_score.toFixed(2)}). Reopens if the customer replies.`,
        }
      : {}),
  };
}

/**
 * Send the agent's answer on whichever channel the customer wrote in on.
 *
 * Answering an email over WhatsApp — or the reverse — would be a surprising thing to do to
 * somebody who chose how to contact us, so the channel is not a choice made here. The agent
 * wrote both forms; the inbound channel picks which one is used.
 *
 * `portal` and `app` tickets are drafted and held rather than sent: those surfaces have no
 * outbound message path of their own, and quietly emailing somebody who raised a ticket in the
 * portal would be answering on a channel they did not choose.
 */
async function sendAnswer(args: SupportDispatchArgs): Promise<SupportDispatchResult> {
  const { decision, tenantId, ticketId } = args;
  const nowIso = new Date().toISOString();
  const asked = decision.action_required === "REQUEST_MORE_INFO";

  const heldOutcome = async (why: string): Promise<SupportDispatchResult> => {
    /* File the triage even though nothing went out — see triageFields. Awaited, so the row is
       correct by the time the caller reports the outcome; a floating promise here would leave
       the Support screen briefly showing the untriaged defaults for a ticket the log already
       described as handled. */
    const patched = await patchTicketAiFields({
      tenantId,
      ticketId,
      fields: triageFields(args),
    });
    if (!patched.ok) {
      console.error(
        `[support-dispatcher] held ${ticketId} but could not file its triage — ${patched.error}`,
      );
    }
    return {
      outcome: "held",
      detail: `${asked ? "Question" : "Answer"} drafted, not sent — ${why}`,
    };
  };

  /* The draft goes on the transcript BEFORE the send is attempted, so it exists whichever way
     the send goes. A held answer that only logged "held" would tell the rep it happened and
     never what it would have said. */
  const recordDraft = (sent: boolean, why: string) =>
    recordSupportTurn({
      tenantId,
      ticketId,
      channel: args.channel,
      customerContact: args.customerContact,
      role: "agent",
      content: sent
        ? decision.generated_response.body_text
        : `DRAFTED, NOT SENT — ${why}\n\nSubject: ${decision.generated_response.email_subject}\n\n${decision.generated_response.body_text}`,
      intent: decision.issue_category,
      resolutionStatus: sent ? resolutionStatusFor(decision.action_required) : "none",
      confidence: decision.confidence_score,
    });

  if (args.channel === "portal" || args.channel === "app") {
    const why =
      `the ticket came in through the ${args.channel}, which has no outbound message path — ` +
      "reply from the Support screen";
    await recordDraft(false, why);
    await logAiAction({
      tenantId,
      action: SUPPORT_SEND,
      outcome: "held",
      reason: why,
      mode: "hold",
      entity: "support_ticket",
      entityId: ticketId,
      facts: { channel: args.channel, issue: decision.issue_category },
    });
    return await heldOutcome(why);
  }

  if (args.channel === "email") {
    const res = await sendCustomerEmail({
      to: args.customerContact,
      from: args.fromEmail,
      /* `Re: <the customer's subject>` — see lib/email/reply-subject.ts. */
      subject: replySubject(args.incomingSubject, decision.generated_response.email_subject),
      text: decision.generated_response.body_text,
      /* `route` is not optional in practice, even though the type says it is. Without it the
         send goes through the default Resend transport instead of whatever this tenant chose
         (migration 0235), so a reseller who configured Gmail would have support answers arrive
         from a different address than the rest of their mail. */
      route: { tenantId },
      /* Labels the row in email_log so these are searchable as a group — "what has the support
         agent actually sent" is the first question anybody asks before widening the dial. */
      kind: "ai_support_reply",
      /* The chokepoint. sendEmail resolves the dial, refuses on the kill switch, and writes the
         outcome to ai_action_log and email_log — so this path must NOT log again. */
      automated: { tenantId, action: SUPPORT_SEND },
    });

    /* `stubbed` counts as sent, matching every other caller in the repo: with no Resend key the
       app is in stub mode and the send "happened" as far as the flow is concerned. An autonomy
       refusal comes back as `failed` with errorMessage "not sent — <reason>", which is why the
       reason is read from errorMessage on the other branch. */
    if (res.status === "sent" || res.status === "stubbed") {
      await recordDraft(true, "");
      await applySentFields(args, nowIso);
      return {
        outcome: asked ? "asked_for_more" : "resolved",
        detail: asked
          ? "The AI support agent asked the customer for the missing detail."
          : "The AI support agent answered the customer and resolved the ticket.",
      };
    }

    const why = res.errorMessage ?? "no reason given";
    await recordDraft(false, why);
    return await heldOutcome(why);
  }

  /* ── WhatsApp: gated by hand, see the file header ── */
  const policy = await loadAutonomyPolicy(tenantId);
  const verdict = resolveAutonomy(SUPPORT_SEND, policy);

  if (verdict.mode !== "auto") {
    await recordDraft(false, verdict.reason);
    await logAiAction({
      tenantId,
      action: SUPPORT_SEND,
      outcome: verdict.mode === "hold" ? "held" : "skipped",
      reason: verdict.reason,
      mode: verdict.mode,
      entity: "support_ticket",
      entityId: ticketId,
      facts: { channel: "whatsapp", issue: decision.issue_category },
    });
    return await heldOutcome(verdict.reason);
  }

  try {
    await sendCustomerWhatsApp({
      tenantId,
      to: args.customerContact,
      message: { kind: "text", text: decision.generated_response.whatsapp_summary },
    });
  } catch (err) {
    /* Fail loudly and specifically. "WhatsApp is not configured for this workspace" is fixed on
       a settings page; "send failed" is fixed by asking an engineer. */
    const why = err instanceof Error ? err.message : "unknown error";
    await recordDraft(false, why);
    await logAiAction({
      tenantId,
      action: SUPPORT_SEND,
      outcome: "failed",
      reason: why,
      mode: verdict.mode,
      entity: "support_ticket",
      entityId: ticketId,
      facts: { channel: "whatsapp" },
    });
    return { outcome: "failed", detail: `WhatsApp send failed — ${why}` };
  }

  await recordDraft(true, "");
  await applySentFields(args, nowIso);
  await logAiAction({
    tenantId,
    action: SUPPORT_SEND,
    outcome: "did",
    reason: asked
      ? "The AI support agent asked the customer for the missing detail on WhatsApp."
      : "The AI support agent answered the customer on WhatsApp.",
    mode: verdict.mode,
    entity: "support_ticket",
    entityId: ticketId,
    facts: { channel: "whatsapp", issue: decision.issue_category },
  });

  return {
    outcome: asked ? "asked_for_more" : "resolved",
    detail: asked
      ? "The AI support agent asked the customer for the missing detail on WhatsApp."
      : "The AI support agent answered the customer on WhatsApp and resolved the ticket.",
  };
}

/**
 * Write the ticket's new state, and stamp the first response.
 *
 * A failure here is reported and not swallowed, because it is the case where the customer HAS
 * the answer and the desk does not know: the ticket would stay open and somebody would answer
 * it twice. The send cannot be taken back, so the honest outcome is a loud log rather than a
 * pretend rollback.
 */
async function applySentFields(args: SupportDispatchArgs, nowIso: string): Promise<void> {
  const patched = await patchTicketAiFields({
    tenantId: args.tenantId,
    ticketId: args.ticketId,
    fields: fieldsForSentAnswer(args, nowIso),
  });
  if (!patched.ok) {
    console.error(
      `[support-dispatcher] answered ${args.ticketId} but could not update the ticket — ${patched.error}. ` +
        "The customer has the reply; the ticket state is stale.",
    );
  }
  await stampFirstResponse({ tenantId: args.tenantId, ticketId: args.ticketId, at: nowIso });
}

/* ── The entry point ─────────────────────────────────────────────────────── */

/**
 * Act on the agent's decision. Never throws — the caller is a webhook or a cron and neither may
 * fail because an answer could not go out.
 */
export async function dispatchSupportDecision(
  args: SupportDispatchArgs,
): Promise<SupportDispatchResult> {
  const { decision } = args;

  try {
    if (decision.action_required === "ESCALATE_TO_HUMAN") {
      /* The overrule reason when a rule fired, the model's own read when it chose this itself.
         The rep wants the specific sentence, not "escalated". */
      const reason =
        args.overruled && args.overruleReason
          ? args.overruleReason
          : `the agent was not confident enough to answer this itself (it read the issue as: ${decision.issue_category}, ${decision.severity_level})`;
      return await escalate(args, reason);
    }

    return await sendAnswer(args);
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    console.error("[support-dispatcher] crashed:", err);
    await logAiAction({
      tenantId: args.tenantId,
      action: SUPPORT_SEND,
      outcome: "failed",
      reason: `The dispatcher crashed: ${why}`,
      mode: "hold",
      entity: "support_ticket",
      entityId: args.ticketId,
    }).catch(() => undefined);
    return { outcome: "failed", detail: `The AI support agent crashed — ${why}` };
  }
}
