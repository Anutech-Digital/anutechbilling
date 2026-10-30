/**
 * R-1879 (epic R-1874) — the co-pilot wizard's rules for steps 1–2: what a prompt fills in,
 * which platform / audience choices are allowed for an objective, and what gets saved.
 * Pure — no DB, no AI.
 */
import { describe, expect, it } from "vitest";
import {
  INDIA_REGIONS, OBJECTIVE_GROUPS, OBJECTIVE_INFO, audienceFromGroups, buildPrefillPrompt, groupOf,
  guessFromPrompt, lookalikeInfo, mergeAiPrefill, objectiveInPrompt, normalizePlan, planDraftSchema, platformInfo,
  targetGroupRows, type PlanDraft,
} from "./plan-draft";
import { COPILOT_OBJECTIVES, PLATFORMS } from "./channel-specs";
import { GST_STATE_BY_CODE } from "@/lib/utils";

const ITEMS = [
  { id: "i-gws", name: "Google Workspace Business Starter" },
  { id: "i-m365", name: "Microsoft 365 Business Basic" },
  { id: "i-tally", name: "Tally Prime" },
];

const base = (over: Partial<PlanDraft> = {}): PlanDraft => ({
  name: "Diwali Workspace offer",
  itemId: null,
  objective: "lead_gen",
  platforms: ["google-ads", "meta-ads"],
  prompt: "Diwali offer",
  language: "en",
  audience: { ageMin: 25, ageMax: 55, genders: [], regions: ["Delhi"], lookalike: false },
  ...over,
});

describe("regions and objectives — one list each", () => {
  it("India regions are the GST state list without the two non-places", () => {
    expect(INDIA_REGIONS).toContain("Delhi");
    expect(INDIA_REGIONS).toContain("Tamil Nadu");
    expect(INDIA_REGIONS).not.toContain("Other Territory");
    expect(INDIA_REGIONS).not.toContain("Centre Jurisdiction");
    expect(INDIA_REGIONS.length).toBe(Object.keys(GST_STATE_BY_CODE).length - 2);
    expect([...INDIA_REGIONS]).toEqual([...INDIA_REGIONS].sort((a, b) => a.localeCompare(b)));
  });

  it("the two-level objective choice covers every objective exactly once", () => {
    const all = OBJECTIVE_GROUPS.flatMap((g) => g.objectives);
    expect([...all].sort()).toEqual([...COPILOT_OBJECTIVES].sort());
    for (const o of COPILOT_OBJECTIVES) {
      expect(OBJECTIVE_INFO[o].label.length).toBeGreaterThan(2);
      expect(groupOf(o).objectives).toContain(o);
    }
  });
});

describe("platformInfo / lookalikeInfo — what the screen allows", () => {
  it("Google has no format for awareness → not offered, with the reason", () => {
    const g = platformInfo("google-ads", "awareness");
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/Google Ads/);
    expect(platformInfo("meta-ads", "awareness").available).toBe(true);
    expect(platformInfo("google-ads", "lead_gen")).toEqual({ available: true, reason: null });
  });

  it("lookalike: Meta yes, Google no — and Google says why (Similar audiences sunset)", () => {
    expect(lookalikeInfo("meta-ads").available).toBe(true);
    const g = lookalikeInfo("google-ads");
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/Similar audiences/i);
  });
});

describe("guessFromPrompt — no AI, the prompt still fills the form", () => {
  it("the card's example: product, objective, region, platforms", () => {
    const d = guessFromPrompt("Diwali offer on Google Workspace for Delhi SMEs — get enquiries", ITEMS);
    expect(d.itemId).toBe("i-gws");
    expect(d.objective).toBe("lead_gen");
    expect(d.audience.regions).toEqual(["Delhi"]);
    expect(d.platforms).toEqual(["google-ads", "meta-ads"]);
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.name.length).toBeLessThanOrEqual(120);
    expect(d.prompt).toBe("Diwali offer on Google Workspace for Delhi SMEs — get enquiries");
  });

  it("cities map to their state; named platforms win", () => {
    const d = guessFromPrompt("Instagram ads for Tally in Mumbai and Bengaluru to sell more", ITEMS);
    expect(d.itemId).toBe("i-tally");
    expect(d.objective).toBe("sales");
    expect(d.platforms).toEqual(["meta-ads"]);
    expect(d.audience.regions).toEqual(["Karnataka", "Maharashtra"]);
  });

  it("age range and gender from the words; 'women' is not 'men'", () => {
    const d = guessFromPrompt("Awareness for working women aged 25-40", ITEMS);
    expect(d.objective).toBe("awareness");
    expect(d.audience.genders).toEqual(["female"]);
    expect(d.audience.ageMin).toBe(25);
    expect(d.audience.ageMax).toBe(40);
    // Google has no awareness format → only Meta
    expect(d.platforms).toEqual(["meta-ads"]);
  });

  it("nothing recognisable → safe defaults (enquiries, both platforms, all India)", () => {
    const d = guessFromPrompt("hello", ITEMS);
    expect(d.itemId).toBeNull();
    expect(d.objective).toBe("lead_gen");
    expect(d.platforms).toEqual(["google-ads", "meta-ads"]);
    expect(d.audience).toEqual({ ageMin: 18, ageMax: 65, genders: [], regions: [], lookalike: false });
  });
});

describe("AI prefill — every field checked, bad ones fall back to the guess", () => {
  it("the prompt names the items by id and the allowed values", () => {
    const p = buildPrefillPrompt("Diwali offer", ITEMS);
    expect(p.user).toContain("i-gws");
    expect(p.user).toContain("Diwali offer");
    for (const o of COPILOT_OBJECTIVES) expect(p.system).toContain(o);
    for (const pl of PLATFORMS) expect(p.system).toContain(pl);
  });

  it("keeps valid AI fields", () => {
    const d = mergeAiPrefill({
      name: "Diwali Workspace for Delhi", itemId: "i-gws", objective: "traffic",
      platforms: ["google-ads"], ageMin: 30, ageMax: 50, genders: ["male"], regions: ["Delhi", "Haryana"],
    }, "Diwali offer", ITEMS);
    expect(d).toMatchObject({
      name: "Diwali Workspace for Delhi", itemId: "i-gws", objective: "traffic", platforms: ["google-ads"],
      audience: { ageMin: 30, ageMax: 50, genders: ["male"], regions: ["Delhi", "Haryana"], lookalike: false },
    });
  });

  it("drops what is not real: unknown item, objective, platform, region; bad ages", () => {
    const d = mergeAiPrefill({
      name: "", itemId: "i-not-ours", objective: "world_peace", platforms: ["tiktok"],
      ageMin: 5, ageMax: 200, genders: ["robot"], regions: ["Atlantis", "Delhi"],
    }, "Tally Prime enquiries", ITEMS);
    expect(d.itemId).toBe("i-tally");            // the guess, not the AI's made-up id
    expect(d.objective).toBe("lead_gen");
    expect(d.platforms).toEqual(["google-ads", "meta-ads"]);
    expect(d.audience.ageMin).toBe(18);
    expect(d.audience.ageMax).toBe(65);
    expect(d.audience.genders).toEqual([]);
    expect(d.audience.regions).toEqual(["Delhi"]);
    expect(d.name.length).toBeGreaterThan(0);
  });

  it("not an object at all → the guess", () => {
    expect(mergeAiPrefill(null, "Tally Prime enquiries", ITEMS)).toEqual(guessFromPrompt("Tally Prime enquiries", ITEMS));
  });
});

describe("normalizePlan — what is saved", () => {
  it("removes a platform the objective cannot run on, and says so", () => {
    const r = normalizePlan(base({ objective: "engagement" }));
    expect(r.plan.platforms).toEqual(["meta-ads"]);
    expect(r.notes.join(" ")).toMatch(/Google Ads/);
  });

  it("lookalike is kept only with Meta", () => {
    expect(normalizePlan(base({ audience: { ...base().audience, lookalike: true } })).plan.audience.lookalike).toBe(true);
    expect(normalizePlan(base({ platforms: ["google-ads"], audience: { ...base().audience, lookalike: true } })).plan.audience.lookalike).toBe(false);
  });

  it("swaps ages that are back to front and de-duplicates regions", () => {
    const r = normalizePlan(base({ audience: { ageMin: 50, ageMax: 30, genders: ["female", "female"], regions: ["Delhi", "Delhi", "Goa"], lookalike: false } }));
    expect(r.plan.audience).toMatchObject({ ageMin: 30, ageMax: 50, genders: ["female"], regions: ["Delhi", "Goa"] });
  });

  it("no platform left → an error, nothing to save", () => {
    const r = normalizePlan(base({ objective: "awareness", platforms: ["google-ads"] }));
    expect(r.error).toMatch(/platform/i);
  });

  it("the schema refuses unknown values and long names", () => {
    expect(planDraftSchema.safeParse(base()).success).toBe(true);
    expect(planDraftSchema.safeParse(base({ name: "x".repeat(121) })).success).toBe(false);
    expect(planDraftSchema.safeParse({ ...base(), objective: "nope" }).success).toBe(false);
    expect(planDraftSchema.safeParse({ ...base(), platforms: ["tiktok"] }).success).toBe(false);
    expect(planDraftSchema.safeParse({ ...base(), audience: { ...base().audience, regions: ["Atlantis"] } }).success).toBe(false);
  });
});

describe("target groups ↔ audience", () => {
  it("one main group for all platforms, plus a Meta lookalike group when asked", () => {
    const rows = targetGroupRows(base({ audience: { ...base().audience, lookalike: true } }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ platform: null, kind: "generic", age_min: 25, age_max: 55, regions: ["Delhi"] });
    expect(rows[1]).toMatchObject({ platform: "meta-ads", kind: "lookalike" });
    expect(targetGroupRows(base())).toHaveLength(1);
  });

  it("reads back the same audience", () => {
    const a = { ageMin: 25, ageMax: 55, genders: ["female" as const], regions: ["Delhi"], lookalike: true };
    expect(audienceFromGroups(targetGroupRows(base({ audience: a })))).toEqual(a);
    expect(audienceFromGroups([])).toEqual({ ageMin: 18, ageMax: 65, genders: [], regions: [], lookalike: false });
  });
});

describe("objectiveInPrompt (R-2159) — the goal only when the words name one", () => {
  it("names the objective the words say, or null when they say none (guessFromPrompt then defaults to leads)", () => {
    expect(objectiveInPrompt("Launch a campaign to increase sales of Google Workspace in Delhi, ₹500/day")).toBe("sales");
    expect(objectiveInPrompt("More enquiries for Tally in Pune")).toBe("lead_gen");
    expect(objectiveInPrompt("Google Workspace in Delhi")).toBeNull();
    expect(guessFromPrompt("Google Workspace in Delhi", ITEMS).objective).toBe("lead_gen");
  });
});
