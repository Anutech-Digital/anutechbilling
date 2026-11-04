/**
 * R-2158 (AI-02, goal G-ADS-AI, 30 Oct 2026) — the safety layer between the AI ad agent and money.
 * The pure half: which dial each action uses, the idempotency key, and what a proposal must say.
 *
 * Pardeep's decision D3 (30 Oct): the AI RECOMMENDS. Publishing, raising a budget or adding a
 * creative always waits for the owner; lowering a budget or pausing may run alone inside a cap set
 * per company. The caps, the one-row-per-key ledger and the approval bridge to the marketing budget
 * (R-1792) live in the database — ad_agent_action_request / _decide / _finish, migration
 * 20261030084431 — so they hold even if this file is bypassed. Server half: server/marketing/ad-safety.server.ts.
 */
import { resolveAutonomy, type AiAction, type AutonomyPolicy, type AutonomyVerdict } from "@/lib/ai/autonomy";
import type { AiOutcome } from "@/lib/ai/action-log";

export const AD_ACTION_TYPES = ["publish", "budget_up", "budget_down", "pause", "new_creative"] as const;
export type AdActionType = (typeof AD_ACTION_TYPES)[number];

/** Each action's dial in lib/ai/autonomy.ts. */
export const AD_ACTION_AUTONOMY = {
  publish: "ads.publish",
  budget_up: "ads.budget_up",
  budget_down: "ads.budget_down",
  pause: "ads.pause",
  new_creative: "ads.new_creative",
} as const satisfies Record<AdActionType, AiAction>;

const SPEND_UP: readonly AdActionType[] = ["publish", "budget_up", "new_creative"];

/** Raises spend or puts a new ad in front of people — always waits for the owner (D3). */
export function isSpendUp(action: AdActionType): boolean {
  return SPEND_UP.includes(action);
}

/**
 * The mode the database is told. The dial decides, and a spend-up can never come out `auto`
 * whatever is stored — the registry does not support it, and the SQL refuses it a second time.
 */
export function adActionMode(action: AdActionType, policy: AutonomyPolicy): AutonomyVerdict {
  const v = resolveAutonomy(AD_ACTION_AUTONOMY[action], policy);
  if (isSpendUp(action) && v.mode === "auto") {
    return { mode: "hold", reason: `${v.reason}; raising spend always waits for the owner` };
  }
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One key per campaign / action / version — the same string the database builds, so a retried
 * publish or a cron that runs twice finds the first row instead of making a second.
 */
export function adIdempotencyKey(campaignId: string, action: AdActionType, version: number): string {
  if (!UUID.test(campaignId)) throw new Error(`campaign id must be a uuid, got "${campaignId}"`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`version must be a whole number from 1, got ${version}`);
  return `${campaignId.toLowerCase()}:${action}:v${version}`;
}

export type AdPlatform = "google-ads" | "meta-ads";

export interface AdActionProposal {
  /** ad_plans.id — the campaign row the agent works on. */
  campaignId: string;
  action: AdActionType;
  /** Bumped by the agent for each new proposal on the same campaign + action. */
  version: number;
  platform: AdPlatform | null;
  /** Change to the daily budget, in rupees: + raises, − lowers. */
  moneyDeltaInr: number;
  /** The daily budget after the change (publish: the starting budget). */
  newDailyBudgetInr?: number | null;
  /** New ads that go live with this action (publish / new_creative). */
  adsDelta?: number;
  /** Why the AI wants it — written to the ledger and the automation log. */
  reason: string;
}

/** What is wrong with a proposal before it reaches the database, or null. Same rules as the SQL. */
export function proposalProblem(p: AdActionProposal): string | null {
  if (!p.reason?.trim()) return "Give a reason — the log records why the AI wanted this.";
  const d = p.moneyDeltaInr;
  if (!Number.isFinite(d)) return "The budget change must be a number of rupees.";
  const ads = p.adsDelta ?? 0;
  switch (p.action) {
    case "budget_up":
      if (d <= 0) return "budget_up must raise the budget (a positive change).";
      break;
    case "budget_down":
      if (d >= 0) return "budget_down must lower the budget (a negative change).";
      break;
    case "pause":
      if (d > 0) return "A pause cannot raise spend.";
      break;
    case "publish":
      if (!p.newDailyBudgetInr || p.newDailyBudgetInr <= 0) return "Publishing needs a starting daily budget.";
      if (d < 0) return "Publishing cannot lower spend.";
      if (ads < 1) return "Publishing needs at least one ad.";
      break;
    case "new_creative":
      if (d < 0) return "A new creative cannot lower spend.";
      if (ads < 1) return "A new creative adds at least one ad.";
      break;
  }
  if (p.action !== "new_creative" && !p.platform) return "Name the platform (google-ads or meta-ads).";
  return null;
}

export type AdActionStatus = "auto_ok" | "held" | "approved" | "rejected" | "refused" | "done" | "failed";

/**
 * What a request writes to ai_action_log. auto_ok writes nothing yet — "did" is written when the
 * executor finishes it — and a replayed key writes nothing at all (it was logged the first time).
 */
export function requestOutcome(status: AdActionStatus, replayed: boolean): AiOutcome | null {
  if (replayed) return null;
  if (status === "held") return "held";
  if (status === "refused") return "skipped";
  return null;
}

export function finishOutcome(ok: boolean): AiOutcome {
  return ok ? "did" : "failed";
}
