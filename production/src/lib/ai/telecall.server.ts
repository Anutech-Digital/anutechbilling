/**
 * The database side of telecalling: read what a call needs, write what it did.
 *
 * Split from `telecall.ts` for the reason every other agent module in here is split — the
 * decisions are what get argued about, and arguing about them should not require a database.
 *
 * ─── WHY A BARE CLIENT FOR ai_telecall_logs ─────────────────────────────────
 * The table is not in the generated `Database` type, and registering it is not a two-line fix.
 * Measured 23 Aug 2026 on `document_series`: adding ONE table to the Tables map took
 * `npm run typecheck` from 4 errors to 2,722, because supabase-js resolves row types through a
 * conditional chain that tips over the instantiation limit at this schema size and collapses
 * every table to `never`. `ai_autonomy` and `ai_action_log` are unregistered for the same
 * measured reason, and this follows their pattern rather than inventing a third.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every query below carries an
 * explicit `.eq("tenant_id", …)` and that line is the entire boundary between one workspace's
 * call transcripts and another's. `tenantId` always comes from the caller's resolved context —
 * an API key's tenant, or a cron's iteration — and never from a request body.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { TelecallAction, TelecallStatus, TelecallType } from "./telecall";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    /* `no-store` for the same reason autonomy.server.ts states it: a cached read of "have we
       already rung this number today" is a cached licence to ring them again. */
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface TelecallRowInput {
  tenantId: string;
  leadId: string | null;
  subscriptionId: string | null;
  callType: TelecallType;
  phoneNumber: string;
  status: TelecallStatus;
  provider: "retell" | "vapi" | "none";
  providerCallId: string | null;
  callPlan: Record<string, unknown>;
  autonomyMode: "off" | "hold" | "auto" | null;
  refusalReason: string | null;
}

export interface WriteResult {
  ok: boolean;
  id: string | null;
  error: string | null;
}

/**
 * File the attempt — placed, held or refused alike.
 *
 * Every outcome gets a row, including the ones where nothing was dialled. A held call that
 * left no trace would be indistinguishable from a cron that never ran, which is the same
 * failure `sendEmail` describes when it records a refusal in `email_log` rather than returning
 * quietly.
 */
export async function recordTelecall(input: TelecallRowInput): Promise<WriteResult> {
  const db = bare();
  if (!db) {
    console.error("[telecall] Supabase is not configured — the call attempt was not recorded");
    return { ok: false, id: null, error: "Supabase is not configured" };
  }

  const { data, error } = await db
    .from("ai_telecall_logs")
    .insert({
      tenant_id:        input.tenantId,
      lead_id:          input.leadId,
      subscription_id:  input.subscriptionId,
      call_type:        input.callType,
      phone_number:     input.phoneNumber,
      status:           input.status,
      provider:         input.provider,
      provider_call_id: input.providerCallId,
      call_plan:        input.callPlan,
      autonomy_mode:    input.autonomyMode,
      refusal_reason:   input.refusalReason,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[telecall] could not record the call:", error.message);
    return { ok: false, id: null, error: error.message };
  }

  const row = data as { id?: string } | null;
  return { ok: true, id: row?.id ?? null, error: null };
}

export interface FoundTelecall {
  id: string;
  tenantId: string;
  leadId: string | null;
  subscriptionId: string | null;
  callType: TelecallType;
  phoneNumber: string;
  status: TelecallStatus;
  /** The figures the agent was authorised to say, as recorded when the call was built. */
  authorisedFigures: number[];
}

/**
 * Find the call this webhook is about, by the vendor's own id.
 *
 * ─── WHY THIS DOES NOT FILTER BY TENANT, AND WHY THAT IS THE SAFE DIRECTION ─
 * It looks the row up by `provider_call_id` alone and returns the tenant the ROW says it
 * belongs to. That reads like a missing tenant filter and is the opposite.
 *
 * The alternative is to take `tenant_id` out of the webhook body — and the body is written by
 * whoever is POSTing. A signature makes it *authentic*, not *correct*: a compromised or simply
 * mis-scripted vendor agent could echo back a different workspace's id and this endpoint would
 * write a transcript, an outcome, and potentially a quotation into it. Reading the tenant off
 * a row THIS APP WROTE removes the question entirely — a caller can only ever reach a call we
 * ourselves placed.
 *
 * The id is the vendor's UUID, so a collision across tenants is not a practical concern; and
 * if two rows ever did match, `maybeSingle` errors rather than picking one, which is the right
 * failure.
 */
export async function findTelecallByProviderCallId(
  providerCallId: string,
): Promise<FoundTelecall | null> {
  const db = bare();
  if (!db) return null;

  const { data, error } = await db
    .from("ai_telecall_logs")
    .select("id, tenant_id, lead_id, subscription_id, call_type, phone_number, status, call_plan")
    .eq("provider_call_id", providerCallId)
    .maybeSingle();

  if (error) {
    console.error("[telecall] could not look up the call row:", error.message);
    return null;
  }
  if (!data) return null;

  const row = data as {
    id: string;
    tenant_id: string;
    lead_id: string | null;
    subscription_id: string | null;
    call_type: TelecallType;
    phone_number: string;
    status: TelecallStatus;
    call_plan: unknown;
  };

  /* The plan is jsonb, which is to say `unknown`. Read defensively: a row written before this
     field existed, or by a future version, must not crash the webhook that is trying to record
     what a customer was told. An empty list means "nothing was authorised", which makes the
     money check maximally strict rather than silently permissive. */
  const plan = typeof row.call_plan === "object" && row.call_plan !== null
    ? (row.call_plan as Record<string, unknown>)
    : {};
  const figures = Array.isArray(plan.authorised_figures)
    ? plan.authorised_figures.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];

  return {
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    subscriptionId: row.subscription_id,
    callType: row.call_type,
    phoneNumber: row.phone_number,
    status: row.status,
    authorisedFigures: figures,
  };
}

export interface TelecallOutcomeInput {
  tenantId: string;
  providerCallId: string;
  status: TelecallStatus;
  durationSec: number | null;
  transcript: string | null;
  summary: string | null;
  sentiment: string | null;
  actionTaken: TelecallAction;
}

export interface OutcomeRow {
  id: string;
  leadId: string | null;
  subscriptionId: string | null;
  callType: TelecallType;
  phoneNumber: string;
  /** True when this row had already been given an outcome before now. */
  alreadyFinished: boolean;
}

/**
 * Record what the call came to, against the row the dial created.
 *
 * ─── THE RETURN VALUE IS THE DEDUPE, AND IT MATTERS MORE THAN IT LOOKS ──────
 * Both vendors retry a post-call webhook when our response is slow or non-2xx. The unique
 * index on (tenant_id, provider_call_id) already stops a second ROW being created — but the
 * webhook's other job is to trigger a quotation, and a second quote for one conversation would
 * be created happily by an UPDATE that succeeded twice.
 *
 * So the row is read BEFORE it is written, and `alreadyFinished` tells the caller that this
 * conversation has been acted on. The caller updates the record either way (a later retry may
 * carry a longer transcript) and does not act twice.
 */
export async function recordTelecallOutcome(
  input: TelecallOutcomeInput,
): Promise<{ ok: boolean; row: OutcomeRow | null; error: string | null }> {
  const db = bare();
  if (!db) {
    return { ok: false, row: null, error: "Supabase is not configured" };
  }

  const { data: existing, error: readErr } = await db
    .from("ai_telecall_logs")
    .select("id, lead_id, subscription_id, call_type, phone_number, status, action_taken")
    .eq("tenant_id", input.tenantId)
    .eq("provider_call_id", input.providerCallId)
    .maybeSingle();

  if (readErr) {
    console.error("[telecall] could not read the call row:", readErr.message);
    return { ok: false, row: null, error: readErr.message };
  }
  if (!existing) {
    /* No row for this call id. Not an error to shout about: it is what a webhook for another
       deployment sharing the vendor account looks like, and also what a call placed by hand
       from the vendor's own dashboard looks like. Refusing it is correct; crashing is not. */
    return { ok: false, row: null, error: "no call row matches this provider call id" };
  }

  const prior = existing as {
    id: string;
    lead_id: string | null;
    subscription_id: string | null;
    call_type: TelecallType;
    phone_number: string;
    status: TelecallStatus;
    action_taken: TelecallAction;
  };

  /* "Already finished" means the row has left the queued/held state — not merely that it has
     an action. A retry landing on a `completed` row is the case worth protecting against. */
  const alreadyFinished = prior.status !== "queued" && prior.status !== "held";

  const { error: writeErr } = await db
    .from("ai_telecall_logs")
    .update({
      status:       input.status,
      duration_sec: input.durationSec,
      transcript:   input.transcript,
      summary:      input.summary,
      sentiment:    input.sentiment,
      action_taken: input.actionTaken,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", prior.id);

  if (writeErr) {
    console.error("[telecall] could not record the call outcome:", writeErr.message);
    return { ok: false, row: null, error: writeErr.message };
  }

  return {
    ok: true,
    row: {
      id: prior.id,
      leadId: prior.lead_id,
      subscriptionId: prior.subscription_id,
      callType: prior.call_type,
      phoneNumber: prior.phone_number,
      alreadyFinished,
    },
    error: null,
  };
}

/**
 * When did we last ring this number, and how many times have we tried this subject?
 *
 * Both answers in one query because they are asked together, on every attempt, and a second
 * round-trip per lead is what turns a 200-row cron into a slow one.
 *
 * Counted per NUMBER rather than per lead: two leads can share a switchboard, and the person
 * who picks up does not care which of our records the call came from.
 */
export async function callHistoryFor(
  tenantId: string,
  phoneNumber: string,
  sinceDays = 30,
): Promise<{ lastCalledAt: Date | null; attempts: number }> {
  const db = bare();
  if (!db) return { lastCalledAt: null, attempts: 0 };

  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data, error } = await db
    .from("ai_telecall_logs")
    .select("created_at, status")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    /* FAIL CLOSED, and this is the one place in this file where that direction is the
       interesting choice. If the history cannot be read, the app does not know whether it rang
       this person an hour ago — and "ring them again to be safe" is the wrong safety. Reporting
       a call `now` makes decideTelecall refuse on the 24-hour rule, which is the outcome that
       costs a delay rather than a complaint. */
    console.error("[telecall] could not read call history — treating as just-called:", error.message);
    return { lastCalledAt: new Date(), attempts: 0 };
  }

  const rows = (data ?? []) as Array<{ created_at: string; status: TelecallStatus }>;
  /* `held` and `refused` rows are not attempts — nothing was dialled and the customer's phone
     never rang. Counting them would let a switched-off dial exhaust the attempt budget, so
     turning automation ON would find every lead already used up. */
  const dialled = rows.filter((r) => r.status !== "held" && r.status !== "refused");

  const last = dialled[0]?.created_at;
  return {
    lastCalledAt: last ? new Date(last) : null,
    attempts: dialled.length,
  };
}
