import { describe, it, expect } from "vitest";
import { MARKETING_TOOLS, MARKETING_HUB_SECTIONS, mergeTools, hubSummary, TOOL_GROUPS } from "./tool-catalog";
import { LEAD_SOURCES } from "@/lib/leads/lead-sources";

describe("marketing tool catalogue", () => {
  it("gives every marketing tool group one sidebar section link", () => {
    expect(MARKETING_HUB_SECTIONS.map((section) => section.group).sort()).toEqual(Object.keys(TOOL_GROUPS).sort());
    expect(new Set(MARKETING_HUB_SECTIONS.map((section) => section.id)).size).toBe(MARKETING_HUB_SECTIONS.length);
  });
  it("unique keys, a known group, and every channel is a real lead source", () => {
    const keys = MARKETING_TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sources = new Set(LEAD_SOURCES.map((s) => s.value));
    for (const t of MARKETING_TOOLS) {
      expect(TOOL_GROUPS[t.group], t.key).toBeTruthy();
      if (t.channel) expect(sources.has(t.channel), `${t.key} → ${t.channel}`).toBe(true);
      expect(t.setup.length, t.key).toBeGreaterThan(0);
    }
  });

  it("covers the tools this business cannot run without", () => {
    const keys = MARKETING_TOOLS.map((t) => t.key);
    for (const k of ["meta-ads", "google-ads", "google-business", "whatsapp-business", "indiamart", "email-campaigns"]) {
      expect(keys).toContain(k);
    }
  });

  it("a tool with no saved row is not started, with its channel's spend", () => {
    const rows = mergeTools([], { "meta-ads": 7080 });
    const meta = rows.find((r) => r.key === "meta-ads")!;
    expect(meta.state.status).toBe("not_started");
    expect(meta.spentThisMonth).toBe(7080);
    expect(rows.find((r) => r.key === "ga4")!.spentThisMonth).toBeNull();
    expect(rows.map((r) => r.key)).toEqual(MARKETING_TOOLS.map((t) => t.key));
  });

  it("summary: active count skips not-needed; ad budgets count even before activation; spend once per channel", () => {
    const rows = mergeTools([
      { tool_key: "meta-ads", status: "active", account_url: null, owner_name: "Pardeep", monthly_budget: 5000, notes: null },
      { tool_key: "google-ads", status: "paused", account_url: null, owner_name: null, monthly_budget: 9000, notes: null },
      { tool_key: "ga4", status: "not_needed", account_url: null, owner_name: null, monthly_budget: 0, notes: null },
    ], { "meta-ads": 7080, "google-organic": 100 });
    const s = hubSummary(rows);
    expect(s.active).toBe(1);
    expect(s.total).toBe(MARKETING_TOOLS.length - 1);
    expect(s.budget).toBe(14000);
    expect(s.spent).toBe(7180);            // google-organic shared by two tools, counted once
    expect(s.overBudget.map((r) => r.key)).toEqual(["meta-ads"]);
  });
});
