/**
 * AI sales follow-up cron — drains `ai_sales_loops`.
 *
 * Schedule: hourly, via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh). NOT vercel.json
 * — the live deployment is Cloud Run, where Vercel crons do not exist and that file is inert.
 * Local dev: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/ai-sales-loop`.
 *
 * Hourly, not daily, because the agent schedules in HOURS (SALES_AGENT_SCHEMA bounds
 * in_hours at 1..720). A daily sweep would round every "chase them this afternoon" up to a
 * day and make the shortest useful follow-up impossible to express.
 *
 * What it does, for each due row:
 *   1. Re-read the lead. `shouldNudge` then decides whether the row is DUE or merely STALE —
 *      the customer may have replied, the deal may be won or lost, a person may have taken
 *      it over. See lib/ai/sales-loops.ts for why a timestamp comparison cannot know this.
 *   2. If it should nudge: run the agent with the trigger condition as its brief, and
 *      dispatch through the same path an inbound message uses.
 *   3. Close the row either way, with the outcome in words.
 *
 * ─── THE BRAKE APPLIES HERE TOO ─────────────────────────────────────────────
 * Every send goes through `dispatchSalesDecision`, so the autonomy dial and the kill switch
 * gate this cron exactly as they gate the webhook. `followup.send` is the action, and it
 * ships as `hold` — see lib/ai/autonomy.ts. Until somebody moves that dial this cron drafts
 * follow-ups onto lead timelines and sends nothing, which is the intended first state.
 *
 * ─── ONE LEAD CAN NEVER BE NUDGED TWICE BY ONE RUN ──────────────────────────
 * A unique partial index on (tenant_id, lead_id) WHERE status='pending' means one pending row
 * per lead, so the due list cannot contain the same lead twice. Idempotency across runs comes
 * from closing the row before the next sweep can see it.
 */
import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { runSalesAgent, loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchSalesDecision } from "@/lib/ai/actions/quote-dispatcher";
import { shouldNudge } from "@/lib/ai/sales-loops";
import { CADENCE, decideStep, expiryFact, nextStep, nextStepAt } from "@/lib/ai/cadence";
import {
  closeLoop,
  lastCustomerMessageAt,
  loadDueLoops,
  loadLoopLead,
  scheduleSalesLoop,
} from "@/lib/ai/sales-loops.server";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bounded so one run cannot become an unbounded fan-out of model calls. */
const MAX_PER_RUN = 25;

const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

interface LoopOutcome {
  lead_id: string;
  result: string;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The reseller's own day-4 write-up, or null.
 *
 * Cached per sweep. Null covers both "no row" and "column empty", which are the same thing
 * here: nobody has written one, so `decideStep` skips that step rather than letting the model
 * invent a case study. See lib/ai/cadence.ts.
 */
async function valueDropFor(
  admin: Admin,
  tenantId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const hit = cache.get(tenantId);
  if (hit !== undefined) return hit;

  const { data } = await admin
    .from("tenants")
    .select("followup_value_drop")
    .eq("id", tenantId)
    .maybeSingle();

  const text = (data as { followup_value_drop?: string | null } | null)?.followup_value_drop ?? null;
  const value = text && text.trim() ? text.trim() : null;
  cache.set(tenantId, value);
  return value;
}

/**
 * When this lead was quoted, and when that quote runs out.
 *
 * The cadence is anchored to the quote date so a slipped cron cannot compress the tail, and
 * the expiry step needs the real date rather than an assertion — the window is seven days
 * today and an asserted "tomorrow" would become a lie the moment somebody changed it.
 */
async function latestQuoteFor(
  admin: Admin,
  tenantId: string,
  leadId: string,
): Promise<{ createdAt: Date | null; expiresOn: string | null; settled: boolean }> {
  const { data } = await admin
    .from("quotes")
    .select("created_date, expires_date, status, payment_status")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .order("created_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as {
    created_date?: string | null; expires_date?: string | null;
    status?: string | null; payment_status?: string | null;
  } | null;
  const created = row?.created_date ? new Date(`${row.created_date}T00:00:00Z`) : null;
  return {
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    expiresOn: row?.expires_date ?? null,
    /* R-115: yes, no or paid ends the chase — see shouldNudge. */
    settled:
      row?.status === "accepted" || row?.status === "rejected" || row?.payment_status === "paid",
  };
}

/**
 * Write the next step of the cadence, or nothing when the sequence is finished.
 *
 * Safe to call after the current row has been closed — that is the point. One pending row per
 * lead is enforced by a unique partial index, and the cadence being a step counter rather than
 * four rows written on day one is what keeps that index intact. See lib/ai/cadence.ts.
 */
async function chainNextStep(
  loop: { tenantId: string; leadId: string; step: number },
  quotedAt: Date,
  agentReason: string | null = null,
): Promise<void> {
  const next = nextStep(loop.step);
  const at = nextStepAt(quotedAt, loop.step);
  if (!next || !at) return; // cadence finished

  const hours = Math.max(1, Math.round((at.getTime() - Date.now()) / 3_600_000));
  await scheduleSalesLoop({
    tenantId: loop.tenantId,
    leadId: loop.leadId,
    inHours: hours,
    step: next.step,
    channel: next.channel,
    /* The agent's own words when it offered some — "you said you needed the 20-seat figure
       before Thursday" beats anything a fixed schedule can produce. Its intent otherwise. */
    triggerCondition: agentReason ?? next.intent,
  });
}

interface CronResult {
  ran_at: string;
  due: number;
  nudged: number;
  skipped: number;
  failed: number;
  outcomes: LoopOutcome[];
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("ai-sales-loop", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

async function handle(req: Request): Promise<NextResponse<CronResult | { error: string }>> {
  /* ── Auth — FAIL CLOSED ──────────────────────────────────────────────────
     503, not 401, when the secret is absent: "this deployment has no cron secret" is a
     missing-infrastructure fact for whoever is deploying, and reporting it as "unauthorized"
     sends them looking for a wrong credential instead of an unset one. Matches the seven
     existing crons. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* 503 as well, and for the same reason: with no service-role key the sweep would read zero
     rows and report a clean run, which is an absence dressed as a success. */
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set — the follow-up sweep cannot read its own rows" },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  const now = new Date();
  const due = await loadDueLoops(MAX_PER_RUN, now);

  const result: CronResult = {
    ran_at: now.toISOString(),
    due: due.length,
    nudged: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
  };

  /* Catalogue per tenant, fetched once and reused — the due list is usually one workspace and
     re-reading `items` per lead would be a query per follow-up for no new information. */
  const catalogueByTenant = new Map<string, CatalogueItemPrice[]>();
  /* Cached per sweep for the same reason the catalogue is: a run usually touches one or two
     tenants and this is one row each. */
  const valueDropByTenant = new Map<string, string | null>();

  for (const loop of due) {
    /* R-897 */ if (!cronTenantAllowed(loop.tenantId)) continue;
    try {
      /* Bare client, because `requires_human_attention` is not in the generated Database type
         — see loadLoopLead. That flag is the reason this read exists at all. */
      const read = await loadLoopLead({ tenantId: loop.tenantId, leadId: loop.leadId });

      if (!read.ok) {
        /* The composite FK cascades on lead delete, so a missing lead here means the read
           failed rather than the lead being gone. Close the row anyway: a loop that cannot
           find its lead will not find it on the next run either, and leaving it pending would
           make it a permanent resident of every future sweep. */
        result.failed++;
        result.outcomes.push({
          lead_id: loop.leadId,
          result: `could not read the lead — ${read.error}`,
        });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `closed unactioned — the lead could not be read (${read.error})`,
        });
        continue;
      }

      const lead = read.lead;

      /* Read once and reused by decideStep, shouldNudge and the WhatsApp window check. Three
         separate reads of "when did they last write" could disagree inside one iteration. */
      const lastFromCustomer = await lastCustomerMessageAt({
        tenantId: loop.tenantId,
        leadId: loop.leadId,
      });

      /* The cadence is anchored to the QUOTE so a slipped cron cannot compress the tail — see
         nextStepAt. Falls back to when the loop row was written, which is what the pre-cadence
         rows have and is never later than the quote. */
      const quoteRow = await latestQuoteFor(admin, loop.tenantId, loop.leadId);
      const quotedAt = quoteRow.createdAt ?? loop.createdAt;
      const quoteExpiresOn = quoteRow.expiresOn;

      const valueDrop = await valueDropFor(admin, loop.tenantId, valueDropByTenant);

      const verdict = shouldNudge({
        stage: lead.stage,
        isJunk: lead.isJunk,
        requiresHumanAttention: lead.requiresHumanAttention,
        scheduledFrom: loop.createdAt,
        lastCustomerMessageAt: lastFromCustomer,
        quoteSettled: quoteRow.settled,
      });

      if (!verdict.nudge) {
        result.skipped++;
        result.outcomes.push({ lead_id: loop.leadId, result: `skipped — ${verdict.detail}` });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `no follow-up sent — ${verdict.detail}`,
        });
        /* On the timeline too. A follow-up that was scheduled and then deliberately not sent
           is a decision the operator should be able to see, not a silence. */
        await admin.from("lead_activities").insert({
          tenant_id: loop.tenantId,
          lead_id: loop.leadId,
          kind: "note",
          detail: `Automated follow-up cancelled — ${verdict.detail}`,
        });
        continue;
      }

      /* ── WHICH STEP OF THE CADENCE, AND CAN IT GO? ─────────────────────────
         `channel` used to be "email if there is an address, else WhatsApp". The cadence asks
         for a specific channel per step, and WhatsApp has a rule that a ternary cannot express:
         a free-form message more than 24 hours after the customer's last one is refused by
         Meta unless it is an approved template. `decideStep` owns all of that, plus the
         value-drop content check. See lib/ai/cadence.ts. */
      const outcome = decideStep({
        step: loop.step,
        valueDropContent: valueDrop,
        lastCustomerMessageAt: lastFromCustomer,
        now,
        /* No approved WhatsApp template exists on this deployment yet. When one does, this
           becomes a lookup and WhatsApp goes back to being primary for step 2 without the
           cadence changing. */
        templateApproved: false,
        hasEmail: Boolean(lead.contactEmail),
        hasPhone: Boolean(lead.contactPhone),
      });

      if (!outcome.fire) {
        result.skipped++;
        result.outcomes.push({ lead_id: loop.leadId, result: `skipped — ${outcome.reason}` });
        await closeLoop({ id: loop.id, tenantId: loop.tenantId, outcome: `no follow-up sent — ${outcome.reason}` });
        await admin.from("lead_activities").insert({
          tenant_id: loop.tenantId, lead_id: loop.leadId, kind: "note",
          detail: `Follow-up step ${loop.step} not sent — ${outcome.reason}`,
        });
        /* A SKIP still advances the cadence — an empty value-drop slot costs the lead one
           touch, not the rest of its sequence. A stop does not, because nothing can reach
           this lead and a rescheduled row would cycle forever. */
        if (outcome.skip) await chainNextStep(loop, quotedAt);
        continue;
      }

      const channel = outcome.channel;
      const contact = channel === "email" ? lead.contactEmail : lead.contactPhone;
      if (!contact) {
        /* Unreachable despite decideStep saying otherwise — belt and braces, because the two
           reads happen at different moments and a contact can be cleared in between. */
        result.skipped++;
        result.outcomes.push({ lead_id: loop.leadId, result: "skipped — no contact for the chosen channel" });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: "no follow-up sent — the lead has neither an email address nor a phone number",
        });
        continue;
      }

      if (!catalogueByTenant.has(loop.tenantId)) {
        const cat = await loadSalesCatalog(admin, loop.tenantId);
        catalogueByTenant.set(
          loop.tenantId,
          cat.map((c) => ({
            id: c.sku,
            name: c.name,
            msrp: c.msrpPerSeatPerYear,
            wholesale: c.wholesalePerSeatPerYear,
          })),
        );
      }
      const catalogue = catalogueByTenant.get(loop.tenantId) ?? [];

      /* The trigger condition IS the brief. Passed as the incoming message so the follow-up
         can refer to what it is following up on — the difference between "checking in" and
         "you mentioned you needed the 20-seat figure before Thursday". */
      const run = await runSalesAgent({
        admin,
        tenantId: loop.tenantId,
        lead: {
          leadId: lead.id,
          company: lead.company ?? "Customer",
          contactName: lead.contactName ?? "",
          seats: lead.seats,
          plan: lead.plan,
          customerContact: contact,
          channel,
          existingQuoteId: null,
          /* This cron chases a lead that has gone quiet; it never carries a delivered quote. */
          deliveredQuoteId: null,
        },
        /* The brief now carries the STEP's intent as well as the loop's own reason, plus —
           for the expiry step — the quote's real date. Nothing here asserts a date or a
           price: `expiryFact` reads `quotes.expires_date`, and the volume rate is a published
           rate card that does not expire. See cadence.ts for why both matter. */
        incoming: [
          `[INTERNAL FOLLOW-UP BRIEF — the customer has not written since. Write a short, ` +
            `useful follow-up. Do not pretend they replied.]`,
          `Step ${outcome.step.step} of ${CADENCE.length}, going out on ${channel}.`,
          outcome.step.intent,
          outcome.channelNote ? `Channel note: ${outcome.channelNote}` : "",
          outcome.step.kind === "value" && valueDrop ? `Our own write-up, use it as given:\n${valueDrop}` : "",
          outcome.step.kind === "expiry" ? expiryFact(quoteExpiresOn, now) ?? "" : "",
          loop.triggerCondition,
        ].filter(Boolean).join("\n"),
        sellerName: "ANUTECH DIGITAL PVT LTD",
        sellerEmail: FROM_EMAIL,
      });

      if (!run.ok) {
        result.failed++;
        result.outcomes.push({ lead_id: loop.leadId, result: `agent failed — ${run.reason}` });
        await admin.from("lead_activities").insert({
          tenant_id: loop.tenantId,
          lead_id: loop.leadId,
          kind: "note",
          detail: `Automated follow-up could not be written — ${run.reason}`,
        });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `follow-up not written — ${run.reason}`,
        });
        continue;
      }

      const dispatched = await dispatchSalesDecision({
        admin,
        tenantId: loop.tenantId,
        leadId: lead.id,
        company: lead.company ?? "Customer",
        customerContact: contact,
        channel,
        decision: run.decision,
        /* followup.send, NOT reply.send. Chasing somebody who chose not to answer is a
           different permission from answering somebody who just wrote — see DispatchArgs. */
        sendAction: "followup.send",
        overruled: run.overruled,
        overruleReason: run.overruleReason,
        seats: lead.seats,
        catalogue,
        leadPlan: lead.plan,
        fromEmail: FROM_EMAIL,
        senderIsOurs: false,
        isSelfTest: false,
      });

      if (dispatched.outcome === "failed") result.failed++;
      else result.nudged++;

      result.outcomes.push({ lead_id: loop.leadId, result: dispatched.detail });
      await closeLoop({
        id: loop.id,
        tenantId: loop.tenantId,
        outcome: `follow-up ${dispatched.outcome} — ${dispatched.detail}`,
      });

      /* ── ADVANCE THE CADENCE ────────────────────────────────────────────────
         The row above was closed, so there is no pending row to collide with the unique
         index — which is the whole reason the cadence is a step counter rather than four rows
         written on day one. See cadence.ts.

         The CADENCE decides the next step, not the model. The agent's own `followUp` request
         used to be the only source, and a model that forgot to ask meant the sequence silently
         ended after one touch. Its trigger_condition is still used when it offered one, because
         "you said you needed the 20-seat figure before Thursday" is better context than
         anything a fixed schedule can produce. */
      await chainNextStep(loop, quotedAt, dispatched.followUp?.triggerCondition ?? null);
    } catch (err) {
      /* One bad lead must not end the sweep. Twenty-four other customers are waiting behind
         it, and a throw here would leave every one of them pending until the next hour. */
      const why = err instanceof Error ? err.message : "unknown error";
      console.error(`[cron/ai-sales-loop] lead ${loop.leadId} crashed:`, err);
      result.failed++;
      result.outcomes.push({ lead_id: loop.leadId, result: `crashed — ${why}` });
      await closeLoop({
        id: loop.id,
        tenantId: loop.tenantId,
        outcome: `follow-up crashed — ${why}`,
      }).catch(() => undefined);
    }
  }

  return NextResponse.json(reportCron("ai-sales-loop", result));
}
