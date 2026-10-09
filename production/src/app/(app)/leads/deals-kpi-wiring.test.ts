// R-470: /deals "Show the numbers" reads page-scoped totals, and Kanban explains Lost.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const page = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("leads page — R-470 wiring", () => {
  it("the KPI drawer's open count and pipeline come from openKpiForPage", () => {
    expect(page).toMatch(/openKpiForPage\(counts, isDealsPage\)/);
    expect(page).toMatch(/openCount=\{openKpi\?\.openCount/);
    expect(page).toMatch(/totalValue=\{openKpi\?\.openValue/);
    expect(page).not.toMatch(/openCount=\{counts\.kpi\.open_count\}/);
  });
  it("Kanban with the Lost stage filter says Lost is in List view", () => {
    expect(page).toMatch(/stageFilter\.includes\("lost"\)/);
    expect(page).toContain('data-testid="kanban-lost-note"');
  });
});
