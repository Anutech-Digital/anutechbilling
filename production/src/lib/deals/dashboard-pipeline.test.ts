/**
 * R-1474 — one pipeline definition for the whole dashboard.
 *
 * Pawan (staging, 16 Oct): top cards "₹15.6L, 4 open deals"; Pipeline by stage "₹20.1L across
 * 7 deals" over 9 rows (Won included) summing to ₹25.5L; Today's focus "7 active leads, ₹20.1L".
 * The same leads must give the same open count and value in every place, and Won is never
 * inside the open total.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  dashboardPipeline, stageTotalsFromRows, summarizeDealStrip, OPEN_DEAL_STAGES, type DealRow,
} from "./pipeline-summary";

const NOW = new Date("2026-10-16T08:00:00Z");
let n = 0;
const lead = (stage: DealRow["stage"], value: number): DealRow => ({
  id: `l${++n}`, company: `Co ${n}`, stage, value, expected_close_date: null,
  stage_changed_at: "2026-10-10T05:00:00Z", created_at: "2026-10-01T05:00:00Z", owner_id: null, lost_at: null,
});

/* Pawan's shape: 4 open deals worth ₹15.6L, plus New / Contacted leads and two Won deals. */
const LEADS: DealRow[] = [
  lead("new", 200_000), lead("contact", 250_000),
  lead("quote", 600_000), lead("quote", 400_000), lead("demo", 360_000), lead("trial", 200_000),
  lead("won", 300_000), lead("won", 240_000),
];

describe("dashboardPipeline — the dashboard's one pipeline definition (R-1474)", () => {
  const p = dashboardPipeline(stageTotalsFromRows(LEADS));

  it("open = the Deals page's open stages (quote / demo / trial) at full leads.value", () => {
    expect(p.open).toEqual({ count: 4, value: 1_560_000 });
  });

  it("matches the Deals strip / top cards for the same leads", () => {
    expect(p.open).toEqual(summarizeDealStrip(LEADS, NOW).pipeline);
  });

  it("the stage rows are exactly the open stages and add up to the header", () => {
    expect(p.stages.map((s) => s.stage).sort()).toEqual([...OPEN_DEAL_STAGES].sort());
    expect(p.stages.reduce((s, r) => s + r.count, 0)).toBe(p.open.count);
    expect(p.stages.reduce((s, r) => s + r.value, 0)).toBe(p.open.value);
  });

  it("Won is shown separately, never inside the open total", () => {
    expect(p.stages.some((s) => (s.stage as string) === "won")).toBe(false);
    expect(p.won).toEqual({ count: 2, value: 540_000 });
  });

  it("New / Contacted leads are not pipeline", () => {
    expect(p.stages.some((s) => (s.stage as string) === "new" || (s.stage as string) === "contact")).toBe(false);
  });

  it("no data → zeros, not undefined", () => {
    expect(dashboardPipeline(undefined)).toEqual({
      open: { count: 0, value: 0 },
      stages: OPEN_DEAL_STAGES_IN_ORDER.map((stage) => ({ stage, count: 0, value: 0 })),
      won: { count: 0, value: 0 },
    });
  });
});

const OPEN_DEAL_STAGES_IN_ORDER = ["quote", "demo", "trial"] as const;

describe("dashboard page reads the one definition (R-1474)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../app/(app)/dashboard/page.tsx"), "utf8");

  it("uses dashboardPipeline and no private open-stage sum", () => {
    expect(src).toContain("dashboardPipeline(");
    expect(src).not.toMatch(/LEAD_STAGES\.filter\(\(s\) => s\.id !== "won"\)/);
  });

  it("top card, Pipeline by stage and Today's focus read the same figure", () => {
    expect(src).not.toMatch(/active leads in pipeline/);
    expect(src).not.toMatch(/dealStrip\.pipeline/);
  });
});
