/**
 * Server side of the autonomy dial: read the policy, write the log.
 *
 * Split from `autonomy.ts` so the DECISION stays pure and table-testable while the IO lives
 * where it can be kept thin. Same split as quote-from-enquiry / send-auto-quote, and for the
 * same reason: the rules are what get argued about, and arguing about them should not require
 * a database.
 *
 * ─── WHY A BARE CLIENT FOR ai_autonomy AND ai_action_log ────────────────────
 * Neither table is in the generated `Database` type, and registering them is not a two-line
 * fix. Measured 23 Aug 2026 on `document_series`: adding ONE table to the Tables map took
 * `npm run typecheck` from 4 errors to **2,722**, because supabase-js resolves row types
 * through a conditional chain that tips over the instantiation limit at this schema size and
 * collapses every table to `never`. So these two stay unregistered and are reached through a
 * deliberately untyped client — the pattern `api/invoices/series/route.ts` already
 * establishes, kept here in one short file rather than spread across call sites.
 *
 * With no generated types, NOTHING CHECKS THE TENANT FILTER. Every query below carries an
 * explicit `.eq("tenant_id", …)` and that line is the entire boundary between one
 * workspace's automation policy and another's. `tenantId` comes from the caller's own
 * resolved context, never from a request body.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { AutonomyPolicy, AiAction, AutonomyMode } from "./autonomy";
import { buildAiActionRecord, type AiOutcome } from "./action-log";

/**
 * `no-store` is not optional here (CLAUDE.md §17). A cached kill-switch read is the worst
 * possible thing to cache: the operator flips the switch, the app keeps sending for the
 * length of a TTL, and the log says it was allowed to.
 */
function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/**
 * Reads the workspace's policy. Two queries, and they fail in OPPOSITE directions.
 *
 * If the tenant row cannot be read, `killSwitch` comes back TRUE. A missing answer to "am I
 * switched off?" must not be read as "carry on" — the entire point of the switch is the
 * moment somebody is trying to stop something, and that is exactly when a database blip is
 * least acceptable as a yes.
 *
 * If the ai_autonomy rows cannot be read, the modes come back EMPTY, so every action falls
 * back to its declared current behaviour. That is right for the opposite reason: an empty
 * dial is the NORMAL state — no tenant has configured anything — so a read failure there is
 * indistinguishable from "not configured" and must behave the same way, rather than silently
 * stopping five working crons.
 *
 * With no Supabase configuration at all, the switch is also treated as ON. An app that
 * cannot reach its own settings has no business emailing customers.
 */
export async function loadAutonomyPolicy(tenantId: string): Promise<AutonomyPolicy> {
  const db = bare();
  if (!db) {
    console.error("[autonomy] Supabase is not configured — failing CLOSED");
    return { killSwitch: true, modes: {} };
  }

  const { data: t, error: tErr } = await db
    .from("tenants")
    .select("ai_kill_switch")
    .eq("id", tenantId)
    .maybeSingle();

  if (tErr || !t) {
    console.error("[autonomy] could not read the kill switch — failing CLOSED:", tErr);
    return { killSwitch: true, modes: {} };
  }

  const killSwitch = (t as { ai_kill_switch?: boolean | null }).ai_kill_switch === true;

  const { data: rows, error: rErr } = await db
    .from("ai_autonomy")
    .select("action, mode")
    .eq("tenant_id", tenantId);   // <- the only tenant boundary on this query

  if (rErr) {
    console.error("[autonomy] could not read the per-action dial — using defaults:", rErr);
    return { killSwitch, modes: {} };
  }

  const modes: Partial<Record<AiAction, AutonomyMode>> = {};
  for (const r of (rows ?? []) as { action?: string | null; mode?: string | null }[]) {
    const action = (r.action ?? "").trim();
    const mode   = (r.mode ?? "").trim();
    if (!action) continue;
    /* `action` is NOT validated against AI_ACTIONS, deliberately: the column is text so a
       new action can ship without a migration, and a row naming something this build does
       not know about is simply never asked for. Validating would turn a harmless stale row
       into an error. */
    if (mode === "off" || mode === "hold" || mode === "auto") {
      modes[action as AiAction] = mode;
    }
  }

  return { killSwitch, modes };
}

/**
 * Writes. Returns false rather than throwing, because every caller has to tell the operator
 * something either way and "it might have saved" is not something to tell anybody about a
 * switch whose whole job is to be trusted.
 *
 * The caller is responsible for checking role and resolving the tenant from the SESSION.
 * These use the service role and so bypass RLS — the `ai_autonomy_write` policy protects the
 * table from anything holding a user session, not from this.
 */
export const setAutonomy = {
  async killSwitch(tenantId: string, on: boolean, byUserId: string): Promise<boolean> {
    const db = bare();
    if (!db) { console.error("[autonomy] cannot set the kill switch — Supabase not configured"); return false; }
    const { error } = await db
      .from("tenants")
      .update({ ai_kill_switch: on })
      .eq("id", tenantId);            // <- the only tenant boundary on this write
    if (error) { console.error("[autonomy] kill switch write failed:", error, { tenantId, on, byUserId }); return false; }
    return true;
  },

  async mode(tenantId: string, action: AiAction, mode: AutonomyMode, byUserId: string): Promise<boolean> {
    const db = bare();
    if (!db) { console.error("[autonomy] cannot set a mode — Supabase not configured"); return false; }
    /* Upsert on (tenant_id, action) — the table's primary key. A second row for the same
       action would make the resolved mode depend on read order, which is the kind of bug
       that only appears once there are two of something. */
    const { error } = await db
      .from("ai_autonomy")
      .upsert(
        { tenant_id: tenantId, action, mode, updated_at: new Date().toISOString(), updated_by: byUserId },
        { onConflict: "tenant_id,action" },
      );
    if (error) { console.error("[autonomy] mode write failed:", error, { tenantId, action, mode }); return false; }
    return true;
  },
};

/** One page of the log, newest first. Read through a route; the tenant comes from a session. */
export async function readAiActionLog(
  tenantId: string,
  opts: { limit?: number; heldOnly?: boolean } = {},
): Promise<{
  rows: {
    id: number; created_at: string; action: string; outcome: string;
    reason: string; mode: string; entity: string | null; entity_id: string | null;
    facts: Record<string, unknown>;
  }[];
  error: string | null;
}> {
  const db = bare();
  if (!db) return { rows: [], error: "Supabase is not configured on the server." };

  let q = db
    .from("ai_action_log")
    .select("id, created_at, action, outcome, reason, mode, entity, entity_id, facts")
    .eq("tenant_id", tenantId)        // <- the only tenant boundary on this read
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));

  if (opts.heldOnly) q = q.eq("outcome", "held");

  const { data, error } = await q;
  if (error) {
    /* Reported, not swallowed into an empty list. "Nothing happened" and "we could not find
       out what happened" look identical on a screen and mean opposite things — the same
       distinction lib/ops/health-signals.ts exists to keep. */
    console.error("[autonomy] could not read the action log:", error);
    return { rows: [], error: "Could not read the automation log." };
  }
  return { rows: (data ?? []) as never[], error: null };
}

/**
 * Records what happened. Never throws, and never blocks the caller.
 *
 * A failure to WRITE the log must not become a failure to do the work — or to refuse it.
 * That would turn the least critical part of the system into a single point of failure for
 * the most critical, which is the opposite of what an audit trail is for. It goes to the
 * console instead, so a broken logger is still visible somewhere.
 */
export async function logAiAction(input: {
  tenantId: string;
  action: AiAction;
  outcome: AiOutcome;
  reason: string;
  mode: AutonomyMode;
  entity?: string | null;
  entityId?: string | null;
  facts?: Record<string, unknown>;
}): Promise<void> {
  const record = buildAiActionRecord(input);
  const db = bare();
  if (!db) {
    console.error("[autonomy] cannot log — Supabase not configured:", record);
    return;
  }
  try {
    const { error } = await db.from("ai_action_log").insert({
      tenant_id: record.tenantId,
      action:    record.action,
      outcome:   record.outcome,
      reason:    record.reason,
      mode:      record.mode,
      entity:    record.entity,
      entity_id: record.entityId,
      facts:     record.facts,
    });
    if (error) console.error("[autonomy] ai_action_log insert failed:", error, record);
  } catch (err) {
    console.error("[autonomy] ai_action_log insert crashed:", err, record);
  }
}
