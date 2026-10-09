/**
 * R-490 (R-410 re-check after the R-442 owner fix): "a new lead does not show on the Kanban
 * until reload". Two halves, both checked here without a browser:
 *  1. the cache — creating a lead invalidates ["leads"], and the board's query key starts
 *     with "leads", so the open board refetches;
 *  2. the board's own cut (page.tsx boardLeads) — the refetched row must survive it.
 *     Before R-442 a typed-in lead had owner_id null, and "My assigned" (smartView "mine")
 *     dropped it; a reload reset the view, which is why it "appeared after reload".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withCreatorAsOwner } from "@/lib/queries/leads";
import { boardCut, inWorkspace, listCut, searchLeads } from "./list-selectors";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import type { LeadListRow } from "./list-page";

const ME = "user-me";
const NOW = new Date("2026-10-09T06:45:00Z");

function boardFor(rows: LeadListRow[], smartView: SmartView, teamIds: string[] | null): LeadListRow[] {
  const workspace = teamIds === null ? rows : inWorkspace(rows, teamIds);
  const searched = searchLeads(workspace, {
    search: "", stageFilter: [], priorityFilter: [], smartView,
    currentUser: { userId: ME }, dupFlagged: new Set(), now: NOW,
  });
  return boardCut(searched, listCut(searched, "all", smartView, "2026-10-09"), "all", smartView);
}

const typedIn = (owner?: string | null) => {
  const insert = withCreatorAsOwner({ owner_id: owner, created_by: undefined as string | null | undefined }, ME);
  return {
    id: "L-NEW", stage: "new", is_junk: false, company: "Kumar Pharma", contact_name: "Amit",
    owner_id: insert.owner_id ?? null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    seats: 12, plan: "google-workspace", value: null, priority: "medium", source: "manual",
    follow_up_date: null, expected_close_date: null,
  } as unknown as LeadListRow;
};

describe("R-410: a new lead is on the board after the refetch", () => {
  it("Add lead / Quick add with no owner chosen → owned by me → visible in My assigned", () => {
    expect(boardFor([typedIn(undefined)], "mine", [ME]).map((l) => l.id)).toEqual(["L-NEW"]);
  });
  it("visible in the default views too", () => {
    for (const v of ["all", "everything"] as SmartView[]) {
      expect(boardFor([typedIn(undefined)], v, [ME, "boss"]).map((l) => l.id)).toEqual(["L-NEW"]);
    }
  });
  it("'Unassigned' picked on purpose stays out of My assigned (by design) but shows in Team", () => {
    expect(boardFor([typedIn(null)], "mine", [ME])).toEqual([]);
    expect(boardFor([typedIn(null)], "all", [ME]).map((l) => l.id)).toEqual(["L-NEW"]);
  });
  it("creating a lead invalidates the board's cache key", () => {
    const src = readFileSync(join(__dirname, "../queries/leads.ts"), "utf8");
    const create = src.slice(src.indexOf("export function useCreateLead"), src.indexOf("export function useCreateLead") + 2500);
    expect(create).toMatch(/invalidateQueries\(\{ queryKey: \["leads"\] \}\)/);
    expect(src).toMatch(/queryKey: \["leads", "board"/);
  });
});
