import { describe, it, expect } from "vitest";
import { LEAD_SOURCES, canonicalSource, sourceOptions, sourceLabel } from "./lead-sources";
import { AD_CHANNELS } from "@/lib/marketing/ad-channels";

describe("lead sources", () => {
  const keys = LEAD_SOURCES.map((s) => s.value);

  it("every channel spend can be tagged with is also a lead source — same key", () => {
    for (const c of AD_CHANNELS) expect(keys, `${c.value} has spend but no leads can carry it`).toContain(c.value);
  });

  it("Facebook ads and the Facebook page are separate", () => {
    expect(keys).toContain("meta-ads");
    expect(keys).toContain("meta-organic");
  });

  it("no duplicates", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps an unknown saved source visible instead of blanking it", () => {
    expect(sourceOptions("meta-ads")).toEqual(LEAD_SOURCES.filter((s) => !s.auto));
    const opts = sourceOptions("old-partner-form");
    expect(opts.at(-1)).toEqual({ value: "old-partner-form", label: "old-partner-form" });
    expect(sourceOptions(null)).toEqual(LEAD_SOURCES.filter((s) => !s.auto));
  });

  it("labels", () => {
    expect(sourceLabel("meta-ads")).toBe("Facebook / Instagram Ads");
    expect(sourceLabel("xyz")).toBe("xyz");
    expect(sourceLabel(null)).toBe("—");
  });
});

describe("a saved source spelled differently is not listed twice (Deals audit, 30 Sep 2026)", () => {
  it('"Added manually" / "Manual" map to the manual key, and the dropdown has one "Added manually"', () => {
    for (const saved of ["Added manually", "Manual", " manual ", "MANUAL"]) {
      expect(canonicalSource(saved)).toBe("manual");
      expect(sourceOptions(saved).filter((s) => s.label === "Added manually")).toHaveLength(1);
      expect(sourceOptions(saved)).toEqual(LEAD_SOURCES.filter((s) => !s.auto));
    }
  });

  it("an unknown source still stays visible, once", () => {
    expect(canonicalSource("old-partner-form")).toBe("old-partner-form");
    expect(sourceOptions("old-partner-form").filter((s) => s.value === "old-partner-form")).toHaveLength(1);
    expect(sourceLabel("Added manually")).toBe("Added manually");
  });
});
