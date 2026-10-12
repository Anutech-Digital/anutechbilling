import { describe, it, expect } from "vitest";
import { stagesReached } from "./stages-reached";

describe("stagesReached — a ✓ needs evidence, not position", () => {
  it("Demo Co: accepted project quotation, straight to Won → only Quote ✓", () => {
    const r = stagesReached({
      stageMoves: ["won"],
      projectQuotes: [{ kind: "project", statusLabel: "Accepted" }],
    });
    expect([...r]).toEqual(["quote"]);
  });

  it("won with no evidence of earlier steps ticks nothing", () => {
    expect(stagesReached({ stageMoves: ["won"] }).size).toBe(0);
  });

  it("a draft quote or draft project quotation is not 'quote sent'", () => {
    const r = stagesReached({
      stageMoves: [],
      quotes: [{ status: "draft" }],
      projectQuotes: [{ kind: "project", statusLabel: "Draft" }],
    });
    expect(r.has("quote")).toBe(false);
  });

  it("sent / viewed / accepted subscription quotes count", () => {
    for (const status of ["sent", "viewed", "accepted", "rejected"]) {
      expect(stagesReached({ stageMoves: [], quotes: [{ status }] }).has("quote")).toBe(true);
    }
  });

  it("recorded moves and trial_started_at tick demo / trial", () => {
    const r = stagesReached({ stageMoves: ["quote", "demo"], trialStartedAt: "2026-09-20T05:00:00Z" });
    expect([...r].sort()).toEqual(["demo", "quote", "trial"]);
  });
});
