/**
 * Carry out what the sales agent decided: reply, quote, or fetch a human.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not create quotes. `lib/quotes/auto-quote-for-lead.ts` already does that, and it
 * does the three things that are easy to get wrong: it allocates the id through the
 * `next_document_number` RPC with retries (CLAUDE.md §17a — the sole allocator, because the
 * GST series under CGST Rule 46 must be gapless and a number invented in JS breaks it), it
 * prices from the catalogue through `planQuoteFromEnquiry`, and it refuses to send on five
 * separate conditions each of which reaches the operator as a sentence.
 *
 * Writing a second quote-creation path here would have meant two versions of money
 * arithmetic to keep in step — the exact mistake `auto-quote-for-lead.ts`'s own header
 * describes being moved out of the webhook to avoid. So this file decides WHETHER, and that
 * file decides HOW MUCH.
 *
 * ─── THE DIAL COVERS WHATSAPP TOO, AND THAT NEEDED WRITING BY HAND ──────────
 * `sendEmail` is the chokepoint for mail: pass `automated` and it resolves the autonomy dial,
 * logs the outcome, and refuses if the kill switch is on (lib/email/send.ts). WhatsApp has no
 * such chokepoint — `sendWhatsApp` posts straight to Meta. An agent that respected the brake
 * on email and ignored it on WhatsApp would be a brake in name only, and the kill switch is
 * the control somebody reaches for when a wrong price has already gone out. So the WhatsApp
 * path resolves the dial and writes the log here, in the same shape send.ts uses.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { sendCustomerEmail, sendCustomerWhatsApp } from "@/lib/messaging";
import { replySubject } from "@/lib/email/reply-subject";
import { quotePdfAttachment, mentionsQuote } from "@/lib/quotes/quote-pdf-attachment";
import { autoQuoteForLead, agentMaySendSeparateReply } from "@/lib/quotes/auto-quote-for-lead";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";
import { resolveAutonomy, type AiAction } from "../autonomy";
import { loadAutonomyPolicy, logAiAction } from "../autonomy.server";
import { recordSalesTurn, flagLeadForHumanAttention } from "../sales-agent.server";
import { quoteIsWarranted, type SalesAgentDecision, type SalesChannel } from "../sales-agent";

/* Typed as the RETURN of createAdminClient — hand-rolling this shape is what produced the
   TS2589 "excessively deep" failure in lib/email/owner-alert.ts. */
type Admin = ReturnType<typeof createAdminClient>;

export interface DispatchArgs {
  admin: Admin;
  tenantId: string;
  leadId: string;
  company: string;
  /** Email address or E.164 phone number, matching `channel`. */
  customerContact: string;
  channel: SalesChannel;
  decision: SalesAgentDecision;
  /**
   * Which dial entry gates this send.
   *
   * `reply.send` when a customer message drove it, `followup.send` when the cron did. Two
   * entries rather than one because they are genuinely different permissions: answering
   * somebody who just wrote to you is the safe half, and chasing somebody who did not is the
   * half an operator may well want off. Collapsing them would force one decision to cover both.
   */
  sendAction: Extract<AiAction, "reply.send" | "followup.send">;
  /** True when applyHandoverRules overruled the model — logged, not re-decided. */
  overruled: boolean;
  overruleReason: string;
  /**
   * The subject the CUSTOMER wrote, so the reply lands in their own thread.
   *
   * Optional because WhatsApp has no subject. Absent or empty -> the model's own
   * `email_subject` is used, which is what this path did before 31 Aug 2026 and is why a
   * correct, fast, well-priced answer read as silence: Gmail filed it as a new conversation.
   */
  incomingSubject?: string | null;
  /** Seats as the LEAD understands them. The agent's own read is the fallback. */
  seats: number | null;
  /** The tenant's catalogue, already priced, for resolving the product by name. */
  catalogue: readonly CatalogueItemPrice[];
  /** Product name on the lead, used when the agent named nothing recognisable. */
  leadPlan: string | null;
  /**
   * The quotation this customer ALREADY HAS, or null.
   *
   * Only a delivered one — see lib/quotes/quote-delivered.ts. Used for one thing: if the
   * reply names it, the reply carries its PDF. On 31 Aug 2026 at 16:20 a letter described
   * Q-ADPL-2026-27-0068 in full and attached nothing.
   */
  deliveredQuoteId?: string | null;
  /**
   * The billing term the CUSTOMER named, or null when they did not.
   *
   * Read with the inbound path's own `findBillingTerm`. Null keeps the previous behaviour
   * (annual); an explicit "monthly" now reaches the document instead of only the words.
   */
  term?: "monthly" | "annual" | null;
  /** The customer's own phrase, for the timeline. */
  termSource?: string | null;
  /** Envelope sender for this deployment. */
  fromEmail: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  /** True when the enquiry was a transcribed voice note — see lib/voice/voice-note.ts. */
  heardNotWritten?: boolean;
}

export interface DispatchResult {
  /** What actually happened, for the caller's timeline note. */
  outcome: "replied" | "held" | "quoted" | "handed_over" | "failed";
  /** One sentence a non-engineer can act on. */
  detail: string;
  /** A follow-up the caller should schedule, or null. */
  followUp: { inHours: number; triggerCondition: string } | null;
}

/* ── Handover ────────────────────────────────────────────────────────────── */

/**
 * Flag the lead and say why, in words.
 *
 * The flag alone would be useless. "requires_human_attention = true" on a list of 40 leads
 * tells an operator that something is wrong with one of them and nothing about which
 * question to answer — so the reason goes on the lead AND on the timeline, and the customer's
 * own message is already in the transcript beside it.
 *
 * Nothing is sent. That is the point of a handover: the agent's draft may be perfectly good,
 * but a draft that goes out unread is not a handover, it is a send with extra steps.
 */
async function handOver(args: DispatchArgs, reason: string): Promise<DispatchResult> {
  const { admin, tenantId, leadId } = args;

  /* Through the bare client — the three handover columns are not in the generated Database
     type. See flagLeadForHumanAttention for the measured reason that is not simply fixed by
     regenerating it. */
  const flagged = await flagLeadForHumanAttention({ tenantId, leadId, reason });

  if (!flagged.ok) {
    /* Fail loudly. A handover that silently failed to flag would leave a customer waiting on
       a person who was never told — worse than an unanswered enquiry, because the log would
       say it was handled. */
    console.error("[quote-dispatcher] could not flag lead for handover:", flagged.error);
    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: leadId, kind: "note",
      detail:
        `A person needs to take this lead on — ${reason} ` +
        `(could not set the handover flag: ${flagged.error} — pick it up from this note)`,
    });
    await logAiAction({
      tenantId, action: args.sendAction, outcome: "failed",
      reason: `Handover needed but the lead could not be flagged: ${flagged.error}`,
      mode: "hold", entity: "lead", entityId: leadId,
    });
    return { outcome: "failed", detail: `Handover flag failed — ${flagged.error}`, followUp: null };
  }

  /* ── The DRAFT goes on the timeline too, not just the reason ────────────────
     The held-by-dial path a few lines below already does this, and its comment makes the
     argument: "a held reply that only logged 'held' would tell the operator it happened and
     never what it would have said." That argument was never carried across to handover, and
     handover is the branch where it matters MORE — a dial-held reply is one a person meant to
     review, while a handover is the agent saying it cannot finish this itself.

     Measured 26 Aug 2026: a 60-seat enquiry handed over with "the draft says discount", and the
     draft was gone. So neither the operator could send it after a read, nor could anyone see
     WHICH sentence tripped the guard — and that sentence is the only thing that would say
     whether the guard was right. I had to stop and add this before I could debug my own
     exemption rule, which is the clearest possible sign it should have been here first.

     `generated_response` is written even on HANDOVER_TO_HUMAN: the model drafts first and
     chooses the action second, so there is a real reply here in almost every case. */
  await admin.from("lead_activities").insert({
    tenant_id: tenantId, lead_id: leadId, kind: "note",
    detail:
      `AI sales agent stopped and asked for a person — ${reason}\n\n` +
      `Subject: ${args.decision.generated_response.email_subject}\n\n` +
      args.decision.generated_response.body_text,
  });

  await logAiAction({
    tenantId, action: args.sendAction, outcome: "held",
    reason, mode: "hold", entity: "lead", entityId: leadId,
    facts: {
      channel: args.channel,
      intent: args.decision.customer_intent,
      sentiment: args.decision.perceived_sentiment,
      confidence: args.decision.confidence_score,
      overruled: args.overruled,
    },
  });

  return { outcome: "handed_over", detail: reason, followUp: null };
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

/**
 * Send the agent's reply on whichever channel it came in on.
 *
 * Answering an email on WhatsApp — or the reverse — would be a surprising thing to do to a
 * stranger, so the channel is not a choice made here. The agent wrote both forms; the inbound
 * channel picks which one is used.
 */
async function sendReply(args: DispatchArgs): Promise<DispatchResult> {
  const { decision } = args;

  if (args.channel === "email") {
    /* ── A LETTER THAT NAMES A DOCUMENT CARRIES IT ─────────────────────────────
       31 Aug 2026, 16:20: the agent wrote "We have prepared quotation Q-ADPL-2026-27-0068 …
       Confirm quotation Q-ADPL-2026-27-0068 and I will initiate your account setup" — with
       nothing attached. The PDF had gone seven minutes earlier in its own mail, so the
       document existed; the person reading THAT letter still had to go hunting.

       The trigger is the text, not the existence of a document: a "noted, thanks" reply
       should not drag a PDF along. And a failure here costs an attachment, never the reply —
       `quotePdfAttachment` returns null on anything going wrong. */
    const attach = mentionsQuote(decision.generated_response.body_text, args.deliveredQuoteId)
      ? await quotePdfAttachment(args.admin, args.tenantId, args.deliveredQuoteId as string)
      : null;

    const res = await sendCustomerEmail({
      to: args.customerContact,
      from: args.fromEmail,
      attachments: attach ? [attach] : undefined,
      /* `Re: <the customer's subject>`. The model writes the body; it does not name the
         conversation — see lib/email/reply-subject.ts. */
      subject: replySubject(args.incomingSubject, decision.generated_response.email_subject),
      text: decision.generated_response.body_text,
      /* `route` is not optional in practice, even though the type says it is. Without it the
         send goes through the default Resend transport instead of whatever this tenant chose
         (migration 0235) — so a reseller who configured Gmail would have the agent's replies
         arrive from a different address than the rest of their mail. `runAutoReply`, which
         this path replaced, passed it; dropping it would have been a silent regression. */
      route: { tenantId: args.tenantId },
      /* Labels the row in email_log so these are searchable as a group — "what has the agent
         actually sent" is the first question anybody asks before widening the dial. */
      kind: args.sendAction === "followup.send" ? "ai_sales_followup" : "ai_sales_reply",
      /* The chokepoint. sendEmail resolves the dial, refuses on the kill switch, and writes
         the outcome to ai_action_log and email_log — so this path must NOT log again. */
      /* entityId = lead: retry-cron isi naam se dhoondhta hai ki jawab gaya ya nahi. */
      automated: { tenantId: args.tenantId, action: args.sendAction, entityId: args.leadId },
    });

    /* `stubbed` counts as sent, matching every other caller in the repo: with no Resend key
       the app is in stub mode and the send "happened" as far as the flow is concerned. The
       autonomy refusal above comes back as `failed` with errorMessage "not sent — <reason>",
       which is why the reason is read from errorMessage on the other branch. */
    if (res.status === "sent" || res.status === "stubbed") {
      await recordSalesTurn({
        tenantId: args.tenantId, leadId: args.leadId, channel: "email",
        customerContact: args.customerContact, role: "agent",
        content: decision.generated_response.body_text,
        intent: decision.customer_intent, sentiment: decision.perceived_sentiment,
        confidence: decision.confidence_score,
      });
      return { outcome: "replied", detail: "The AI sales agent answered by email.", followUp: toFollowUp(decision) };
    }

    /* `hold` and `off` both come back not-ok, and the reason distinguishes them. The DRAFT is
       written to the timeline either way — a held reply that only logged "held" would tell the
       operator it happened and never what it would have said. */
    const why = res.errorMessage ?? "no reason given";
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail:
        `AI sales agent drafted this reply and did not send it — ${why}\n\n` +
        `Subject: ${decision.generated_response.email_subject}\n\n${decision.generated_response.body_text}`,
    });
    return {
      outcome: "held",
      detail: `Reply drafted, not sent — ${why}`,
      followUp: toFollowUp(decision),
    };
  }

  /* ── WhatsApp: gated by hand, see the file header ── */
  const policy = await loadAutonomyPolicy(args.tenantId);
  const verdict = resolveAutonomy(args.sendAction, policy);

  if (verdict.mode !== "auto") {
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail:
        `AI sales agent drafted this WhatsApp reply and did not send it — ${verdict.reason}\n\n` +
        decision.generated_response.whatsapp_summary,
    });
    await logAiAction({
      tenantId: args.tenantId, action: args.sendAction,
      outcome: verdict.mode === "hold" ? "held" : "skipped",
      reason: verdict.reason, mode: verdict.mode,
      entity: "lead", entityId: args.leadId, facts: { channel: "whatsapp" },
    });
    return { outcome: "held", detail: `WhatsApp reply drafted, not sent — ${verdict.reason}`, followUp: toFollowUp(decision) };
  }

  try {
    await sendCustomerWhatsApp({
      tenantId: args.tenantId,
      to: args.customerContact,
      message: { kind: "text", text: decision.generated_response.whatsapp_summary },
      related: { leadId: args.leadId },
    });
  } catch (err) {
    /* Fail loudly and specifically. "WhatsApp is not configured for this workspace" is fixed
       on a settings page; "send failed" is fixed by asking an engineer. */
    const why = err instanceof Error ? err.message : "unknown error";
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail: `AI sales agent could not send its WhatsApp reply — ${why}`,
    });
    await logAiAction({
      tenantId: args.tenantId, action: args.sendAction, outcome: "failed",
      reason: why, mode: verdict.mode, entity: "lead", entityId: args.leadId,
      facts: { channel: "whatsapp" },
    });
    return { outcome: "failed", detail: `WhatsApp send failed — ${why}`, followUp: toFollowUp(decision) };
  }

  await recordSalesTurn({
    tenantId: args.tenantId, leadId: args.leadId, channel: "whatsapp",
    customerContact: args.customerContact, role: "agent",
    content: decision.generated_response.whatsapp_summary,
    intent: decision.customer_intent, sentiment: decision.perceived_sentiment,
    confidence: decision.confidence_score,
  });
  await logAiAction({
    tenantId: args.tenantId, action: args.sendAction, outcome: "did",
    reason: "The AI sales agent answered on WhatsApp.", mode: verdict.mode,
    entity: "lead", entityId: args.leadId, facts: { channel: "whatsapp" },
  });

  return { outcome: "replied", detail: "The AI sales agent answered on WhatsApp.", followUp: toFollowUp(decision) };
}

function toFollowUp(d: SalesAgentDecision): { inHours: number; triggerCondition: string } | null {
  if (!d.next_followup_loop) return null;
  return {
    inHours: d.next_followup_loop.in_hours,
    triggerCondition: d.next_followup_loop.trigger_condition,
  };
}

/* ── The entry point ─────────────────────────────────────────────────────── */

/**
 * Resolve the product the conversation is about.
 *
 * Exact name match against the catalogue, in the agent's stated order of knowledge: whatever
 * the lead already records, since the extractor wrote that from the customer's own words.
 * No fuzzy matching — a near-miss here silently prices the WRONG product, and the refusal
 * path (`plan.ok === false` inside autoQuoteForLead) puts a readable reason on the timeline,
 * which is a better outcome than a confident quote for Business Plus.
 */
function resolveItem(
  catalogue: readonly CatalogueItemPrice[],
  leadPlan: string | null,
): CatalogueItemPrice | null {
  if (!leadPlan) return null;
  return catalogue.find((c) => c.name === leadPlan) ?? null;
}

/**
 * Act on the agent's decision. Never throws — the caller is a webhook or a cron and neither
 * may fail because a reply could not go out.
 */
export async function dispatchSalesDecision(args: DispatchArgs): Promise<DispatchResult> {
  const { decision } = args;

  try {
    if (decision.action_required === "HANDOVER_TO_HUMAN") {
      /* The overrule reason when a rule fired, the model's own read when it chose this
         itself. The operator wants the specific sentence, not "handover".

         ─── THE OLD FALLBACK NAMED THE WRONG REASON, 26 Aug 2026 ───────────────
         It said "the agent was not confident enough to answer this itself" for EVERY
         unoverruled handover. But an unoverruled handover is precisely the case where the
         model chose to hand over on its own judgement — and a customer answering "monthly"
         on an 80-seat quote was logged that way at confidence 0.95, against a 0.7 threshold.
         The real reason was that the agent has no monthly rate and refused to invent one.
         Debugging that cost an hour, and the log had pointed away from it the whole time.

         So: the model's own `handover_reason` first, and when it did not give one, a sentence
         that states what actually happened and carries the confidence so the reader can see
         for themselves that it was not the problem. */
      const chose = decision.handover_reason
        ? `the agent handed this over: ${decision.handover_reason}`
        : `the agent chose to hand this over (confidence ${decision.confidence_score.toFixed(2)})`;
      const reason =
        args.overruled && args.overruleReason
          ? args.overruleReason
          : `${chose} — it read the enquiry as: ${decision.customer_intent}`;
      return await handOver(args, reason);
    }

    if (quoteIsWarranted(decision, args.seats)) {
      const item = resolveItem(args.catalogue, args.leadPlan);
      const seats = args.seats ?? decision.seats_discussed;

      /* Awaited, not fire-and-forget. The caller decides whether to await THIS function; from
         here on the ordering of the timeline rows is the thing being protected, and a floating
         promise would interleave the quote's rows with the reply's.

         And the OUTCOME is kept now, because it decides whether anything else may write to
         this customer — see the block below. */
      /* ── TERM: model ki poori-thread wali padhat PEHLE ─────────────────────
         1 Sep 2026: customer "yearly" tay kar chuka tha, phir sirf BHUGTAN
         monthly maanga — keyword-search ne commitment palat kar flex (Rs 325)
         bol diya. term_discussed teeno ko alag rakhta hai; keyword-search ab
         sirf fallback hai (purane model-output me field absent → null). */
      const td = args.decision.term_discussed;
      const effTerm: "monthly" | "annual" =
        td === "monthly_flex" ? "monthly" : td ? "annual" : (args.term ?? "annual");
      const effBilling: "monthly" | null = td === "annual_billed_monthly" ? "monthly" : null;
      const effTermSource = td
        ? `agent read the whole thread: ${td.replace(/_/g, " ")}`
        : (args.termSource ?? "annual commitment");

      const quoted = await autoQuoteForLead(args.admin, {
        tenantId: args.tenantId,
        leadId: args.leadId,
        company: args.company,
        item,
        seats,
        /* ── THE TERM THE CUSTOMER NAMED, NOT ALWAYS ANNUAL ──────────────────
           This was hardcoded `term: "annual"`, and the reasoning was: the agent only
           quotes once a product and a seat count are known, and every catalogue price it
           was shown is the annual-commitment figure, so "annual" is never an assumption.

           It missed the case that actually happened. 30 Aug 2026: the app asked "monthly
           or annual?", the customer answered **"monthly"**, and the reply that went out
           quoted "Rs 325 per seat per MONTH" — while the document attached to it,
           Q-ADPL-2026-27-0045, was raised for Rs 1,11,255 a YEAR. The words and the
           document disagreed, and the document is the half a customer keeps.

           `findBillingTerm` is the same function the inbound path uses, not a second
           keyword search that agrees with it today. Null still means annual, exactly as
           before — the change is only that an explicit "monthly" is now honoured. */
        term: effTerm,
        billing: effBilling,
        billingSource: effBilling ? effTermSource : null,
        seatsSource: seats === null ? null : `${seats} seats, from the conversation`,
        productSource: item ? `${item.name}, from the conversation` : null,
        termSource: effTermSource,
        recipient: args.customerContact,
        senderIsOurs: args.senderIsOurs,
        isSelfTest: args.isSelfTest,
        heardNotWritten: args.heardNotWritten,
        fromEmail: args.fromEmail,
        notePrefix: `Quoted by the AI sales agent — it read the enquiry as: ${decision.customer_intent}`,
        /* The customer's own subject, so the quotation threads. Same helper, same reason as
           the reply below — before 31 Aug 2026 the quotation mail wrote its own subject and
           Gmail filed it as a separate conversation. */
        incomingSubject: args.incomingSubject,
      });

      /* ── THE COVERING MESSAGE IS NOT A SECOND MAIL ─────────────────────────
         This used to be unconditional, and the comment read "the covering message goes out
         after the quote, so the customer's inbox reads in the order the events happened".
         Ordering was never the problem. COUNT was.

         Pardeep's screenshot, 31 Aug 2026 17:54 — one enquiry, two mails: a prose reply and
         a separate "Your quote Q-…" carrying the PDF. `lib/inbound/ingest.ts` held the other
         half of that defect; this is the same shape on the agent's own path.

         It is also no longer needed. The quotation's covering letter
         (`lib/email/quote-body.ts`) now states the seats, the unit price with its unit, the
         billing term, the GST split, the supplier's GSTIN and the terms — it says everything
         a "here is your quotation" note would say, and it arrives with the document.

         So when the quotation reached the customer, the agent's draft is filed on the
         timeline instead of mailed. Nothing is lost: an operator can read it and send it if
         it said something the letter does not. That is the same discipline this file already
         applies to a held reply — a draft that is not sent must still be visible. */
      if (!agentMaySendSeparateReply(quoted)) {
        await args.admin.from("lead_activities").insert({
          tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
          detail:
            `Quotation ${quoted.quoteId} was emailed in the customer's own thread, so the ` +
            `agent's covering reply was NOT sent as a second mail. Its draft:\n\n` +
            `Subject: ${decision.generated_response.email_subject}\n\n` +
            decision.generated_response.body_text,
        });
        return {
          outcome: "quoted",
          detail:
            `Quote ${quoted.quoteId} emailed for ${seats ?? "?"} × ` +
            `${item?.name ?? "an unmatched product"} — one mail, in the customer's thread.`,
          followUp: null,
        };
      }

      /* No quotation reached them — it was refused, held for review, or the send failed, and
         each of those already wrote its reason on the timeline. They are still owed an
         answer, so the agent's reply goes out as it did before. */
      const sent = await sendReply(args);
      return {
        outcome: sent.outcome === "replied" ? "quoted" : sent.outcome,
        detail: `Quote drafted for ${seats ?? "?"} × ${item?.name ?? "an unmatched product"} · ${sent.detail}`,
        followUp: sent.followUp,
      };
    }

    return await sendReply(args);
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    console.error("[quote-dispatcher] crashed:", err);
    await logAiAction({
      tenantId: args.tenantId, action: args.sendAction, outcome: "failed",
      reason: `The dispatcher crashed: ${why}`, mode: "hold",
      entity: "lead", entityId: args.leadId,
    }).catch(() => undefined);
    return { outcome: "failed", detail: `The AI sales agent crashed — ${why}`, followUp: null };
  }
}
