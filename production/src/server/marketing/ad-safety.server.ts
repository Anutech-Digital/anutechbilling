/**
 * R-2158 (AI-02, goal G-ADS-AI) — server half of the ad agent's safety layer.
 *
 * Every money action the agent wants goes through `requestAdAction`: the company's autonomy dial
 * is read (fail CLOSED — an unreadable kill switch reads as ON), the proposal is checked, and the
 * database decides auto_ok / held / refused under one per-company lock with the hard caps and the
 * idempotency key (ad_agent_action_request, migration 20261030084431). What was held or refused
 * goes into the automation log (ai_action_log) so it shows on /automation with everything else.
 *
 * `tenantId` must come from the caller's own resolved context (a session, or the cron's company
 * loop) — never from a request body. The RPCs check it again.
 */
import "server-only";
import { createBareClient } from "@/lib/supabase/bare";
import { loadAutonomyPolicy, logAiAction } from "@/lib/ai/autonomy.server";
import {
  AD_ACTION_AUTONOMY, adActionMode, finishOutcome, proposalProblem, requestOutcome,
  type AdActionProposal, type AdActionStatus, type AdActionType,
} from "@/lib/marketing/ad-safety";

/** no-store: a cached answer about money permissions is the wrong answer (CLAUDE.md §17). */
function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export type AdActionResult =
  | { ok: true; id: string; status: AdActionStatus; reason: string; key: string; replayed: boolean }
  | { ok: false; error: string };

export async function requestAdAction(tenantId: string, p: AdActionProposal): Promise<AdActionResult> {
  const problem = proposalProblem(p);
  if (problem) return { ok: false, error: problem };

  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured on the server — no ad action was taken." };

  const policy = await loadAutonomyPolicy(tenantId);
  const verdict = adActionMode(p.action, policy);

  const { data, error } = await db.rpc("ad_agent_action_request", {
    p_tenant_id: tenantId,
    p_plan_id: p.campaignId,
    p_action: p.action,
    p_version: p.version,
    p_platform: p.platform,
    p_money_delta: p.moneyDeltaInr,
    p_new_daily: p.newDailyBudgetInr ?? null,
    p_ads_delta: p.adsDelta ?? 0,
    p_mode: verdict.mode,
    p_reason: p.reason.trim().slice(0, 1000),
  });
  if (error || !data) {
    console.error("[ad-safety] request refused by the database:", error, { tenantId, action: p.action });
    return { ok: false, error: error?.message ?? "The ad action could not be recorded." };
  }
  const r = data as { id: string; status: AdActionStatus; reason: string; key: string; replayed: boolean };

  const outcome = requestOutcome(r.status, r.replayed);
  if (outcome) {
    await logAiAction({
      tenantId, action: AD_ACTION_AUTONOMY[p.action], outcome, mode: verdict.mode,
      reason: `${r.reason} (dial: ${verdict.reason})`,
      entity: "ad_plan", entityId: p.campaignId,
      facts: {
        ad_action: p.action, version: p.version, platform: p.platform,
        money_delta_inr: p.moneyDeltaInr, new_daily_budget_inr: p.newDailyBudgetInr ?? null,
        ads_delta: p.adsDelta ?? 0, ledger_id: r.id, ai_reason: p.reason,
      },
    });
  }
  return { ok: true, ...r };
}

/**
 * The executor (publish / monitor node) reports the platform's answer for an auto_ok or approved
 * row. Logged as did / failed against the action's own dial.
 */
export async function finishAdAction(input: {
  tenantId: string; ledgerId: string; campaignId: string; action: AdActionType; ok: boolean; note?: string | null;
}): Promise<{ ok: true; status: AdActionStatus } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured on the server." };
  const { data, error } = await db.rpc("ad_agent_action_finish", {
    p_action_id: input.ledgerId, p_ok: input.ok, p_note: input.note ?? null,
  });
  if (error || !data) {
    console.error("[ad-safety] finish refused:", error, input);
    return { ok: false, error: error?.message ?? "Could not record the result." };
  }
  const policy = await loadAutonomyPolicy(input.tenantId);
  await logAiAction({
    tenantId: input.tenantId, action: AD_ACTION_AUTONOMY[input.action], outcome: finishOutcome(input.ok),
    mode: adActionMode(input.action, policy).mode,
    reason: input.ok ? "The ad platform accepted the change." : `The ad platform refused: ${input.note ?? "no detail"}`,
    entity: "ad_plan", entityId: input.campaignId,
    facts: { ad_action: input.action, ledger_id: input.ledgerId },
  });
  return { ok: true, status: (data as { status: AdActionStatus }).status };
}

/**
 * The owner's approve / reject from a server route. `ownerUserId` is the signed-in user from the
 * session; the database checks that they are an active owner of this company, and for spend-up that
 * `budgetId` is an approved marketing budget (R-1792) of the same channel and month that covers it.
 */
export async function decideAdAction(input: {
  ledgerId: string; ownerUserId: string; decision: "approve" | "reject"; budgetId?: string | null; note?: string | null;
}): Promise<{ ok: true; status: AdActionStatus } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured on the server." };
  const { data, error } = await db.rpc("ad_agent_action_decide", {
    p_action_id: input.ledgerId, p_decision: input.decision, p_budget_id: input.budgetId ?? null,
    p_note: input.note ?? null, p_decided_by: input.ownerUserId,
  });
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the decision." };
  return { ok: true, status: (data as { status: AdActionStatus }).status };
}
