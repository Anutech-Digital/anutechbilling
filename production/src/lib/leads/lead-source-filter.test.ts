/**
 * R-392 (7 Oct 2026, Abhishek's report on /leads): "Google Ads" in the search box found
 * nothing, a lead could not be found by the person it is assigned to, and there was no
 * Source filter. The TS side of the fix — the board (searchLeads) and the server's mirror
 * (matchesListLeadsFilters). The SQL side is held by lead-source-search-sql.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { Lead } from "@/lib/supabase/database.types";
import { leadMatchesSearch } from "./lead-search";
import { sourceFilterOptions, sourceSearchText } from "./lead-sources";
import { matchesListLeadsFilters, toListLeadsFilters, type LeadListRow } from "./list-page";
import { searchLeads, type SearchInput } from "./list-selectors";

let seq = 0;
function mk(over: Partial<Lead> = {}): Lead {
  seq += 1;
  return {
    id: `L-${seq}`, tenant_id: "t1", company: `Acme ${seq} Pvt Ltd`, contact_name: `Person ${seq}`,
    contact_email: `p${seq}@acme.in`, contact_phone: "+91 98765 43210", plan: null, seats: null,
    value: null, stage: "new", owner_id: null, source: null, notes: null,
    created_at: "2026-09-01T06:00:00.000Z", updated_at: "2026-09-01T06:00:00.000Z",
    follow_up_date: null, priority: "medium", is_junk: false, expected_close_date: null,
    stage_changed_at: null, requires_human_attention: false, enquiry_type: "subscription",
    ...over,
  } as Lead;
}
const row = (l: Lead) => l as unknown as LeadListRow;

const base: SearchInput = {
  search: "", stageFilter: [], priorityFilter: [], smartView: "everything",
  currentUser: { userId: "u-me" }, dupFlagged: new Set(), now: new Date(2026, 9, 7, 12),
};
const ids = (ls: readonly Lead[]) => ls.map((l) => l.id);

describe("search matches the source (the reported bug)", () => {
  const google = mk({ source: "google-ads" });
  const meta = mk({ source: "meta-ads" });
  const none = mk();

  it("'Google Ads' finds a google-ads lead and nothing else", () => {
    expect(leadMatchesSearch(google, "Google Ads")).toBe(true);
    expect(leadMatchesSearch(meta, "Google Ads")).toBe(false);
    expect(leadMatchesSearch(none, "Google Ads")).toBe(false);
  });

  it("the label, the raw key and part of the label all work", () => {
    expect(leadMatchesSearch(meta, "instagram")).toBe(true);
    expect(leadMatchesSearch(meta, "meta-ads")).toBe(true);
    expect(leadMatchesSearch(google, "google-ads")).toBe(true);
  });

  it("an old row that saved the LABEL is found by the key's words too", () => {
    const old = mk({ source: "Added manually" });
    expect(leadMatchesSearch(old, "manual")).toBe(true);
    expect(sourceSearchText("Added manually")).toContain("added manually");
  });

  it("source words combine with other fields ('acme google')", () => {
    expect(leadMatchesSearch(google, `${google.company.split(" ")[0]} google`)).toBe(true);
  });

  it("an unknown free-text source is still searchable", () => {
    expect(leadMatchesSearch(mk({ source: "Partner-XYZ" }), "partner xyz")).toBe(true);
  });
});

describe("search matches the assigned person's name", () => {
  const asha = mk({ owner_id: "u-asha" });
  it("finds by the name passed for owner_id", () => {
    expect(leadMatchesSearch(asha, "asha", "Asha Verma")).toBe(true);
    expect(leadMatchesSearch(asha, "verma")).toBe(false);
  });

  it("the board (searchLeads) looks the name up in ownerNames", () => {
    const ravi = mk({ owner_id: "u-ravi" });
    const names = new Map([["u-asha", "Asha Verma"], ["u-ravi", "Ravi Kumar"]]);
    expect(ids(searchLeads([asha, ravi], { ...base, search: "asha", ownerNames: names }))).toEqual([asha.id]);
    expect(ids(searchLeads([asha, ravi], { ...base, search: "asha" }))).toEqual([]);
  });
});

describe("Source filter", () => {
  const g = mk({ source: "google-ads" });
  const gLabel = mk({ source: "Google Ads" }); // older row saved the label
  const m = mk({ source: "meta-ads" });
  const n = mk();

  it("board: keeps any-of the picked canonical keys; empty = all", () => {
    expect(ids(searchLeads([g, gLabel, m, n], { ...base, sourceFilter: ["google-ads"] }))).toEqual([g.id, gLabel.id]);
    expect(ids(searchLeads([g, m, n], { ...base, sourceFilter: ["google-ads", "meta-ads"] }))).toEqual([g.id, m.id]);
    expect(searchLeads([g, m, n], { ...base, sourceFilter: [] })).toHaveLength(3);
  });

  it("server mirror: sources key, sorted, dropped when empty", () => {
    expect(toListLeadsFilters({ sources: ["meta-ads", "google-ads"] }).sources).toEqual(["google-ads", "meta-ads"]);
    expect(toListLeadsFilters({ sources: [] })).not.toHaveProperty("sources");
    expect(matchesListLeadsFilters(row(gLabel), { sources: ["google-ads"] })).toBe(true);
    expect(matchesListLeadsFilters(row(m), { sources: ["google-ads"] })).toBe(false);
    expect(matchesListLeadsFilters(row(n), { sources: ["google-ads"] })).toBe(false);
  });

  it("server mirror: search uses the owner name passed in", () => {
    const a = mk({ owner_id: "u-asha" });
    expect(matchesListLeadsFilters(row(a), { search: "asha" }, "Asha Verma")).toBe(true);
    expect(matchesListLeadsFilters(row(a), { search: "asha" })).toBe(false);
  });

  it("options: only present sources, labelled, merged by canonical key, LEAD_SOURCES order", () => {
    expect(sourceFilterOptions({ "meta-ads": 2, "google-ads": 3, "Google Ads": 1, csv: 0, "Partner-XYZ": 1 })).toEqual([
      { value: "google-ads", label: "Google Ads", count: 4 },
      { value: "meta-ads", label: "Facebook / Instagram Ads", count: 2 },
      { value: "Partner-XYZ", label: "Partner-XYZ", count: 1 },
    ]);
    expect(sourceFilterOptions(undefined)).toEqual([]);
  });
});
