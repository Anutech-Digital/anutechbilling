import { describe, it, expect } from "vitest";
import {
  PIPELINES, pipelineDef, pipelineLabel, stagesFor, stageFitsPipeline, pipelineCounts,
} from "./pipelines";
import type { Lead } from "@/lib/supabase/database.types";

describe("PIPELINES", () => {
  it("has the three motions the brief asked for", () => {
    expect(PIPELINES.map((p) => p.id)).toEqual(["new_logo", "migration", "renewal"]);
  });

  it("every motion explains itself — a switcher whose options need explaining is a bad one", () => {
    for (const p of PIPELINES) {
      expect(p.hint.length).toBeGreaterThan(30);
      expect(p.stages.length).toBeGreaterThan(0);
    }
  });

  it("every motion keeps won and lost — a deal must always be closable", () => {
    /* Dropping a terminal stage from a motion would trap deals in it with no way out. */
    for (const p of PIPELINES) {
      expect(p.stages).toContain("won");
      expect(p.stages).toContain("lost");
    }
  });
});

describe("stage flow differs by motion", () => {
  it("new logo runs the full funnel", () => {
    expect(stagesFor("new_logo")).toEqual(["new", "contact", "quote", "demo", "trial", "won", "lost"]);
  });

  it("migration drops demo — they already use the product", () => {
    expect(stagesFor("migration")).not.toContain("demo");
    // Trial stays: the migration itself is the thing that has to be proven.
    expect(stagesFor("migration")).toContain("trial");
  });

  it("renewal drops both demo and trial — running either for a paying customer is theatre", () => {
    const s = stagesFor("renewal");
    expect(s).not.toContain("demo");
    expect(s).not.toContain("trial");
    expect(s).toContain("quote");
  });

  it("each motion is a subset of the full funnel — no motion invents a stage", () => {
    const full = new Set(stagesFor("new_logo"));
    for (const p of PIPELINES) {
      for (const s of p.stages) expect(full.has(s)).toBe(true);
    }
  });
});

describe("pipelineDef — never returns undefined", () => {
  it("falls back to new_logo for null, undefined and nonsense", () => {
    for (const v of [null, undefined, "bogus" as Lead["pipeline"]]) {
      expect(pipelineDef(v).id).toBe("new_logo");
    }
  });

  it("labels are human, not enum values", () => {
    expect(pipelineLabel("new_logo")).toBe("New Logo");
    expect(pipelineLabel("renewal")).toBe("Renewals & Expansion");
  });
});

describe("stageFitsPipeline — a check, not a block", () => {
  it("reports a stage that does not belong to the motion", () => {
    expect(stageFitsPipeline("demo", "renewal")).toBe(false);
    expect(stageFitsPipeline("quote", "renewal")).toBe(true);
  });

  it("exists so the UI can WARN rather than rewrite", () => {
    /* A deal already in `demo` when somebody switches it to the renewal motion keeps its
       stage. Silently moving it would rewrite history; refusing the switch would trap
       the rep. The check only makes the oddity visible. */
    expect(stageFitsPipeline("demo", "renewal")).toBe(false);
    // and it does not throw, mutate, or coerce anything.
  });
});

describe("pipelineCounts", () => {
  const l = (pipeline: Lead["pipeline"]) => ({ pipeline }) as Lead;

  it("counts each motion", () => {
    expect(pipelineCounts([l("new_logo"), l("new_logo"), l("migration")]))
      .toEqual({ new_logo: 2, migration: 1, renewal: 0 });
  });

  it("treats a null pipeline as new_logo, matching the column default", () => {
    expect(pipelineCounts([{ pipeline: null } as unknown as Lead]).new_logo).toBe(1);
  });

  it("returns zeros for an empty list rather than an empty object", () => {
    // A switcher rendering `undefined` badges is worse than one rendering 0.
    expect(pipelineCounts([])).toEqual({ new_logo: 0, migration: 0, renewal: 0 });
  });
});
