import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  boardServerTotals, everythingCountForPage, folderShownOnPage, openKpiForPage, pageStages, scopeFiltersForPage, stageShownOnPage,
} from "@/lib/leads/page-scope";
import { toLeadCountsFilters, toListLeadsFilters, type LeadListFilters } from "@/lib/leads/list-page";

/* R-057 (Pardeep, 30 Sep 2026): "Won leads sirf Deals page par (Leads page se hatao)".
   Deals audit (30 Sep 2026): /deals holds only real deals — quote, demo, trial, won, lost.
   These pin the params both RPCs receive on each page. */

const base: LeadListFilters = { smart_view: "everything", folder: "all", owner_ids: ["u1"] };
const folders = { inbox: 9, talks: 26, quoted: 4, proving: 3, won: 2, lost: 5, hot: 1, followup: 0 };

describe("R-057 — Leads page leaves out won", () => {
  it("Leads page: list_leads and lead_counts params carry stages without won", () => {
    const f = scopeFiltersForPage(base, false);
    for (const p of [toListLeadsFilters(f), toLeadCountsFilters(f)]) {
      expect(p.stages).toBeDefined();
      expect(p.stages).not.toContain("won");
      expect(p.stages).toEqual(expect.arrayContaining(["new", "contact", "demo", "trial", "quote", "lost"]));
    }
  });

  it("Leads page: a stage pick is kept, minus won; a won-only pick cannot bring won back", () => {
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new"] }, false)).stages).toEqual(["new"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new", "won"] }, false)).stages).toEqual(["new"]);
    const wonOnly = toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["won"] }, false));
    expect(wonOnly.stages?.length).toBeGreaterThan(0);
    expect(wonOnly.stages).not.toContain("won");
  });

  it('"All leads" count on /leads subtracts the won leads of the same base', () => {
    const counts = { workspace: { junk: 2, everything: 37, suspects: 0 },
      kpi: { open_count: 30, open_value: 0, open_value_project: 0, won: 4, lost: 3 }, folders };
    expect(everythingCountForPage(counts, false)).toBe(33);
  });
});

describe("Deals page = only real deals (quote → won / lost)", () => {
  it("both RPCs get exactly the deal stages — no New / Contacted", () => {
    const f = scopeFiltersForPage(base, true);
    for (const p of [toListLeadsFilters(f), toLeadCountsFilters(f)]) {
      expect(p.stages).toEqual(["demo", "lost", "quote", "trial", "won"]);
    }
  });

  it("a stage pick is kept; a New-only pick cannot bring New back", () => {
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["won"] }, true)).stages).toEqual(["won"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new", "quote"] }, true)).stages).toEqual(["quote"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new"] }, true)).stages)
      .toEqual(["demo", "lost", "quote", "trial", "won"]);
  });

  it("stageShownOnPage / pageStages", () => {
    expect(stageShownOnPage("won", false)).toBe(false);
    expect(stageShownOnPage("won", true)).toBe(true);
    expect(stageShownOnPage("lost", false)).toBe(true);
    expect(stageShownOnPage("new", true)).toBe(false);
    expect(stageShownOnPage("contact", true)).toBe(false);
    expect(pageStages(true).sort()).toEqual(["demo", "lost", "quote", "trial", "won"]);
  });

  it("folders: no Inbox / Talks on /deals, no Won on /leads", () => {
    expect(folderShownOnPage("inbox", true)).toBe(false);
    expect(folderShownOnPage("talks", true)).toBe(false);
    expect(folderShownOnPage("quoted", true)).toBe(true);
    expect(folderShownOnPage("won", false)).toBe(false);
    expect(folderShownOnPage("inbox", false)).toBe(true);
  });

  it('"Saari deals" count = the deal folders, not every lead in the workspace', () => {
    const counts = { workspace: { junk: 2, everything: 49, suspects: 0 },
      kpi: { open_count: 42, open_value: 0, open_value_project: 0, won: 2, lost: 5 }, folders };
    expect(everythingCountForPage(counts, true)).toBe(4 + 3 + 2 + 5);
  });
});

describe("the page wiring", () => {
  const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");

  it("sends the scoped filters to BOTH readers", () => {
    expect(src).toMatch(/listFilters = React\.useMemo<LeadListFilters>\(\(\) => scopeFiltersForPage\(\{/);
    expect(src).toMatch(/\}, isDealsPage\), \[/);
    expect(src).toContain("useLeadCounts(listFilters)");
    expect(src).toContain("useLeadsInfinite(listFilters,");
    expect(src).toContain("everythingCount={everythingCountForPage(counts, isDealsPage)}");
  });

  it("the board reads only this page's columns", () => {
    expect(src).toMatch(/useLeadsBoard\([^)]*stages: boardStages/);
    expect(src).toContain("stages={DEAL_STAGES.filter((s) => stageShownOnPage(s.id, isDealsPage))}");
  });

  it("R-070: the board's column totals come from lead_counts (same filters as the list)", () => {
    expect(src).toContain("serverColumnTotals={boardServerTotals(counts, folder, smartView)}");
  });
});

describe("R-070 — View-menu counts are the page's (page_stages)", () => {
  it("/deals sends page_stages = the deal stages to lead_counts, whatever the stage pick", () => {
    const f = scopeFiltersForPage({ ...base, stages: ["quote"] }, true);
    expect(toLeadCountsFilters(f).page_stages).toEqual(["demo", "lost", "quote", "trial", "won"]);
    expect(toLeadCountsFilters(f).stages).toEqual(["quote"]);
  });

  it("/leads sends its own page stages (no won)", () => {
    expect(toLeadCountsFilters(scopeFiltersForPage(base, false)).page_stages).toEqual(
      ["contact", "demo", "lost", "new", "quote", "trial"]);
  });

  it("list_leads never receives page_stages — its query key is unchanged", () => {
    expect(toListLeadsFilters(scopeFiltersForPage(base, true))).not.toHaveProperty("page_stages");
  });
});

describe("R-070 — boardServerTotals", () => {
  const stage_totals = {
    quote: { count: 350, value: 9_00_000, weighted: 7_20_000 },
    won: { count: 2, value: 1_50_000, weighted: 1_50_000 },
    lost: { count: 5, value: 2_00_000, weighted: 0 },
  };

  it("hands the board the server's totals when it shows the counted set — minus Lost", () => {
    expect(boardServerTotals({ stage_totals }, "all", "everything")).toEqual({
      quote: stage_totals.quote, won: stage_totals.won,
    });
  });

  it("none under a folder or the Junk view (the board shows the list cut there)", () => {
    expect(boardServerTotals({ stage_totals }, "quoted", "everything")).toBeUndefined();
    expect(boardServerTotals({ stage_totals }, "all", "junk")).toBeUndefined();
  });

  it("none before the counts arrive or from a server without the migration — the board then says ≈", () => {
    expect(boardServerTotals(undefined, "all", "everything")).toBeUndefined();
    expect(boardServerTotals({}, "all", "everything")).toBeUndefined();
  });
});

describe("R-470 openKpiForPage — Open deals counts only what /deals can list", () => {
  const kpi = { open_count: 1, open_value: 64800, open_value_project: 0, won: 6, lost: 2 };
  // Gupta Traders sits in Contacted: in kpi, not in any /deals stage.
  const stage_totals = {
    won: { count: 6, value: 155520, weighted: 155520 },
    lost: { count: 2, value: 25900, weighted: 0 },
  };

  it("/deals with no open quote / demo / trial reads 0 and ₹0, not the Contacted lead", () => {
    expect(openKpiForPage({ kpi, stage_totals }, true)).toEqual({ openCount: 0, openValue: 0, openValueProject: null });
  });

  it("/deals sums quote + demo + trial only", () => {
    const st = { ...stage_totals, quote: { count: 2, value: 40000, weighted: 20000 }, trial: { count: 1, value: 9000, weighted: 6000 } };
    expect(openKpiForPage({ kpi, stage_totals: st }, true)).toEqual({ openCount: 3, openValue: 49000, openValueProject: null });
  });

  it("/leads keeps the workspace kpi", () => {
    expect(openKpiForPage({ kpi, stage_totals }, false)).toEqual({ openCount: 1, openValue: 64800, openValueProject: 0 });
  });

  it("a server without stage_totals falls back to kpi", () => {
    expect(openKpiForPage({ kpi }, true).openCount).toBe(1);
  });
});
