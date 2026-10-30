/**
 * R-2158 (AI-02, goal G-ADS-AI) — the safety layer the ad agent must pass through before it
 * touches money. Pardeep, 30 Oct 2026 (D3): the AI recommends and a person approves anything
 * that RAISES spend, publishes a new ad or adds a creative; lowering a budget or pausing may run
 * on its own, inside a cap set per company. These tests pin that rule in the pure half; the
 * caps, the idempotency key and the approval bridge are proved in SQL
 * (supabase/tests/r2158_ad_agent_safety.test.sql).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_ACTIONS, visibleAiActions, type AutonomyPolicy } from "@/lib/ai/autonomy";
import {
  AD_ACTION_TYPES, AD_ACTION_AUTONOMY, adActionMode, adIdempotencyKey, isSpendUp,
  proposalProblem, requestOutcome, finishOutcome,
} from "./ad-safety";

const NOTHING_SET: AutonomyPolicy = { killSwitch: false, modes: {} };
const PLAN = "eeeeeeee-0000-0000-0000-000000215801";

describe("the five action types the agent can ask for", () => {
  it("are exactly publish, budget_up, budget_down, pause, new_creative", () => {
    expect([...AD_ACTION_TYPES].sort()).toEqual(["budget_down", "budget_up", "new_creative", "pause", "publish"]);
  });

  it.each(AD_ACTION_TYPES)("%s has its own dial in lib/ai/autonomy.ts", (t) => {
    expect(Object.keys(AI_ACTIONS)).toContain(AD_ACTION_AUTONOMY[t]);
  });
});

describe("D3 — spend-up waits for a person, spend-down may run inside the cap", () => {
  it.each(["publish", "budget_up", "new_creative"] as const)("%s is spend-up and starts at hold", (t) => {
    expect(isSpendUp(t)).toBe(true);
    expect(adActionMode(t, NOTHING_SET).mode).toBe("hold");
  });

  it.each(["publish", "budget_up", "new_creative"] as const)("%s can never be set to auto", (t) => {
    const spec = AI_ACTIONS[AD_ACTION_AUTONOMY[t]];
    expect(spec.supports).not.toContain("auto");
    /* Even a stored "auto" (a stale row, a hand edit) is reported and falls back to hold. */
    const v = adActionMode(t, { killSwitch: false, modes: { [AD_ACTION_AUTONOMY[t]]: "auto" } });
    expect(v.mode).toBe("hold");
  });

  it.each(["budget_down", "pause"] as const)("%s is not spend-up and starts at auto (the cap still applies in SQL)", (t) => {
    expect(isSpendUp(t)).toBe(false);
    expect(adActionMode(t, NOTHING_SET).mode).toBe("auto");
  });

  it("the kill switch stops every ad action", () => {
    for (const t of AD_ACTION_TYPES) {
      expect(adActionMode(t, { killSwitch: true, modes: {} }).mode).toBe("off");
    }
  });

  it("a company can turn budget-down back to hold", () => {
    expect(adActionMode("budget_down", { killSwitch: false, modes: { "ads.budget_down": "hold" } }).mode).toBe("hold");
  });
});

describe("idempotency key — one per campaign / action / version", () => {
  it("is stable for the same three parts", () => {
    expect(adIdempotencyKey(PLAN, "publish", 1)).toBe(adIdempotencyKey(PLAN, "publish", 1));
    expect(adIdempotencyKey(PLAN, "publish", 1)).toBe(`${PLAN}:publish:v1`);
  });

  it("differs when any part differs", () => {
    const k = adIdempotencyKey(PLAN, "publish", 1);
    expect(adIdempotencyKey(PLAN, "publish", 2)).not.toBe(k);
    expect(adIdempotencyKey(PLAN, "pause", 1)).not.toBe(k);
    expect(adIdempotencyKey("eeeeeeee-0000-0000-0000-000000215802", "publish", 1)).not.toBe(k);
  });

  it("refuses a version that is not a positive whole number, or a campaign that is not an id", () => {
    expect(() => adIdempotencyKey(PLAN, "publish", 0)).toThrow();
    expect(() => adIdempotencyKey(PLAN, "publish", 1.5)).toThrow();
    expect(() => adIdempotencyKey("abc", "publish", 1)).toThrow();
  });
});

describe("a proposal must say what it does to money, in the right direction", () => {
  const base = { campaignId: PLAN, version: 1, platform: "meta-ads" as const, reason: "ROAS 0.6 for 4 days" };

  it("budget_up must add rupees, budget_down must take them away", () => {
    expect(proposalProblem({ ...base, action: "budget_up", moneyDeltaInr: 200 })).toBeNull();
    expect(proposalProblem({ ...base, action: "budget_up", moneyDeltaInr: -200 })).toMatch(/raise/);
    expect(proposalProblem({ ...base, action: "budget_down", moneyDeltaInr: -200 })).toBeNull();
    expect(proposalProblem({ ...base, action: "budget_down", moneyDeltaInr: 50 })).toMatch(/lower/);
  });

  it("pause can only lower spend", () => {
    expect(proposalProblem({ ...base, action: "pause", moneyDeltaInr: -500 })).toBeNull();
    expect(proposalProblem({ ...base, action: "pause", moneyDeltaInr: 10 })).toMatch(/pause/i);
  });

  it("publish needs a daily budget and at least one ad", () => {
    expect(proposalProblem({ ...base, action: "publish", moneyDeltaInr: 500, newDailyBudgetInr: 500, adsDelta: 2 })).toBeNull();
    expect(proposalProblem({ ...base, action: "publish", moneyDeltaInr: 500, adsDelta: 2 })).toMatch(/daily budget/);
    expect(proposalProblem({ ...base, action: "publish", moneyDeltaInr: 500, newDailyBudgetInr: 500, adsDelta: 0 })).toMatch(/ad/);
  });

  it("new_creative adds at least one ad", () => {
    expect(proposalProblem({ ...base, action: "new_creative", moneyDeltaInr: 0, adsDelta: 1 })).toBeNull();
    expect(proposalProblem({ ...base, action: "new_creative", moneyDeltaInr: 0 })).toMatch(/ad/);
  });

  it("money actions name the platform", () => {
    expect(proposalProblem({ ...base, platform: null, action: "budget_up", moneyDeltaInr: 100 })).toMatch(/platform/);
  });

  it("a reason is required — the audit log records why", () => {
    expect(proposalProblem({ ...base, reason: "  ", action: "budget_down", moneyDeltaInr: -100 })).toMatch(/reason/);
  });
});

describe("what goes into the automation log", () => {
  it("held is held, refused is skipped, auto_ok and replays write nothing yet", () => {
    expect(requestOutcome("held", false)).toBe("held");
    expect(requestOutcome("refused", false)).toBe("skipped");
    expect(requestOutcome("auto_ok", false)).toBeNull();
    expect(requestOutcome("held", true)).toBeNull();
  });

  it("finishing writes did or failed", () => {
    expect(finishOutcome(true)).toBe("did");
    expect(finishOutcome(false)).toBe("failed");
  });
});

describe("R-1608 — the ad dials stay hidden until the agent graph calls them", () => {
  it.each(AD_ACTION_TYPES)("%s is declared but not shown on /automation yet", (t) => {
    expect(visibleAiActions()).not.toContain(AD_ACTION_AUTONOMY[t]);
  });

  it("the server half passes every request through the RPC that holds the caps", () => {
    const src = readFileSync(join(__dirname, "../../server/marketing/ad-safety.server.ts"), "utf8");
    expect(src).toContain('rpc("ad_agent_action_request"');
    expect(src).toContain("loadAutonomyPolicy(");
    expect(src).toContain("logAiAction(");
  });
});
