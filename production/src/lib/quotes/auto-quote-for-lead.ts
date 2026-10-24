/**
 * Draft a quote for a lead from what an inbound mail said, and send it if the rules allow.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT 130 LINES IN THE WEBHOOK ─────────────────
 * Because it has to run on TWO branches and it only ran on one. Measured on a live
 * self-test, 23 Aug 2026: a mail asking for "50 Google Workspace Business Starter users on
 * annual billing" arrived from an address that already had an open lead, so the webhook
 * appended it — correctly — and drafted nothing, because the quote block sat inside the
 * CREATE branch alone. The extractor had done its job: seats 20 → 50, plan Business Standard
 * → Business Starter, both written to the lead. And then nothing priced it.
 *
 * That is backwards. A reply from somebody already in conversation, naming a seat count and
 * a plan, is the MOST quote-worthy mail this app receives — a first enquiry is usually
 * vaguer. Copying the block into the append branch would have left two versions of money
 * arithmetic to keep in step, so it moved here and both branches call it.
 *
 * ─── WHAT IT DOES NOT DECIDE ────────────────────────────────────────────────
 * Whether a reply DESERVES a new quote at all — that is `shouldRequoteOnReply`, and only
 * the append branch asks it, because a brand-new lead has nothing to compare against. The
 * split matters: without that gate a five-message thread about the same fifty seats would
 * mint five GST documents, each taking an irreversible number from the gapless Rule 46
 * series.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { isEmailConfigured } from "@/lib/email/send";
import { planQuoteFromEnquiry, type CatalogueItemPrice } from "./quote-from-enquiry";
import { decideAutoSend } from "./auto-send-quote";
import { sendAutoQuote } from "./send-auto-quote";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { toIstDate } from "@/lib/dates/ist";
import { readTenantGstRegistration } from "@/lib/compliance/gst-registration-server";
import { quoteStartTaxRate } from "./bill-of-supply";

/* Typed as the RETURN of createAdminClient — hand-rolling this shape is what produced the
   TS2589 "excessively deep" failure in lib/email/owner-alert.ts. */
type Admin = ReturnType<typeof createAdminClient>;

export interface AutoQuoteArgs {
  tenantId: string;
  leadId: string;
  /** Company name for the quote's customer_name. */
  company: string;
  /** The catalogue row the mail named, with prices. Null when nothing matched. */
  item: CatalogueItemPrice | null;
  seats: number | null;
  /** From extractEntities().term — null when the sender never said. */
  term: "monthly" | "annual" | null;
  /**
   * Invoice kitni baar — COMMITMENT se alag sawal (1 Sep 2026). "monthly" +
   * term annual = saal ka vaada, 12 kishton me bhugtan (annual tier ka rate,
   * quote.billing_cycle monthly — instalments engine baaki karta hai).
   * Null = commitment se hi cycle nikle, jaisa pehle tha.
   */
  billing?: "monthly" | "yearly" | null;
  billingSource?: string | null;
  /** What the extractor matched, quoted on the draft so a reader can check it. */
  seatsSource: string | null;
  /** True when the seat count came out of a voice-note transcription, not the customer. */
  heardNotWritten?: boolean;
  productSource: string | null;
  termSource: string | null;
  /** Where the mail came from, and where a quote would go. */
  recipient: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  fromEmail: string;
  /** The customer's own subject, so the quotation mail threads. Null for cron-driven quotes. */
  incomingSubject?: string | null;
  /** Prefix for the draft's notes — lets the append branch say why it re-quoted. */
  notePrefix?: string;
  /**
   * Re-price THIS existing draft instead of taking a new document number.
   *
   * From `shouldRequoteOnReply`, and only ever a `draft`. Pardeep's decision, 31 Aug 2026:
   * Q-ADPL-2026-27-0055 was drafted on an assumed annual term, correctly not sent, and the
   * agent had already told the customer its number. When the customer supplied the term, the
   * right document was that one at the right price — not a second number with the first left
   * dead in the gapless Rule 46 series.
   *
   * The UPDATE is scoped by tenant, lead AND `status = 'draft'`, so a quote that was sent in
   * the meantime cannot be rewritten underneath the customer. If it matches nothing, this
   * falls through to allocating a new number and says so on the timeline.
   */
  repriceDraftId?: string;
}

/**
 * Did this call write to the CUSTOMER, and if not, why not?
 *
 * ─── THE SCREENSHOT THAT FORCED THIS ────────────────────────────────────────
 * 31 Aug 2026, 17:54. One enquiry, two mails in Pardeep's inbox:
 *
 *     Re: mujhe 40 email ke liye quote chahiye google business starter monthly
 *     Your quote Q-ADPL-2026-27-0107 — ANUTECH DIGITAL PVT LTD        [PDF]
 *
 * Only ONE quotation was raised — the duplicate guard below did its job. What went wrong was
 * one level up: `ingest.ts` fired this function and the AI sales agent as two `void` calls,
 * so they ran at the same time and NEITHER knew what the other was doing. The agent read the
 * lead's latest quote before this function had created one, so it answered in prose; this
 * function then emailed the document under a subject of its own, in a thread of its own.
 *
 * Two answers to one question, and the one holding the document looked unrelated to it.
 *
 * A `Promise<void>` cannot be sequenced against — there is nothing to branch on. So the
 * outcome is returned, the caller runs the two steps in order, and the agent speaks only when
 * this one did not. The `reason` is carried so the timeline can say why the agent was silent
 * instead of leaving a gap.
 */
/** The customer has the quotation, in their own thread, with the PDF. */
export type AutoQuoteEmailed = { emailed: true; quoteId: string };
/** Nothing reached the customer. `reason` is already on the lead's timeline. */
export type AutoQuoteNotEmailed = { emailed: false; reason: string };
export type AutoQuoteOutcome = AutoQuoteEmailed | AutoQuoteNotEmailed;

/**
 * May anything ELSE mail this customer about this message?
 *
 * One line of logic, given a name and a home, because it is asked in two places that had
 * drifted apart — `lib/inbound/ingest.ts` (the webhook) and
 * `lib/ai/actions/quote-dispatcher.ts` (the agent's own path). Both used to mail regardless,
 * and 31 Aug 2026 that put two mails in one inbox for one enquiry.
 *
 * The rule: if the quotation reached them, the quotation IS the answer. Its covering letter
 * carries the seats, the rate with its unit, the billing term, the GST split and the terms,
 * and it arrives in their own thread with the PDF. A second mail beside it is the app talking
 * over itself.
 *
 * If it did NOT reach them — refused, held for review, or the send failed — they are still
 * owed an answer, and the agent gives it.
 */
/* A type PREDICATE, not a plain `boolean` — and typecheck is why. With a boolean, the branch
   that runs when the quotation DID go out could no longer see `quoteId`, which is exactly what
   both call sites need in order to name the document they sent. A rule given a name must not
   cost the caller the fact it is deciding on. */
export function agentMaySendSeparateReply(
  outcome: AutoQuoteOutcome,
): outcome is AutoQuoteNotEmailed {
  return !outcome.emailed;
}

export async function autoQuoteForLead(
  admin: Admin,
  args: AutoQuoteArgs,
): Promise<AutoQuoteOutcome> {
  /* R-1532: a business that issues a Bill of Supply quotes at 0% — R-1529's database refuses
     GST on its invoice. */
  const taxRate: 0 | 18 = quoteStartTaxRate(await readTenantGstRegistration(admin, args.tenantId)) === 0 ? 0 : 18;
  const plan = planQuoteFromEnquiry({ item: args.item, seats: args.seats, term: args.term, taxRatePct: taxRate });

  if (!plan.ok) {
    /* Four of the planner's five outcomes are refusals, each with a reason, so a lead that
       could not be quoted says WHY on its own timeline instead of looking neglected. */
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail: `No quote drafted automatically — ${plan.reason}`,
    });
    return { emailed: false, reason: plan.reason };
  }

  /* ── TWO CALLERS, ONE REQUIREMENT — Pardeep caught this at 15:25 on 31 Aug 2026 ──────
     Lead L-MTH28OTO received TWO identical quotations, Q-0064 and Q-0066, both 10 × Business
     Starter at Rs 3,250/month, both emailed, six seconds apart:

       09:53:08  first mail  -> Q-0064 drafted, term ASSUMED annual, correctly not sent
       09:55:05  reply says "monthly"
       09:55:08  Q-0064 RE-PRICED by the inbound pipeline  (the change I made that morning)
       09:55:15  Q-0064 emailed
       09:55:21  Q-0066 raised by the AI AGENT's dispatcher
       09:55:25  Q-0066 emailed

     This function has TWO callers — `lib/inbound/ingest.ts` and
     `lib/ai/actions/quote-dispatcher.ts` — and each was written as though it were the only
     one. They never collided because on a reply with unchanged seats and plan
     `shouldRequoteOnReply` said "nothing changed" and the pipeline did nothing, leaving the
     field to the agent. Teaching it to re-price on a term change woke the pipeline up, and
     both fired. Two irreversible numbers from the gapless Rule 46 series, and two PDFs in a
     customer's inbox, for one requirement.

     So the question moves INSIDE. A caller cannot be trusted to ask "has this already been
     quoted?" — one of them never did, and the other only asked in a narrower way than the
     answer needed. Every other defect this session had the same shape: a decision left with
     the callers drifts. This one is now the function's own. */
  const { data: existing } = await admin
    .from("quotes")
    .select("id, status, seats, plan, billing_cycle")
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .order("created_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const already = existing as
    { id: string; status: string | null; seats: number | null; plan: string | null;
      billing_cycle: string | null } | null;

  const wantCycle = args.billing ?? (plan.items[0]?.commitment === "monthly" ? "monthly" : "yearly");
  const samePaper =
    already !== null &&
    already.seats === args.seats &&
    (already.plan ?? null) === (args.item?.name ?? null) &&
    (already.billing_cycle ?? null) === wantCycle;

  /* Identical requirement AND the customer already has the document -> nothing to do. A
     DRAFT is different: it can still be corrected, which is what `repriceDraftId` is for. */
  if (samePaper && already.status !== "draft" && args.repriceDraftId !== already.id) {
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail:
        `No second quotation raised — ${already.id} already covers ${args.seats} × ` +
        `${args.item?.name ?? "this product"} on ${wantCycle} billing, and it has been sent.`,
    });
    /* The customer already HAS this document, so nothing more should be mailed about it —
       but this call did not mail it, and the agent must be free to answer whatever else the
       message said. `emailed: false` is the honest answer to "did I just write to them". */
    return { emailed: false, reason: `${already.id} already covers this requirement` };
  }

  const today   = new Date();
  const expires = new Date(today);
  expires.setDate(expires.getDate() + 7);

  /* The money fields, computed once. Written by the INSERT below and, when an unsent draft is
     being corrected, by the UPDATE above it — one object so the two paths cannot price the
     same quote differently. */
  const priced = {
    plan:          args.item?.name ?? null,
    seats:         args.seats,
    line_items:    plan.items,
    subtotal:      plan.subtotal,
    /* `as const` zaroori hai: object literal me ternary `string` par widen ho jata hai,
       aur column ek union hai. */
    billing_cycle: (args.billing ?? (plan.items[0]?.commitment === "monthly" ? "monthly" : "yearly")) as BillingCycle,
    total_cost:    plan.items.reduce((sum, i) => sum + i.qty * i.cost, 0),
    discount_pct:  plan.discountPct,
    tax_rate:      taxRate,
    amount:        plan.amount,
  };

  /* The assumption in words on the document itself. Whoever opens this draft must READ "term
     assumed annual" rather than work it out from the rate.
     Hoisted so a RE-PRICED draft gets the same sentence: a corrected quote still carrying
     "term not stated" would be the document lying about itself. */
  const noteText =
    `${args.notePrefix ? `${args.notePrefix}\n` : ""}` +
    `Auto-drafted from an inbound email from ${args.recipient}.\n` +
    `Read from the mail: ${args.seatsSource ?? "seats unknown"} · ` +
    `${args.productSource ?? "product unknown"} · ` +
    `${args.termSource ? `term "${args.termSource}"` : "term not stated"}\n` +
    `${plan.assumption}`;

  let draftQuoteId: string | null = null;
  let repriced = false;

  /* ── CORRECT THE UNSENT DRAFT, DO NOT REPLACE IT ──────────────────────────────
     `status = "draft"` is in the filter, not in a comment: it is what makes this safe. A
     quote that was sent between the decision and this write matches nothing, and the code
     falls through to a new number rather than rewriting a document the customer is holding. */
  if (args.repriceDraftId) {
    const { data: updated, error: upErr } = await admin
      .from("quotes")
      .update({ ...priced, notes: noteText })
      .eq("id", args.repriceDraftId)
      .eq("tenant_id", args.tenantId)
      .eq("lead_id", args.leadId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();

    if (upErr) {
      console.error("[auto-quote] reprice failed:", upErr);
    } else if (updated?.id) {
      draftQuoteId = updated.id as string;
      repriced = true;
    } else {
      /* Said out loud. "The number you were promised is not the number you got" is exactly
         the kind of thing that must never be inferred from silence. */
      await admin.from("lead_activities").insert({
        tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
        detail:
          `${args.repriceDraftId} could not be re-priced — it is no longer an unsent draft. ` +
          "Raising a new quotation instead.",
      });
    }
  }

  /* Three attempts, matching the form path. `next_document_number` is the sole allocator
     (CLAUDE.md §17a) and a collision means counter drift from older seed data, not a logic
     error — the next number is the fix. */
  for (let attempt = 1; attempt <= 3 && !draftQuoteId; attempt++) {
    const { data: quoteId, error: numErr } = await admin
      .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: args.tenantId });
    if (numErr || !quoteId) {
      console.error(`[auto-quote] next_document_number attempt ${attempt} failed:`, numErr);
      break;
    }
    const { error: quoteErr } = await admin.from("quotes").insert({
      id:            quoteId as string,
      tenant_id:     args.tenantId,
      customer_id:   null,
      customer_name: args.company,
      lead_id:       args.leadId,
      /* Every money field comes from `priced`, the SAME object the re-price UPDATE writes.
         Two lists would be two chances to price one quote differently. */
      ...priced,
      /* ── THE COLUMN THE PDF BELIEVES, AND IT WAS NEVER SET ────────────────
         This insert did not name `billing_cycle` at all, so every auto-quote took the
         column default — `yearly` — however the line was priced.

         Harmless while everything was quoted annually. The moment a monthly quote could be
         raised (30 Aug 2026), it became a 12× error on a GST document: QuotePDF resolves
         `billingCycle ?? cycleFromLegacyCommitment(firstCommitment)`, so the ROW wins over
         the LINE. Q-ADPL-2026-27-0049, sent to a customer:

           line   45 x Rs 325/seat/MONTH  ->  subtotal Rs 14,625  (correct, monthly)
           row    billing_cycle "yearly"
           PDF    Rs 27/seat/mo, Rs 1,219/mo, "Annual contract value Rs 16,739"

         Rs 14,625 read as a year and divided by twelve. The true annual value is
         Rs 1,75,500. The words on the document even said "Monthly (flex), billed monthly"
         while the arithmetic said otherwise — the line and the row disagreed, and the row
         is the one the renderer trusts.

         `plan.items[0].commitment` is what the planner actually priced, so this is that
         same fact rather than a second reading of the customer's words.

         All of that now lives in `priced`, at the top of this function — including
         `discount_pct`, which comes from the volume rate card and must NOT also be inside the
         line rate, because every screen renders it as its own "Discount (n%)" row off the
         subtotal. */
      status:        "draft",
      owner_id:      null,
      /* R-025. Both are INSTANTS (`new Date()`, and a copy moved forward by days), so a
         UTC slice is yesterday before 05:30 IST — and this runs on the inbound-mail
         webhook, which fires at whatever hour a customer writes. A quote emailed to a
         customer dated yesterday, with a validity window one day short. */
      created_date:  toIstDate(today),
      expires_date:  toIstDate(expires),
      notes:         noteText,
    });
    if (!quoteErr) { draftQuoteId = quoteId as string; break; }
    if (quoteErr.code === "23505") {
      console.warn(`[auto-quote] quote id collision on attempt ${attempt}: ${quoteId}`);
      continue;
    }
    console.error("[auto-quote] quote insert failed:", quoteErr);
    break;
  }

  await admin.from("lead_activities").insert({
    tenant_id: args.tenantId, lead_id: args.leadId, kind: draftQuoteId ? "quote" : "note",
    detail: draftQuoteId
      ? `${repriced ? "Draft quote " + draftQuoteId + " RE-PRICED" : "Draft quote " + draftQuoteId + " auto-created"} — ${args.seats} × ${args.item?.name}. ` +
        `${plan.termAssumed ? "Term ASSUMED annual" : `Term ${args.term} as stated`}.`
      : `Could not create the draft quote — the lead and the mail are saved, build it by hand`,
  });

  /* Send only when the customer named the term. Pardeep's rule, chosen from four options
     with the cost of each stated: monthly and annual differ by 12×, and a price the app
     inferred and posted is one the customer can reasonably hold us to.

     The gate is `termAssumed`, computed once by the planner — not a second keyword search
     here. decideAutoSend owns the other four refusals so each reaches the operator as a
     sentence rather than as silence. */
  const sendDecision = decideAutoSend({
    termAssumed:     plan.termAssumed,
    /* The seat count the quote was actually priced at, so the volume review band judges the
       same number the customer would read on the document. */
    seats:           args.seats,
    recipient:       args.recipient,
    quoteId:         draftQuoteId,
    emailConfigured: isEmailConfigured(),
    seatsHeardNotWritten: args.heardNotWritten,
    senderIsOurs:    args.senderIsOurs,
    isSelfTest:      args.isSelfTest,
  });

  if (!sendDecision.send) {
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail: `Quote not sent automatically — ${sendDecision.reason}`,
    });
    return { emailed: false, reason: sendDecision.reason };
  }

  if (!draftQuoteId) return { emailed: false, reason: "no draft was created" };

  /* NOT awaited by the caller's caller: rendering a PDF inside a webhook a provider is
     waiting on would trade ingest reliability for latency. Awaited HERE so the activity rows
     above land before the send's own rows, keeping the timeline in order. */
  const sent = await sendAutoQuote(admin, {
    tenantId:  args.tenantId,
    quoteId:   draftQuoteId,
    leadId:    args.leadId,
    recipient: args.recipient,
    fromEmail: args.fromEmail,
    /* So the document lands in the customer's own thread and reads as the reply. */
    incomingSubject: args.incomingSubject,
  });

  return sent === "sent"
    ? { emailed: true, quoteId: draftQuoteId }
    : { emailed: false, reason: "the quotation email failed to send" };
}
