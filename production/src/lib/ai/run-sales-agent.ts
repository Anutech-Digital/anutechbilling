/**
 * One inbound message, end to end: remember it, understand it, act on it, plan the next step.
 *
 * This is what the webhook calls. It REPLACES `runAutoReply` at both inbound-email branches,
 * and that is a deliberate swap rather than an addition — two drafters on one webhook means
 * two replies to one customer, which is the trust failure this repo cares most about. The
 * agent is a superset: same reply, plus a transcript, a quote decision, a handover rule and a
 * scheduled follow-up.
 *
 * ─── IT INHERITS THE THREE GATES runAutoReply FOUGHT FOR, BY REUSING THEM ────
 * `decideAutoReply` is called here with the agent's draft, unchanged. Its seven conditions are
 * the accumulated scar tissue of this path and none of them is re-derived:
 *
 *   theyWroteLast     — if OUR message is newest, nobody is waiting and a reply is the app
 *                       talking to itself in public
 *   alreadyReplied    — an outbound already newer than this inbound means this mail is answered
 *   humanIsHandlingIt — a PERSON touched the thread since the customer wrote, and a machine
 *                       chiming in over a colleague is worse than silence
 *
 * The three FACTS are gathered again below because `run-auto-reply.ts` keeps them inline and
 * `human-touch.test.ts` asserts on that file's source shape — extracting them would break a
 * test that exists to protect a subtle fix. So the queries are repeated and the DECISION is
 * not, which is the right half to duplicate. The `created_by IS NOT NULL` filter is the subtle
 * fix in question: every automated write here leaves it NULL, so without it the app's own
 * timeline notes count as "a person picked this up" and the reply holds with a wrong REASON.
 *
 * ─── ORDER OF OPERATIONS, AND WHY ───────────────────────────────────────────
 * 1. Record the customer's turn FIRST. If anything below fails, the message is still in the
 *    transcript and the next reply has it as context.
 * 2. Cancel any pending follow-up. They wrote — chasing them now would be pestering, and
 *    cancelling here means the row is gone before the cron can ever see it.
 * 3. Run the agent, apply the hard rules.
 * 4. Dispatch (or hand over).
 * 5. Schedule the next follow-up, if the agent asked for one.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { decideAutoReply } from "./auto-reply";
import { businessDomainFromEmail } from "@/lib/leads/grading";
/* `loadSalesCatalog` is deliberately NOT imported here any more. `runSalesAgent` calls it
   itself (sales-agent.server.ts:432) to build the PROMPT, where per-year is the right unit.
   This file's only remaining need was the QUOTE path, and converting the agent's per-year
   view back down is exactly what produced the twelvefold quote — see the read below. */
import { runSalesAgent, recordSalesTurn } from "./sales-agent.server";
import { findBillingTerm } from "@/lib/inbound/extract";
import { dispatchSalesDecision } from "./actions/quote-dispatcher";
import { cancelPendingLoops, scheduleSalesLoop } from "./sales-loops.server";
import { logAiAction } from "./autonomy.server";
import type { SalesChannel } from "./sales-agent";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";
import { quoteWasDelivered } from "@/lib/quotes/quote-delivered";

type Admin = ReturnType<typeof createAdminClient>;

function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface RunSalesAgentArgs {
  admin: Admin;
  tenantId: string;
  leadId: string;
  /** The customer's message, quoted thread already stripped by the caller. */
  incoming: string;
  /**
   * The subject line the customer used. Threaded through so the reply carries `Re: <it>`.
   *
   * On 31 Aug 2026 a mail whose whole request WAS its subject got a correct answer in 13
   * seconds — under a subject the model invented. Gmail filed it away from the thread the
   * owner was watching, and he reported it as "no reply came". From where he sat, that was
   * true: a reply outside its own thread is indistinguishable from silence.
   */
  incomingSubject?: string | null;
  /** Where the message came from, and where a reply would go. */
  customerContact: string;
  channel: SalesChannel;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  fromEmail: string;
  sellerName: string;
  /**
   * The enquiry arrived as a VOICE NOTE and `incoming` is a machine transcription.
   *
   * Threaded all the way to decideAutoSend rather than handled at the edge, because the
   * fact it changes is about the QUOTE — a seat count nobody typed — and the quote is built
   * four calls away from here. See lib/voice/voice-note.ts.
   */
  heardNotWritten?: boolean;
}

/**
 * Never throws. Called fire-and-forget from a webhook the provider is waiting on: the lead and
 * the message are committed before this runs, and losing a captured enquiry to protect a reply
 * would be the wrong trade — the provider would retry, the messageId claim would skip it as a
 * duplicate, and the mail would be gone.
 */
export async function runSalesAgentForLead(args: RunSalesAgentArgs): Promise<void> {
  /* ── "Never throws" is a PROMISE, and nothing was keeping it ────────────────
     The docstring above has said this since the function was written, and the body was never
     wrapped. Both call sites are `void runSalesAgentForLead(...)` with a `.catch` that goes to
     console — which on Cloud Run means the operator sees nothing at all.

     Measured 27 Aug 2026, 00:09. A customer replied "monthly", the requote ran and produced a
     correct monthly quote, and the agent left NO row in `ai_action_log` — not held, not
     failed, nothing. Every early return in here logs, so the only remaining explanation was a
     throw, and the throw was invisible. I could not tell WHAT crashed, only that something
     had; `gcloud` could not read the container log either.

     So a crash now lands where every other outcome lands. The reason string carries the
     message because the alternative — "sales agent crashed" — is the same dead end again, one
     step further in. */
  try {
    await runSalesAgentForLeadInner(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[run-sales-agent] crashed:", err);
    try {
      await logAiAction({
        tenantId: args.tenantId,
        action: "reply.send",
        outcome: "failed",
        reason: `the sales agent crashed before it could answer — ${message}`,
        mode: "hold",
        entity: "lead",
        entityId: args.leadId,
        facts: { channel: args.channel },
      });
    } catch (logErr) {
      /* The log is the last thing standing; if it fails too there is nowhere left to put
         this, and throwing here would break the "never throws" contract all over again. */
      console.error("[run-sales-agent] could not even log the crash:", logErr);
    }
  }
}

async function runSalesAgentForLeadInner(args: RunSalesAgentArgs): Promise<void> {
  const db = bare();
  if (!db) return;

  /* ── 0. The lead's own facts, read here rather than threaded through the webhook ──
     The two call sites sit in different branches with different variables in scope (`lf` on
     the append branch, the freshly-inserted row on create), and passing four fields from each
     is four chances for the branches to disagree about the same lead. One read here is also
     the FRESHER one: the append branch applies the reply's corrections — seats 20 → 50 — a few
     lines before calling this, and re-reading picks those up rather than the pre-correction
     values. */
  const { data: leadRow } = await args.admin
    .from("leads")
    .select("company, contact_name, seats, plan, gstin, domain")
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  const lead = (leadRow ?? {}) as {
    company?: string | null;
    contact_name?: string | null;
    seats?: number | null;
    plan?: string | null;
    gstin?: string | null;
    domain?: string | null;
  };
  const company = lead.company ?? "Customer";
  const contactName = lead.contact_name ?? "";
  const seats = lead.seats ?? null;
  const leadPlan = lead.plan ?? null;

  /* ── 1. The customer's turn goes in first ── */
  await recordSalesTurn({
    tenantId: args.tenantId,
    leadId: args.leadId,
    channel: args.channel,
    customerContact: args.customerContact,
    role: "user",
    content: args.incoming,
  });

  /* ── 2. They wrote, so nothing should be chasing them ── */
  await cancelPendingLoops({
    tenantId: args.tenantId,
    leadId: args.leadId,
    reason: "the customer wrote back",
  });

  /* ── 3. Understand it ── */
  const quote = await latestQuote(args.admin, args.tenantId, args.leadId);

  const run = await runSalesAgent({
    admin: args.admin,
    tenantId: args.tenantId,
    lead: {
      leadId: args.leadId,
      company,
      contactName,
      seats,
      plan: leadPlan,
      customerContact: args.customerContact,
      channel: args.channel,
      existingQuoteId: quote.id,
      deliveredQuoteId: quote.deliveredId,
      gstin: lead.gstin ?? null,
    },
    incoming: args.incoming,
    sellerName: args.sellerName,
    sellerEmail: args.fromEmail,
    extraAuthorisedTotals: quote.totals,
    /* The customer's own domain, so the agent can observe what their mail runs on today. The
       lookup and its guard live in sales-agent.server.ts — see observeDomain there.

       ─── THE COLUMN IS EMPTY ON EVERY LEAD THIS PATH EVER SEES ────────────────
       Measured 25 Aug 2026: all 28 leads in the live table have `domain` NULL. It is only ever
       written by the trial and public-checkout routes, which ask for it on a form — and this
       function runs on leads created by the inbound EMAIL and WHATSAPP webhooks, which never
       set it. So `observeDomain` has been receiving null on every real run, and the domain
       observation and the switch/trade-in block have never once fired on the path they were
       built for. Both looked finished and both were dark.

       The domain was in the contact address the whole time. `businessDomainFromEmail` returns
       null for a free mailbox rather than "gmail.com", because that domain is Google's and not
       theirs — telling a customer what gmail.com's MX says would be a machine reading the
       obvious back to them, and no part of a switch conversation applies to it.

       The column still wins when it is set: a domain somebody typed on the checkout form is a
       deliberate statement, while one derived from a `From:` header is an inference — and a
       contact may well write from a different domain than the one they are buying for. */
    domain: lead.domain?.trim() || businessDomainFromEmail(args.customerContact),
    /* Now needed TWICE and by two different guards. decideAutoSend uses it to refuse a quote
       built on a transcribed seat count; the qualifier uses it to refuse trusting one in the
       first place. Threading it here rather than only at the dispatcher means the doubt reaches
       the stage that could have prevented the draft, not just the one that stops it going. */
    heardNotWritten: args.heardNotWritten,
  });

  if (!run.ok) {
    /* The specific reason on the timeline. "The AI sales agent has no Gemini key" is fixed on
       a settings page; "agent failed" is fixed by asking an engineer. */
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      kind: "note",
      detail: `AI sales agent could not answer this message — ${run.reason}`,
    });
    await logAiAction({
      tenantId: args.tenantId,
      action: "reply.send",
      outcome: "failed",
      reason: run.reason,
      mode: "hold",
      entity: "lead",
      entityId: args.leadId,
      facts: { channel: args.channel },
    });
    return;
  }

  /* ── 4. The inherited gates. Skipped for a handover, which sends nothing anyway ── */
  if (run.decision.action_required !== "HANDOVER_TO_HUMAN") {
    const gate = await checkReplyGates({
      db,
      tenantId: args.tenantId,
      leadId: args.leadId,
      senderIsOurs: args.senderIsOurs,
      isSelfTest: args.isSelfTest,
      draft: {
        subject: run.decision.generated_response.email_subject,
        message: run.decision.generated_response.body_text,
      },
    });

    if (!gate.send) {
      /* The draft on the timeline, where an operator already looks. A held reply that only
         logged "held" would say it happened and never what it would have said. */
      await args.admin.from("lead_activities").insert({
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        kind: "note",
        detail:
          `AI sales agent drafted a reply and did NOT send it — ${gate.reason}\n\n` +
          `Subject: ${run.decision.generated_response.email_subject}\n\n` +
          run.decision.generated_response.body_text,
      });
      await logAiAction({
        tenantId: args.tenantId,
        action: "reply.send",
        outcome: "held",
        reason: gate.reason,
        mode: "hold",
        entity: "lead",
        entityId: args.leadId,
        facts: {
          channel: args.channel,
          intent: run.decision.customer_intent,
          confidence: run.decision.confidence_score,
        },
      });
      return;
    }
  }

  /* ── 5. Act ── */
  /* ── READ THE ROWS, DO NOT CONVERT THE AGENT'S VIEW ─────────────────────────
     This block used to be:

         .map((c) => ({ ..., msrp: c.msrpPerSeatPerYear, wholesale: c.wholesalePerSeatPerYear }))

     `CatalogueItemPrice.msrp` is ₹/seat/MONTH. `msrpPerSeatPerYear` is ₹/seat/YEAR. Assigning
     one to the other type-checks perfectly — both are `number`, and the unit lives only in a
     comment — and then `planQuoteFromEnquiry` multiplies the annual term by 12 again.

     Measured 27 Aug 2026 on Q-ADPL-2026-27-0027: 40 seats at ₹38,880/seat/year (= 3,240 × 12)
     for ₹17,80,082, where the right figure was ₹1,48,340. TWELVE TIMES. It never reached the
     customer only because `quote.send` happened to be on hold.

     So the conversion is gone rather than corrected. The quote path now reads the same rows,
     the same way, as the webhook's own quote path (route.ts:689) — one shape, one source, no
     arithmetic in between. A ÷12 here would have been the same bug waiting for a rounding
     case; the fix for a unit mismatch is to stop crossing the unit, not to cross it carefully.

     `is_active` only, matching that other path exactly, so an agent-built quote and a
     webhook-built quote for the same product cannot come from different rows. */
  const { data: rawItems } = await args.admin
    .from("items")
    .select("id, name, msrp, wholesale, prices")
    .eq("tenant_id", args.tenantId)
    .eq("is_active", true);
  const catalogue = (rawItems ?? []) as CatalogueItemPrice[];

  const dispatched = await dispatchSalesDecision({
    admin: args.admin,
    tenantId: args.tenantId,
    leadId: args.leadId,
    company,
    customerContact: args.customerContact,
    channel: args.channel,
    incomingSubject: args.incomingSubject,
    /* Sirf DELIVERED — draft ka number na batao, na uska PDF bhejo. */
    deliveredQuoteId: quote.deliveredId,
    decision: run.decision,
    sendAction: "reply.send",
    overruled: run.overruled,
    overruleReason: run.overruleReason,
    seats,
    catalogue,
    leadPlan,
    /* ── THE TERM THE CUSTOMER ACTUALLY WROTE ────────────────────────────────
       The dispatcher used to hardcode annual. On 30 Aug 2026 the app asked "monthly or
       annual?", the customer answered "monthly", and the reply quoted Rs 325 per seat per
       MONTH while the document attached to it was raised for a YEAR. The words and the
       document disagreed, and the document is the half a customer keeps.

       `findBillingTerm` is the inbound path's own reader, not a second keyword search —
       so what this hears and what the webhook hears cannot drift apart. Null still means
       annual; only an explicit term changes anything. */
    term: findBillingTerm(args.incoming).value,
    termSource: findBillingTerm(args.incoming).source,
    fromEmail: args.fromEmail,
    senderIsOurs: args.senderIsOurs,
    isSelfTest: args.isSelfTest,
    heardNotWritten: args.heardNotWritten,
  });

  /* ── 6. Plan the next touch ── */
  if (dispatched.followUp) {
    await scheduleSalesLoop({
      tenantId: args.tenantId,
      leadId: args.leadId,
      inHours: dispatched.followUp.inHours,
      triggerCondition: dispatched.followUp.triggerCondition,
    });
  }
}

/**
 * The newest quote on this lead — its id, so the agent does not offer a second one, and its
 * FIGURES, so the agent may state the amount it is writing a covering email about.
 *
 * The figures matter as much as the id. Until 24 Aug 2026 the agent could name the quote by
 * number and not say what it was for: a total is arithmetic, arithmetic is not authorised, and
 * every quote email handed over. These two numbers come from the quote row itself — computed by
 * planQuoteFromEnquiry, not by the model — so they are facts, not guesses.
 */
async function latestQuote(
  admin: Admin,
  tenantId: string,
  leadId: string,
): Promise<{ id: string | null; deliveredId: string | null; totals: number[] }> {
  const { data } = await admin
    .from("quotes")
    .select("id, status, subtotal, amount")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .order("created_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as
    { id?: string; status?: string | null; subtotal?: number | null; amount?: number | null } | null;
  if (!row?.id) return { id: null, deliveredId: null, totals: [] };

  /* Both, because a covering email legitimately says either the pre-GST subtotal or the gross.
     Zero and null are dropped rather than authorised: "0" is already always allowed by the
     money guard, and a null figure is a quote that was not priced. */
  const totals = [row.subtotal, row.amount].flatMap((n) =>
    typeof n === "number" && n > 0 ? [Math.round(n)] : [],
  );
  /* TWO ids, because they license different sentences. `id` stops the agent raising a second
     quotation; `deliveredId` is the only one that lets it tell the customer a reference
     number. On 31 Aug 2026 a DRAFT filled both roles, and the customer was handed the number
     of a document that had never been sent — see lib/quotes/quote-delivered.ts. */
  return {
    id: row.id,
    deliveredId: quoteWasDelivered(row.status) ? row.id : null,
    totals,
  };
}

/**
 * The three facts `decideAutoReply` needs, read fresh.
 *
 * See the file header for why these queries are repeated from run-auto-reply.ts rather than
 * extracted: `human-touch.test.ts` pins that file's source shape to protect the
 * `created_by IS NOT NULL` fix, and moving the code would break the test guarding it.
 */
async function checkReplyGates(args: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  draft: { subject: string; message: string };
}): Promise<{ send: boolean; reason: string }> {
  const { db, tenantId, leadId } = args;

  const { data: inboundLatest } = await db
    .from("inbound_emails")
    .select("created_at, status")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .neq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const { data: outbound } = await db
    .from("inbound_emails")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const lastIn = (inboundLatest ?? [])[0] as { created_at?: string } | undefined;
  const lastOut = (outbound ?? [])[0] as { created_at?: string } | undefined;

  const alreadyReplied = Boolean(
    lastOut?.created_at && lastIn?.created_at && lastOut.created_at > lastIn.created_at,
  );

  /* A PERSON, not this app's own footprints. `created_by IS NOT NULL` is the whole fix:
     automated writes here leave it NULL (the bare service-role client cannot know a user)
     while anything a human does goes through the `log_lead_activity` RPC, which stamps
     `auth.uid()`. Without it, the webhook's own note — written a fraction of a second
     earlier — counts as a colleague and the reply holds saying somebody picked the thread up
     when nobody had. */
  const { data: humanTouch } = await db
    .from("lead_activities")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .in("kind", ["call", "whatsapp", "note", "email_out"])
    .not("created_by", "is", null)
    .gt("created_at", lastIn?.created_at ?? "1970-01-01")
    .limit(1);

  const decision = decideAutoReply({
    senderIsOurs: args.senderIsOurs,
    isSelfTest: args.isSelfTest,
    /* The customer's message is what triggered this run and it was just recorded, so they
       wrote last unless an outbound landed after it. */
    theyWroteLast: !alreadyReplied,
    alreadyReplied,
    humanIsHandlingIt: (humanTouch ?? []).length > 0,
    draft: args.draft,
    /* The agent only ever writes for THIS lead — there is no template path. A generic
       fallback is exactly what `runSalesAgent` refuses to produce: with no key or no
       catalogue it returns `ok: false` and this function is never reached. */
    draftIsForThisLead: true,
    /* `applyHandoverRules` has already checked this draft's money against the CATALOGUE and
       its promises against the three kinds no price list can excuse, and would have overruled
       the model to HANDOVER_TO_HUMAN on any failure — so a draft that reaches here has passed
       a stricter check than `findPromises` can make.

       Without this the gate refused every priced reply, and because it sits UPSTREAM of the
       dispatcher it did so at ANY dial setting: `reply.send = auto` would have changed
       nothing. Measured on the first live enquiry, 24 Aug 2026 — see the field's own comment
       in auto-reply.ts. The other six conditions in `decideAutoReply` still run, and they are
       the ones this path needs it for. */
    promisesAlreadyChecked: true,
  });

  return { send: decision.send, reason: decision.reason };
}
