/**
 * Reading and writing the follow-up loop rows. Decisions live in `sales-loops.ts`.
 *
 * Bare client for the same measured reason as `sales-agent.server.ts`: `ai_sales_loops` is
 * not in the generated `Database` type, and registering one table took typecheck from 4
 * errors to 2,722 (measured 23 Aug 2026 on `document_series`). WITH NO GENERATED TYPES,
 * NOTHING CHECKS THE TENANT FILTER — every query below carries an explicit
 * `.eq("tenant_id", …)` except the cron's due-sweep, which is cross-tenant BY DESIGN and
 * says so at its call site.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loopDueAt } from "./sales-loops";

function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface DueLoop {
  id: string;
  tenantId: string;
  leadId: string;
  triggerCondition: string;
  createdAt: Date;
  /** Which step of the cadence this row is — see lib/ai/cadence.ts. Defaults to 1 for every
   *  row written before the cadence existed, which is exactly what those rows were. */
  step: number;
  /** The channel the step ASKED for. What actually carried it is decided at send time. */
  channel: "email" | "whatsapp";
}

/**
 * Replace this lead's pending follow-up with a new one.
 *
 * ─── WHY IT CANCELS FIRST INSTEAD OF INSERTING ──────────────────────────────
 * There is a unique partial index on (tenant_id, lead_id) WHERE status='pending', so a plain
 * insert would fail on the second message of any conversation. Cancelling first is also the
 * behaviour we actually want: the newest exchange knows best when to come back, and two
 * pending rows would nudge one silence twice.
 *
 * Returns false on failure and never throws. The caller is a webhook that has already
 * committed the reply; losing a scheduled nudge is a smaller loss than failing the request
 * and having the provider retry the whole enquiry.
 */
export async function scheduleSalesLoop(args: {
  tenantId: string;
  leadId: string;
  inHours: number;
  triggerCondition: string;
  now?: Date;
  /** Cadence step this row represents. Omitted means the first — the pre-cadence behaviour. */
  step?: number;
  channel?: "email" | "whatsapp";
}): Promise<boolean> {
  const db = bare();
  if (!db) return false;

  const now = args.now ?? new Date();

  const cancelled = await cancelPendingLoops({
    tenantId: args.tenantId,
    leadId: args.leadId,
    /* Not a customer reply — this is the agent replacing its own plan, and the distinction
       matters in the log when somebody asks why a nudge never arrived. */
    reason: "superseded by a newer follow-up plan",
  });
  if (!cancelled) return false;

  const { error } = await db.from("ai_sales_loops").insert({
    tenant_id: args.tenantId,
    lead_id: args.leadId,
    scheduled_at: loopDueAt(now, args.inHours).toISOString(),
    status: "pending",
    trigger_condition: args.triggerCondition,
    step: args.step ?? 1,
    channel: args.channel ?? "email",
  });

  if (error) {
    console.error("[sales-loops] could not schedule follow-up:", error.message);
    return false;
  }
  return true;
}

/**
 * Cancel this lead's pending follow-ups.
 *
 * Called when the agent reschedules, and — the important one — when a customer replies. A
 * nudge that fires after the customer has already written is the single most robot-like thing
 * this feature could do, and `shouldNudge` is the second line of defence rather than the
 * first: cancelling at reply time means the row is gone before the cron ever looks.
 */
export async function cancelPendingLoops(args: {
  tenantId: string;
  leadId: string;
  reason: string;
}): Promise<boolean> {
  const db = bare();
  if (!db) return false;

  const { error } = await db
    .from("ai_sales_loops")
    .update({
      status: "cancelled",
      processed_at: new Date().toISOString(),
      trigger_condition: `cancelled — ${args.reason}`,
    })
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .eq("status", "pending");

  if (error) {
    console.error("[sales-loops] could not cancel pending follow-ups:", error.message);
    return false;
  }
  return true;
}

interface DueRow {
  id: string | null;
  tenant_id: string | null;
  lead_id: string | null;
  trigger_condition: string | null;
  created_at: string | null;
  step: number | null;
  channel: string | null;
}

/**
 * Follow-ups that are due, across every tenant.
 *
 * CROSS-TENANT ON PURPOSE, and the only query in this file without a tenant filter. A cron
 * has no tenant of its own; it sweeps for every workspace, exactly as the renewal and dunning
 * crons do. The tenant_id comes back on each row and every subsequent read and write is
 * scoped to it — so the sweep is wide and the actions are narrow.
 */
export async function loadDueLoops(limit: number, now?: Date): Promise<DueLoop[]> {
  const db = bare();
  if (!db) return [];

  const { data, error } = await db
    .from("ai_sales_loops")
    .select("id, tenant_id, lead_id, trigger_condition, created_at, step, channel")
    .eq("status", "pending")
    .lte("scheduled_at", (now ?? new Date()).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[sales-loops] due sweep failed:", error.message);
    return [];
  }

  const rows = (data ?? []) as DueRow[];
  return rows.flatMap((r): DueLoop[] => {
    if (!r.id || !r.tenant_id || !r.lead_id) return [];
    return [
      {
        id: r.id,
        tenantId: r.tenant_id,
        leadId: r.lead_id,
        triggerCondition: r.trigger_condition ?? "no reason recorded",
        createdAt: r.created_at ? new Date(r.created_at) : new Date(0),
        /* 1 and "email" for anything written before the cadence existed — which is what those
           rows were: a single email nudge. */
        step: typeof r.step === "number" && r.step >= 1 ? r.step : 1,
        channel: r.channel === "whatsapp" ? "whatsapp" : "email",
      },
    ];
  });
}

/**
 * Close a loop row out.
 *
 * `processed` covers both "we nudged" and "we decided not to", with the outcome written into
 * trigger_condition. Distinguishing them there rather than in `status` keeps the status column
 * to the three values the schema allows while leaving the reason readable — and the reason is
 * what somebody asks for when a customer says they were chased twice.
 */
export async function closeLoop(args: {
  id: string;
  tenantId: string;
  outcome: string;
}): Promise<void> {
  const db = bare();
  if (!db) return;

  const { error } = await db
    .from("ai_sales_loops")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      trigger_condition: args.outcome,
    })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId);

  if (error) console.error("[sales-loops] could not close loop:", error.message);
}

interface LastMessageRow {
  created_at: string | null;
}

/**
 * When the customer last wrote on this lead, or null if they never have.
 *
 * Reads the agent's own transcript rather than `inbound_emails`, because the transcript is the
 * one place both channels land — a WhatsApp reply is a reply, and a cancel rule that only
 * noticed email would nudge a customer who had just messaged.
 */
export async function lastCustomerMessageAt(args: {
  tenantId: string;
  leadId: string;
}): Promise<Date | null> {
  const db = bare();
  if (!db) return null;

  const { data, error } = await db
    .from("ai_sales_conversations")
    .select("created_at")
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[sales-loops] last-message read failed:", error.message);
    return null;
  }

  const row = ((data ?? []) as LastMessageRow[])[0];
  return row?.created_at ? new Date(row.created_at) : null;
}

export interface LoopLead {
  id: string;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  seats: number | null;
  plan: string | null;
  stage: string;
  isJunk: boolean;
  requiresHumanAttention: boolean;
}

interface LoopLeadRow {
  id: string | null;
  company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  seats: number | null;
  plan: string | null;
  stage: string | null;
  is_junk: boolean | null;
  requires_human_attention: boolean | null;
}

/**
 * The lead behind a due follow-up, including the handover flag.
 *
 * Read through the bare client rather than the typed admin one because
 * `requires_human_attention` is added by migration 20260824120000 and is not in the generated
 * `Database` type — a typed `.select()` naming it fails to compile. See
 * `flagLeadForHumanAttention` in sales-agent.server.ts for why regenerating that type is not
 * the cheap fix it appears to be.
 *
 * That flag is the whole reason this read exists rather than reusing the typed one: it is what
 * tells the cron a person has taken the lead over, and nudging a customer over the top of a
 * colleague is the outcome `shouldNudge` exists to prevent.
 */
export async function loadLoopLead(args: {
  tenantId: string;
  leadId: string;
}): Promise<{ ok: true; lead: LoopLead } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured" };

  const { data, error } = await db
    .from("leads")
    .select(
      "id, company, contact_name, contact_email, contact_phone, seats, plan, stage, is_junk, requires_human_attention",
    )
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "no such lead in this workspace" };

  const r = data as LoopLeadRow;
  if (!r.id) return { ok: false, error: "the lead row has no id" };

  return {
    ok: true,
    lead: {
      id: r.id,
      company: r.company,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      seats: r.seats,
      plan: r.plan,
      stage: r.stage ?? "new",
      isJunk: r.is_junk === true,
      requiresHumanAttention: r.requires_human_attention === true,
    },
  };
}
