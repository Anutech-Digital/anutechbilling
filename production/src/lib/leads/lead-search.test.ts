/**
 * R-221 — the "Search leads & deals" box on /leads (staging report 5289b49f: typing a lead's
 * name did not filter properly, in List or Kanban).
 *
 * The box matched the WHOLE text as one substring of one field. So a stray space, two words
 * from different fields ("asha alpha" = contact + company), or a phone typed the way people
 * say it ("98765 43210" for "+91-98765-43210") found nothing. These cases hold the page's
 * board filter (searchLeads) AND the server rule's TS mirror (matchesListLeadsFilters) to the
 * same answer, so List and Kanban cannot disagree.
 */
import { describe, it, expect } from "vitest";
import type { Lead } from "@/lib/supabase/database.types";
import { searchLeads } from "./list-selectors";
import { matchesListLeadsFilters, toListLeadsFilters } from "./list-page";
import { leadMatchesSearch, normalizeLeadSearch } from "./lead-search";

let n = 0;
const mk = (over: Partial<Lead>): Lead => {
  n += 1;
  return {
    id: `S${n}`, company: `Co ${n}`, contact_name: null, contact_email: null, contact_phone: null,
    plan: null, stage: "new", priority: "medium", is_junk: false, owner_id: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    ...over,
  } as Lead;
};

const ROWS: Lead[] = [
  mk({ company: "Alpha Traders Pvt Ltd", contact_name: "Asha Verma", contact_email: "asha@alpha.in", contact_phone: "+91-98765-43210" }),
  mk({ company: "Beta Works", contact_name: "Rahul  Sharma", contact_email: "Rahul.S@Beta.IN", contact_phone: "9811122233" }),
  mk({ company: "Gamma Foods", contact_name: "Gita", contact_phone: "011 4567 8900", plan: "Business Starter" }),
  mk({ company: "Delta", contact_name: "Dev" }),
];
const ids = (ls: readonly { id: string }[]) => ls.map((l) => l.id);

/** What the board shows for this text, and what the list's server rule keeps. */
function both(search: string) {
  const board = searchLeads(ROWS, {
    search, stageFilter: [], priorityFilter: [], smartView: "everything",
    currentUser: null, dupFlagged: new Set(), now: new Date(2026, 9, 6, 12),
  });
  const f = toListLeadsFilters({ search });
  const list = ROWS.filter((l) => matchesListLeadsFilters(l, f));
  return { board: ids(board), list: ids(list) };
}

const [ALPHA, BETA, GAMMA] = ROWS.map((r) => r.id);

describe("R-221: the search box finds the lead the way people type it", () => {
  const cases: Array<[string, string[]]> = [
    ["asha", [ALPHA]],                         // contact name
    ["ALPHA traders", [ALPHA]],                // company, any case
    ["  alpha  ", [ALPHA]],                    // stray spaces around
    ["alpha   traders", [ALPHA]],              // double space inside
    ["asha alpha", [ALPHA]],                   // name + company (two fields)
    ["rahul sharma", [BETA]],                  // the stored name has two spaces
    ["rahul.s@beta.in", [BETA]],               // email, case-insensitive
    ["98765 43210", [ALPHA]],                  // phone typed with a space
    ["+91 98765 43210", [ALPHA]],              // with the country code
    ["09811122233", [BETA]],                   // with a leading 0
    ["9811122233", [BETA]],                    // plain digits
    ["01145678900", [GAMMA]],                  // landline, digits only
    ["starter", [GAMMA]],                      // plan
    ["asha beta", []],                         // words from two different leads
    ["nomatch", []],
  ];
  for (const [search, want] of cases) {
    it(`${JSON.stringify(search)} → ${want.join(",") || "none"} (board and list agree)`, () => {
      const { board, list } = both(search);
      expect(board).toEqual(want);
      expect(list).toEqual(want);
    });
  }

  it("a blank box keeps everything", () => {
    expect(both("   ").board).toEqual(ids(ROWS));
    expect(both("   ").list).toEqual(ids(ROWS));
  });
});

describe("normalizeLeadSearch — what goes to the server", () => {
  it("trims, lowercases and collapses spaces", () => {
    expect(normalizeLeadSearch("  Alpha \t Traders  ")).toBe("alpha traders");
    expect(normalizeLeadSearch("   ")).toBe("");
  });
  it("sends the normalized text, so two spellings of one search share one query key", () => {
    expect(toListLeadsFilters({ search: " Alpha  Traders " })).toEqual({ search: "alpha traders" });
  });
});

describe("leadMatchesSearch — short digit runs are ordinary text", () => {
  it("'2024' is not treated as a phone number (fewer than 5 digits)", () => {
    expect(leadMatchesSearch({ company: "Plan 2024", contact_name: null, contact_email: null, contact_phone: null, plan: null }, "2024")).toBe(true);
    expect(leadMatchesSearch({ company: "Acme", contact_name: null, contact_email: null, contact_phone: "+91 2024", plan: null }, "2024")).toBe(true);
  });
});
