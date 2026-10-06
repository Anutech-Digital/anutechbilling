/** Characterization of the stage tables moved out of (app)/leads/page.tsx (S35). */
import { describe, it, expect } from "vitest";
import { DEAL_STAGES, LEAD_STAGES, STAGE_DOT, STAGE_LABEL, STAGE_META, filterStagesFor } from "./stage-meta";

describe("stage tables", () => {
  it("LEAD_STAGES is the six working stages, Lost excluded", () => {
    expect(LEAD_STAGES.map((s) => s.id)).toEqual(["new", "contact", "quote", "demo", "trial", "won"]);
  });

  it("the board's columns are in FUNNEL order and cover every stage the list can hold except Lost", () => {
    expect(DEAL_STAGES.map((s) => s.id)).toEqual(["new", "contact", "quote", "demo", "trial", "won"]);
    expect(DEAL_STAGES.every(Boolean)).toBe(true);
  });

  it("STAGE_META adds Lost at the end", () => {
    expect(STAGE_META.map((s) => s.id)).toEqual(["new", "contact", "quote", "demo", "trial", "won", "lost"]);
    expect(STAGE_META[6]).toEqual({ id: "lost", label: "Lost", dot: "bg-ink-3" });
  });

  it("labels and dots agree between the list table and the stage config", () => {
    for (const s of STAGE_META) {
      expect(STAGE_LABEL[s.id]).toBe(s.label);
      expect(STAGE_DOT[s.id]).toBe(s.dot);
    }
  });

  it("the Filter menu offers only the stages that can appear on the page", () => {
    expect(filterStagesFor(false).map((s) => s.id)).toEqual(["new", "contact"]);
    expect(filterStagesFor(true).map((s) => s.id)).toEqual(["quote", "demo", "trial", "won", "lost"]);
  });
});
