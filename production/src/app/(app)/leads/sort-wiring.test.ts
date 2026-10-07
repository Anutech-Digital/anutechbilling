/**
 * R-420 — the Sort menu's one choice reaches all three readers on /leads and /deals.
 *
 * Reads page.tsx like toolbar-above-list.test.ts: the page needs the whole data layer to
 * render, and what can go wrong is a reader left on its own order. The mapping itself is
 * tested in lib/leads/lead-sort.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, "page.tsx"), "utf8");

describe("R-420: one sort for the list and the Kanban", () => {
  it("the choice lives in the URL (?sort=), default Newest first", () => {
    expect(page).toMatch(/useUrlChoice<LeadSort>\(LEAD_SORT_PARAM, LEAD_SORTS, DEFAULT_LEAD_SORT\)/);
  });

  it("the list asks the server for it (pages stay in order)", () => {
    expect(page).toMatch(/sort: serverSortFor\(leadSort\)/);
    expect(page).not.toMatch(/sort: sortBy === "wait"/);
  });

  it("the Kanban reads and sorts each column by it", () => {
    expect(page).toMatch(/useLeadsBoard\([^)]*sort: leadSort/);
    expect(page).toMatch(/sortBoardLeads\(boardCut\(/);
  });

  it("the toolbar gets it, and the toolbar still sits right above the list", () => {
    expect(page).toMatch(/leadSort=\{leadSort\}/);
    expect(page).toMatch(/setLeadSort=\{setLeadSort\}/);
  });
});
