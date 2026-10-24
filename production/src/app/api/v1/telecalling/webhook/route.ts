/**
 * POST /api/v1/telecalling/webhook — what the call came to.
 *
 * The telephony vendor POSTs here when a call ends: transcript, duration, its own post-call
 * analysis. This route records it against the row that placed the call and, if the customer
 * asked for a quotation, hands off to the quote dispatcher.
 *
 *   1. Verify the signature — FAIL CLOSED, no secret means no request is trusted.
 *   2. Normalise whichever vendor sent it (lib/telecall/inbound.ts).
 *   3. Find the row WE wrote, by the vendor's call id, and take the tenant from that row.
 *   4. Classify the outcome, check what was said about money, record it.
 *   5. Quote, or fetch a human — once, however many times the vendor retries.
 *
 * ─── WHY THE TENANT IS NOT READ OUT OF THE BODY ─────────────────────────────
 * A signature proves a payload is AUTHENTIC, not that it is CORRECT. A mis-scripted vendor
 * agent echoing back the wrong metadata would, on a body-trusting endpoint, write a customer's
 * transcript — and possibly a quotation — into another reseller's workspace. The row this app
 * wrote when it placed the call is the authority; see findTelecallByProviderCallId.
 *
 * ─── WHY A 200 ON THINGS THAT LOOK LIKE ERRORS ──────────────────────────────
 * Both vendors retry on any non-2xx. An unknown call id is not a transient fault — it is a
 * call this deployment did not place (someone dialling from the vendor dashboard, or a second
 * deployment sharing the account), and answering 4xx would have them retrying it for hours. So
 * the refusal is logged and acknowledged. A genuine failure on OUR side returns 500, because
 * that IS worth retrying.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  signatureRefusalReason,
  verifyRetellSignature,
  verifySharedSecretHeader,
  type SignatureVerdict,
} from "@/lib/crypto/webhook-signature";
import { looksLikeBolnaExecution, normalisePostCall, sentimentOf } from "@/lib/telecall/inbound";
import { fetchBolnaExecution, resolveTelecallProvider } from "@/lib/telecall/provider";
import { classifyCall, verifyCallMoney } from "@/lib/ai/telecall";
import { callTurnFor } from "@/lib/ai/unified-memory";
import { findTelecallByProviderCallId, recordTelecallOutcome } from "@/lib/ai/telecall.server";
import { logAiAction } from "@/lib/ai/autonomy.server";
import { recordSalesTurn, flagLeadForHumanAttention } from "@/lib/ai/sales-agent.server";
import { loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchSalesDecision } from "@/lib/ai/actions/quote-dispatcher";
import { TELECALLER_NAME } from "@/lib/ai/telecaller-prompt";
import type { SalesAgentDecision } from "@/lib/ai/sales-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

/**
 * Verify whichever vendor this is.
 *
 * Retell signs the body under the API key; Vapi sends a shared secret header that does not bind
 * to the body at all. Both are accepted because both are what the respective vendor offers —
 * and the weaker one is named as weaker in webhook-signature.ts rather than quietly treated as
 * equivalent.
 */
function verify(req: NextRequest, rawBody: string): SignatureVerdict {
  const retellHeader = req.headers.get("x-retell-signature");
  if (retellHeader) {
    return verifyRetellSignature(rawBody, retellHeader, process.env.RETELL_API_KEY);
  }

  const vapiHeader = req.headers.get("x-vapi-secret");
  if (vapiHeader) {
    return verifySharedSecretHeader(vapiHeader, process.env.VAPI_WEBHOOK_SECRET);
  }

  /* R-1437: Bolna documents no webhook signature and no custom headers, so its webhook URL
     carries a shared secret: `/api/v1/telecalling/webhook?bolna_secret=…`. Weaker than a
     signature — which is why a Bolna body is never believed: see the fetch-back below. */
  const bolnaSecret = req.nextUrl.searchParams.get("bolna_secret");
  if (bolnaSecret) {
    return verifySharedSecretHeader(bolnaSecret, process.env.BOLNA_WEBHOOK_SECRET);
  }

  return { ok: false, reason: "missing_header" };
}

export async function POST(req: NextRequest) {
  /* The RAW bytes. Re-serialising parsed JSON changes whitespace and key order, and the HMAC
     would then never match — the same note verifyMetaSignature carries. */
  const rawBody = await req.text();

  const verdict = verify(req, rawBody);
  if (!verdict.ok) {
    console.error(`[telecall-webhook] refused — ${signatureRefusalReason(verdict.reason)}`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  /* ── R-1437: a Bolna body is only a pointer ──────────────────────────────
     Bolna's webhook is authenticated by a URL secret, which proves nothing about the body. So
     only the execution id is taken from it, and what happened on the call is read back from
     Bolna's own API with our key. Bolna also posts while the call is still ringing; those
     intermediate statuses normalise to null below and are acknowledged. */
  if (looksLikeBolnaExecution(parsed)) {
    const bolna = resolveTelecallProvider();
    if (!bolna || bolna.name !== "bolna") {
      console.warn("[telecall-webhook] Bolna webhook arrived but Bolna is not the configured provider");
      return NextResponse.json({ ok: true, ignored: "bolna is not configured here" });
    }
    const executionId = String((parsed as Record<string, unknown>).id);
    const fetched = await fetchBolnaExecution(bolna, executionId);
    if (!fetched.ok) {
      /* 500: our read failed, Bolna still has the call, and a retry may well succeed. */
      console.error(`[telecall-webhook] could not read Bolna execution ${executionId}: ${fetched.error}`);
      return NextResponse.json({ error: "could not read the call from bolna" }, { status: 500 });
    }
    parsed = fetched.execution;
  }

  const call = normalisePostCall(parsed);
  if (!call) {
    /* 200, not 400. A shape we do not recognise is most often an event type we do not care
       about — Retell sends `call_started` down the same URL — and retrying it forever helps
       nobody. Logged so an actually-new payload shape is visible rather than silent. */
    console.warn("[telecall-webhook] payload was not a post-call report this app understands");
    return NextResponse.json({ ok: true, ignored: "not a post-call report" });
  }

  const row = await findTelecallByProviderCallId(call.providerCallId);
  if (!row) {
    console.warn(`[telecall-webhook] no call row for ${call.provider} id ${call.providerCallId}`);
    return NextResponse.json({ ok: true, ignored: "this deployment did not place that call" });
  }

  /* Stated, not enforced. If the vendor echoed a different tenant than the row records, the ROW
     wins — but somebody should know the metadata is wrong, because that same metadata is what a
     future reader will assume was authoritative. */
  if (call.tenantId && call.tenantId !== row.tenantId) {
    console.error(
      `[telecall-webhook] metadata tenant ${call.tenantId} disagrees with call row tenant ` +
      `${row.tenantId} — the row was used. Check the vendor agent's metadata configuration.`,
    );
  }

  const classification = classifyCall(call.signals, row.callType);

  /* What was said about money, checked against what this call was authorised to say — the list
     stored on the row when the script was built, so the guard and the agent cannot disagree. It
     cannot un-say anything; its whole job is to fetch a person in seconds. See verifyCallMoney. */
  const money = verifyCallMoney(call.signals.transcript, row.authorisedFigures);

  const recorded = await recordTelecallOutcome({
    tenantId: row.tenantId,
    providerCallId: call.providerCallId,
    status: classification.status,
    durationSec: call.signals.durationSec,
    transcript: call.signals.transcript || null,
    summary: call.signals.summary || null,
    sentiment: sentimentOf(parsed),
    /* A money violation overrides whatever the call appeared to conclude. A quote built on top
       of a call where the wrong price was spoken would put the wrong figure in writing too. */
    actionTaken: money.ok ? classification.action : "handed_to_human",
  });

  /* ── THE CALL GOES INTO THE SHARED TRANSCRIPT ──
     Written here, immediately after the call row, and BEFORE any quote decision — so that if
     anything below fails the conversation still knows the call happened. Same ordering rule
     run-sales-agent.ts follows for an inbound message, and for the same reason.

     Until now a transcript lived only in `ai_telecall_logs` while the sales agent reads
     `ai_sales_conversations`, so a customer who spoke on the phone in the morning and messaged
     on WhatsApp in the evening met an agent that had never heard of the call. `loadSalesThread`
     already ignores channel — email and WhatsApp have always shared one thread — so the phone
     was the one channel missing from a memory that otherwise worked.

     Filed as `system` (a NOTE in the prompt), never `user`: a transcript is not something the
     customer typed, and the qualifier's `seats_source: "written"` rule turns on exactly that
     distinction. Fire-and-forget on failure — losing a transcript note must not cost the
     customer their reply. */
  if (recorded.ok && recorded.row && row.leadId) {
    try {
      await recordSalesTurn({
        tenantId: row.tenantId,
        leadId: row.leadId,
        channel: "whatsapp",
        customerContact: row.phoneNumber ?? "",
        role: "system",
        content: callTurnFor({
          transcript: call.signals.transcript || null,
          outcome: classification.status,
          seatsHeard: call.signals.seatsDiscussed ?? null,
          /* Null, always. `PostCallSignals` has no product field — the vendor reports seats,
             a disposition and a transcript, and nothing else. Deriving a product name from the
             transcript here would be the app inventing a fact about the call. */
          productHeard: null,
          durationSeconds: call.signals.durationSec ?? null,
        }),
      });
    } catch {
      /* Deliberately swallowed. The call row is already written and it is the record that
         matters; a missing thread note degrades the next reply rather than losing anything. */
    }
  }

  if (!recorded.ok || !recorded.row) {
    /* 500 on purpose — this one IS worth retrying. Our database failed, the vendor still holds
       the transcript, and the next attempt may well succeed. */
    console.error("[telecall-webhook] could not record the outcome:", recorded.error);
    return NextResponse.json({ error: "could not record the call" }, { status: 500 });
  }

  const admin = createAdminClient();

  /* ── The timeline line a rep reads ────────────────────────────────────── */
  const noteParts = [`${TELECALLER_NAME} (AI call) — ${classification.detail}`];
  if (call.analysisMissing) {
    noteParts.push(
      "The vendor sent no post-call analysis, so nothing was concluded from this call " +
      "automatically — read the transcript on the call record.",
    );
  }
  if (!money.ok) noteParts.push(`⚠ ${money.handoverReason}`);
  /* R-1437: the suggestion, in the line the rep reads. Not written into the lead's fields —
     a person confirms it (Abhishek, 14 Oct 2026). */
  if (call.provider === "bolna" && call.signals.seatsDiscussed !== null) {
    noteParts.push(`Suggestion: the AI heard ${call.signals.seatsDiscussed} seats — if that is right, Edit the lead and fill it in.`);
  }

  if (row.leadId) {
    await admin.from("lead_activities").insert({
      tenant_id: row.tenantId,
      lead_id: row.leadId,
      kind: "note",
      detail: noteParts.join(" "),
    }).then(
      () => undefined,
      (err: unknown) => console.error("[telecall-webhook] timeline note failed:", err),
    );
  }

  /* ── Acting on it, at most once ───────────────────────────────────────── */
  if (recorded.row.alreadyFinished) {
    /* The vendor retried a call we have already acted on. The record above is still refreshed —
       a later retry can carry a longer transcript — but nothing is done twice. Without this, one
       conversation becomes two quotations. */
    await logAiAction({
      tenantId: row.tenantId, action: "telecall.place", outcome: "skipped",
      reason: "the post-call webhook arrived again for a call already acted on — the record was " +
              "refreshed and nothing was repeated",
      mode: "auto", entity: "telecall", entityId: row.id,
    });
    return NextResponse.json({ ok: true, outcome: classification.status, repeated: true });
  }

  const handoverReason = money.ok ? classification.handoverReason : money.handoverReason;

  if (handoverReason && row.leadId) {
    const flagged = await flagLeadForHumanAttention({
      tenantId: row.tenantId,
      leadId: row.leadId,
      reason: handoverReason,
    });
    if (!flagged.ok) {
      console.error("[telecall-webhook] could not flag the lead:", flagged.error);
    }
    await logAiAction({
      tenantId: row.tenantId, action: "telecall.place", outcome: "held",
      reason: handoverReason, mode: "auto", entity: "lead", entityId: row.leadId,
    });
    return NextResponse.json({ ok: true, outcome: classification.status, action: "handed_to_human" });
  }

  /* ── R-1437: Bolna calls SUGGEST, a person decides ───────────────────────
     Abhishek's decision (14 Oct 2026): what the voice agent heard is shown to the salesperson
     and saved only when they confirm it — no quote is drafted off a phone line automatically.
     So a Bolna call that asked for a quote hands the lead to a person, with what was heard. */
  if (call.provider === "bolna" && classification.action === "quote_requested" && row.leadId) {
    const heard = call.signals.seatsDiscussed;
    const reason =
      "AI call: the customer asked for a quote" +
      (heard !== null ? ` — the AI heard ${heard} seats` : "") +
      ". Check the seats and plan, then make and send the quote.";
    const flagged = await flagLeadForHumanAttention({ tenantId: row.tenantId, leadId: row.leadId, reason });
    if (!flagged.ok) console.error("[telecall-webhook] could not flag the lead:", flagged.error);
    await logAiAction({
      tenantId: row.tenantId, action: "telecall.place", outcome: "held",
      reason, mode: "auto", entity: "lead", entityId: row.leadId,
    });
    return NextResponse.json({ ok: true, outcome: classification.status, action: "suggested_to_human" });
  }

  if (classification.action === "quote_requested" && row.leadId && money.ok) {
    /* ── The quotation ────────────────────────────────────────────────────
       Through `dispatchSalesDecision`, not through a second quote path built here. That
       function owns the seat ceiling, the catalogue lookup, the `next_document_number`
       allocation and — the part that matters most — the `reply.send` dial. So a quotation
       arising from a phone call is gated exactly as one arising from an email, and turning
       telecalling on cannot become a way around the brake on writing to customers.

       The decision object is assembled from what the CALL established rather than from a model
       run: the conversation already happened, and re-asking a text model to decide what a voice
       agent concluded would be a second opinion nobody wants. */
    const [catalogue, lead] = await Promise.all([
      loadSalesCatalog(admin, row.tenantId),
      admin.from("leads")
        .select("company, contact_email, plan, seats")
        .eq("tenant_id", row.tenantId).eq("id", row.leadId).maybeSingle(),
    ]);

    const contactEmail = lead.data?.contact_email?.trim() ?? "";
    const seats = call.signals.seatsDiscussed ?? lead.data?.seats ?? null;

    if (!contactEmail) {
      /* We have a phone number and no email. The quote path sends mail, so this cannot proceed —
         and it is worth a person's attention rather than a silent drop: the customer asked for
         something on a call and would otherwise never hear back. */
      const reason =
        "the customer asked for a quotation on the call, but this lead has no email address — " +
        "get one, or send it on WhatsApp by hand";
      await flagLeadForHumanAttention({ tenantId: row.tenantId, leadId: row.leadId, reason });
      await logAiAction({
        tenantId: row.tenantId, action: "telecall.place", outcome: "held",
        reason, mode: "auto", entity: "lead", entityId: row.leadId,
      });
      return NextResponse.json({ ok: true, outcome: classification.status, action: "handed_to_human" });
    }

    const decision: SalesAgentDecision = {
      customer_intent: `asked for a quotation on a phone call with ${TELECALLER_NAME}`,
      perceived_sentiment: sentimentOf(parsed) ?? "unknown",
      /* 1 is not flattery. The customer said this out loud to a person-shaped agent and the
         app is not guessing at intent from prose.

         ─── AND THE SENTENCE THAT USED TO BE HERE WAS FALSE ───────────────────
         It said "the uncertainty in this path is the seat count, and that is checked above".
         Nothing above checked it. `verifyCallMoney` checks MONEY figures in the transcript and
         `classifyCall` checks how the call ended; the seat count went to the quote path
         unguarded, from a live phone line, where "twenty" and "twelve" are one syllable apart.
         `heardNotWritten` is now passed below, which is the guard the comment claimed. */
      confidence_score: 1,
      action_required: "GENERATE_QUOTE_AND_SEND",
      /* Null because this path never hands over — the action above is fixed, and there is no
         model here to have a reason. Set explicitly rather than left to a default, so a future
         handover branch on this path has to decide what to say. */
      handover_reason: null,
      generated_response: {
        email_subject: "The quotation you asked for on our call",
        body_text:
          `Thank you for speaking with us today.\n\n` +
          `As promised on the call, the quotation is attached. The pricing on it is per seat ` +
          `per year, and GST is shown separately.\n\n` +
          `If anything on it does not match what we discussed, reply to this email and we will ` +
          `correct it.`,
        whatsapp_summary:
          "Thank you for your time on the call — the quotation we discussed is on its way to " +
          "your email. Reply here if anything needs changing.",
      },
      next_followup_loop: {
        in_hours: 48,
        trigger_condition: "quotation sent after a phone call; no reply yet",
      },
      seats_discussed: seats,
    term_discussed: null,
    };

    const dispatched = await dispatchSalesDecision({
      admin,
      tenantId: row.tenantId,
      leadId: row.leadId,
      company: lead.data?.company ?? "",
      customerContact: contactEmail,
      channel: "email",
      decision,
      /* `reply.send`, not a telecall-specific action. What is being gated here is the app
         writing to a customer, which is the permission that dial already describes — a second
         entry meaning the same thing would be a control the operator has to find twice. */
      sendAction: "reply.send",
      overruled: false,
      overruleReason: "",
      seats,
      /* `loadSalesCatalog` returns per-seat-per-YEAR figures (SalesCatalogEntry); the quote
         path takes `CatalogueItemPrice`, whose `msrp` is that same annual rate. The mapping is
         identical to run-sales-agent.ts's, deliberately — the two paths must hand the quote
         builder the same numbers, and 24 Aug proved what happens when one of them converts
         units and the other does not. */
      catalogue: catalogue.map((c) => ({
        id: c.sku,
        name: c.name,
        msrp: c.msrpPerSeatPerYear,
        wholesale: c.wholesalePerSeatPerYear,
      })),
      leadPlan: lead.data?.plan ?? null,
      /* THE SEAT COUNT CAME OFF A PHONE LINE. Strictly less reliable than the voice note this
         flag was built for — crosstalk, accents, line quality — so the same refusal applies and
         with more reason. It can only HOLD a quote, never send one: decideAutoSend drafts and
         prices it in full and asks a person to confirm the number. Absent until 25 Aug 2026,
         while a comment four lines up claimed the check existed. */
      heardNotWritten: true,
      fromEmail: FROM_EMAIL,
      senderIsOurs: false,
      isSelfTest: false,
    });

    return NextResponse.json({
      ok: true,
      outcome: classification.status,
      action: classification.action,
      quote: dispatched.outcome,
      detail: dispatched.detail,
    });
  }

  return NextResponse.json({
    ok: true,
    outcome: classification.status,
    action: classification.action,
  });
}
