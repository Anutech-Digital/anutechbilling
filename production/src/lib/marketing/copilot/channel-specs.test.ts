/**
 * R-1875 — channel specs for the campaign co-pilot: copy limits + objective map, one place.
 * Every number here was read from the platform's own page on 25 Oct 2026 (URLs in
 * channel-specs.ts). A test that fails here means a number moved — re-read the source page
 * before changing it, never from memory.
 */
import { describe, it, expect } from "vitest";
import {
  CHANNEL_SPECS, COPILOT_OBJECTIVES, fitCheck, fieldSpec, objectiveFor, PLATFORMS,
} from "./channel-specs";

describe("Google Ads — responsive search ad (official limits)", () => {
  it("headline 30 chars, 3–15 of them", () => {
    expect(fieldSpec("google-ads", "search", "headline")).toMatchObject({ max: 30, minCount: 3, maxCount: 15 });
  });
  it("description 90 chars, 2–4 of them", () => {
    expect(fieldSpec("google-ads", "search", "description")).toMatchObject({ max: 90, minCount: 2, maxCount: 4 });
  });
  it("display path 15 chars, up to 2", () => {
    expect(fieldSpec("google-ads", "search", "path")).toMatchObject({ max: 15, minCount: 0, maxCount: 2 });
  });
});

describe("Google Ads — Performance Max text assets (official limits)", () => {
  it("headline 30 (3–15), long headline 90 (1–5), description 90 (2–5), business name 25 (1)", () => {
    expect(fieldSpec("google-ads", "performance_max", "headline")).toMatchObject({ max: 30, minCount: 3, maxCount: 15 });
    expect(fieldSpec("google-ads", "performance_max", "long_headline")).toMatchObject({ max: 90, minCount: 1, maxCount: 5 });
    expect(fieldSpec("google-ads", "performance_max", "description")).toMatchObject({ max: 90, minCount: 2, maxCount: 5 });
    expect(fieldSpec("google-ads", "performance_max", "business_name")).toMatchObject({ max: 25, minCount: 1, maxCount: 1 });
  });
});

describe("Meta — feed image ad (Meta publishes RECOMMENDED lengths, no hard maximum)", () => {
  it("primary text recommended 50–150, headline recommended 27; max is null, not invented", () => {
    expect(fieldSpec("meta-ads", "feed_image", "primary_text")).toMatchObject({ max: null, recommendedMin: 50, recommended: 150 });
    expect(fieldSpec("meta-ads", "feed_image", "headline")).toMatchObject({ max: null, recommended: 27 });
  });

  it("R-1897: up to 5 primary texts / headlines / descriptions (asset feed options); AI writes 3 + 3 + 1; one CTA from the list", () => {
    expect(fieldSpec("meta-ads", "feed_image", "primary_text")).toMatchObject({ minCount: 1, maxCount: 5, aiCount: 3 });
    expect(fieldSpec("meta-ads", "feed_image", "headline")).toMatchObject({ minCount: 1, maxCount: 5, aiCount: 3 });
    expect(fieldSpec("meta-ads", "feed_image", "description")).toMatchObject({ max: null, recommended: null, minCount: 0, maxCount: 5, aiCount: 1 });
    const cta = fieldSpec("meta-ads", "feed_image", "cta")!;
    expect(cta).toMatchObject({ minCount: 1, maxCount: 1 });
    expect(cta.choices!.map((c) => c.value)).toEqual(expect.arrayContaining(["LEARN_MORE", "GET_QUOTE", "SHOP_NOW", "CONTACT_US"]));
  });
});

describe("every number has an official source", () => {
  it("each field and format cites an https URL on the platform's own domain", () => {
    for (const p of PLATFORMS) {
      for (const f of CHANNEL_SPECS[p].formats) {
        for (const field of f.fields) {
          expect(field.source, `${p}/${f.key}/${field.key}`).toMatch(
            p === "google-ads" ? /^https:\/\/(support|developers)\.google\.com\// : /^https:\/\/(www\.facebook\.com|developers\.facebook\.com)\//,
          );
          // R-1897: a pick-from-list field (CTA) has no length; Meta publishes no length for the description.
          if (field.choices || (p === "meta-ads" && field.key === "description")) continue;
          expect(field.max ?? field.recommended, `${p}/${f.key}/${field.key} has no number`).not.toBeNull();
        }
      }
    }
  });
});

describe("fitCheck", () => {
  const headline = fieldSpec("google-ads", "search", "headline")!;
  it("30 chars fits a Google headline, 31 is over by 1", () => {
    expect(fitCheck("a".repeat(30), headline)).toEqual({ ok: true, length: 30, over: 0, limit: 30, kind: "max" });
    expect(fitCheck("a".repeat(31), headline)).toEqual({ ok: false, length: 31, over: 1, limit: 30, kind: "max" });
  });
  it("counts characters, not UTF-16 units (₹ and emoji are one each)", () => {
    expect(fitCheck("₹".repeat(30), headline).ok).toBe(true);
    expect(fitCheck("🚀".repeat(30), headline)).toMatchObject({ ok: true, length: 30 });
  });
  it("trims the ends before counting", () => {
    expect(fitCheck("  " + "a".repeat(30) + " ", headline).ok).toBe(true);
  });
  it("Meta: checks against the recommended length and says so", () => {
    const meta = fieldSpec("meta-ads", "feed_image", "headline")!;
    expect(fitCheck("a".repeat(28), meta)).toEqual({ ok: false, length: 28, over: 1, limit: 27, kind: "recommended" });
  });
});

describe("objective map", () => {
  it("every co-pilot objective maps on Meta", () => {
    for (const o of COPILOT_OBJECTIVES) expect(objectiveFor("meta-ads", o), o).toBeTruthy();
  });
  it("Google: traffic + leads → Search, sales → Performance Max; awareness / engagement not offered yet (no Display/Video copy specs)", () => {
    expect(objectiveFor("google-ads", "traffic")).toMatchObject({ value: "SEARCH", format: "search" });
    expect(objectiveFor("google-ads", "lead_gen")).toMatchObject({ value: "SEARCH", format: "search" });
    expect(objectiveFor("google-ads", "sales")).toMatchObject({ value: "PERFORMANCE_MAX", format: "performance_max" });
    expect(objectiveFor("google-ads", "awareness")).toBeNull();
    expect(objectiveFor("google-ads", "engagement")).toBeNull();
  });
  it("Meta uses only the six OUTCOME_* objectives", () => {
    const allowed = ["OUTCOME_APP_PROMOTION", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC"];
    for (const o of COPILOT_OBJECTIVES) expect(allowed).toContain(objectiveFor("meta-ads", o)!.value);
    expect(objectiveFor("meta-ads", "lead_gen")!.value).toBe("OUTCOME_LEADS");
    expect(objectiveFor("meta-ads", "awareness")!.value).toBe("OUTCOME_AWARENESS");
  });
  it("Google uses AdvertisingChannelType values, and each maps to a format we have copy specs for", () => {
    const allowed = ["SEARCH", "PERFORMANCE_MAX"];
    for (const o of COPILOT_OBJECTIVES) {
      const g = objectiveFor("google-ads", o);
      if (!g) continue;
      expect(allowed).toContain(g.value);
      expect(CHANNEL_SPECS["google-ads"].formats.some((f) => f.key === g.format)).toBe(true);
    }
  });
});

describe("audiences", () => {
  it("lookalike: Meta yes, Google no (Similar Audiences sunset)", () => {
    expect(CHANNEL_SPECS["meta-ads"].lookalike).toBe(true);
    expect(CHANNEL_SPECS["google-ads"].lookalike).toBe(false);
  });
});
