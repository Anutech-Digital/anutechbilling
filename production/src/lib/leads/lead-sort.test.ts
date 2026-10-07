import { describe, it, expect } from "vitest";
import { pickChoice, withChoice } from "@/lib/hooks/use-url-choice";
import {
  boardOrderFor, DEFAULT_LEAD_SORT, LEAD_SORT_LABELS, LEAD_SORT_PARAM, LEAD_SORTS, leadSortName, listHeaderSortFor,
  serverSortFor, sortBoardLeads, stageRank, type LeadSort,
} from "./lead-sort";
import { toLeadCountsFilters, toListLeadsFilters, type LeadListRow } from "./list-page";

let n = 0;
const row = (over: Partial<LeadListRow>): LeadListRow => {
  n += 1;
  return {
    id: `L${String(n).padStart(3, "0")}`, company: "", contact_name: null, contact_email: null, contact_phone: null,
    plan: null, seats: null, value: null, stage: "new", priority: "medium", owner_id: null, source: null,
    is_junk: false, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    follow_up_date: null, expected_close_date: null, stage_changed_at: null, enquiry_type: null,
    project_id: null, customer_id: null, requires_human_attention: false, pipeline: null,
    subscription_type: null, lost_reason: null, domain: null, human_attention_reason: null,
    ...over,
  } as LeadListRow;
};

describe("R-420 sort → query mapping", () => {
  it("default is Newest first, which is the server's 'created' and is not written to the query", () => {
    expect(DEFAULT_LEAD_SORT).toBe("newest");
    expect(serverSortFor("newest")).toBe("created");
    expect(toListLeadsFilters({ sort: serverSortFor("newest") })).toEqual({});
  });

  it("every other order goes to list_leads() as its own sort key", () => {
    const sent = Object.fromEntries(LEAD_SORTS.map((s) => [s, toListLeadsFilters({ sort: serverSortFor(s) }).sort]));
    expect(sent).toEqual({
      newest: undefined, oldest: "oldest", value: "value", followup: "followup", name: "name", stage: "stage", wait: "wait",
    });
  });

  it("two orders give two query keys; the counts ignore the order (same chips for every sort)", () => {
    expect(toListLeadsFilters({ sort: "value" })).not.toEqual(toListLeadsFilters({ sort: "name" }));
    expect(toLeadCountsFilters({ sort: "value", search: "acme" })).toEqual(toLeadCountsFilters({ search: "acme" }));
  });

  it("works together with search + source + stage filters", () => {
    expect(toListLeadsFilters({ search: " Acme ", sources: ["google-ads"], stages: ["quote"], sort: serverSortFor("followup") }))
      .toEqual({ search: "acme", sources: ["google-ads"], stages: ["quote"], sort: "followup" });
  });

  it("labels are short plain English (fit a 375px menu)", () => {
    for (const s of LEAD_SORTS) {
      expect(LEAD_SORT_LABELS[s].length).toBeLessThanOrEqual(20);
      expect(LEAD_SORT_LABELS[s]).not.toMatch(/^(Abhi|Current|Sort by)/i);
    }
  });
});

describe("R-420 URL round-trip (?sort=)", () => {
  it("writes a non-default order and reads it back", () => {
    for (const s of LEAD_SORTS) {
      const qs = withChoice("?q=acme&source=google-ads", LEAD_SORT_PARAM, s, DEFAULT_LEAD_SORT);
      const back = pickChoice(new URLSearchParams(qs).get(LEAD_SORT_PARAM), LEAD_SORTS, DEFAULT_LEAD_SORT);
      expect(back).toBe(s);
      /* The other filters survive. */
      expect(new URLSearchParams(qs).get("q")).toBe("acme");
      expect(new URLSearchParams(qs).get("source")).toBe("google-ads");
    }
  });

  it("the default is not written; an unknown value falls back to the default", () => {
    expect(withChoice("?sort=value", LEAD_SORT_PARAM, "newest", DEFAULT_LEAD_SORT)).toBe("");
    expect(pickChoice("bogus", LEAD_SORTS, DEFAULT_LEAD_SORT)).toBe("newest");
    expect(pickChoice(null, LEAD_SORTS, DEFAULT_LEAD_SORT)).toBe("newest");
  });
});

describe("R-420 list header mirrors the chosen order", () => {
  it.each<[LeadSort, string, string]>([
    ["newest", "created", "desc"], ["oldest", "created", "asc"], ["value", "value", "desc"],
    ["followup", "followup", "asc"], ["name", "contact", "asc"], ["stage", "stage", "asc"], ["wait", "wait", "desc"],
  ])("%s → %s %s", (s, col, dir) => {
    expect(listHeaderSortFor(s)).toEqual({ sortBy: col, sortDir: dir });
  });
});

describe("R-420 Kanban: cards sorted inside each column", () => {
  const a = row({ contact_name: "Zoya", value: 500, follow_up_date: "2026-10-09", created_at: "2026-10-01T00:00:00Z", stage: "quote" });
  const b = row({ contact_name: "arjun", value: 9000, follow_up_date: null, created_at: "2026-10-03T00:00:00Z", stage: "new" });
  const c = row({ company: "Mehta Traders", value: null, follow_up_date: "2026-10-08", created_at: "2026-10-02T00:00:00Z", stage: "won" });
  const d = row({ contact_name: "  ", company: "", value: 500, follow_up_date: "2026-10-09", created_at: "2026-10-04T00:00:00Z", stage: "new" });
  const ids = (s: LeadSort) => sortBoardLeads([a, b, c, d], s).map((r) => r.id);

  it("newest / oldest", () => {
    expect(ids("newest")).toEqual([d.id, b.id, c.id, a.id]);
    expect(ids("oldest")).toEqual([a.id, c.id, b.id, d.id]);
  });
  it("value high → low, no value last, newer first on a tie", () => {
    expect(ids("value")).toEqual([b.id, d.id, a.id, c.id]);
  });
  it("next follow-up soonest first, empty last, newer first on a tie", () => {
    expect(ids("followup")).toEqual([c.id, d.id, a.id, b.id]);
  });
  it("name A–Z ignoring case, no name last", () => {
    expect(leadSortName(c)).toBe("mehta traders");
    expect(ids("name")).toEqual([b.id, c.id, a.id, d.id]);
  });
  it("stage in funnel order, newer first inside a stage", () => {
    expect(stageRank("new")).toBeLessThan(stageRank("contact"));
    expect(stageRank("trial")).toBeLessThan(stageRank("won"));
    expect(stageRank("won")).toBeLessThan(stageRank("lost"));
    expect(ids("stage")).toEqual([d.id, b.id, a.id, c.id]);
  });
  it("does not change the input array", () => {
    const input = [a, b, c, d];
    sortBoardLeads(input, "value");
    expect(input.map((r) => r.id)).toEqual([a.id, b.id, c.id, d.id]);
  });
});

describe("R-420 Kanban column read follows the order (top 200 of a big column)", () => {
  it("newest, stage and wait share one read; the others read their own top", () => {
    expect(boardOrderFor("stage")).toEqual(boardOrderFor("newest"));
    expect(boardOrderFor("wait")).toEqual(boardOrderFor("newest"));
    expect(boardOrderFor("value")[0]).toEqual({ column: "value", ascending: false, nullsFirst: false });
    expect(boardOrderFor("followup")[0]).toEqual({ column: "follow_up_date", ascending: true, nullsFirst: false });
    expect(boardOrderFor("oldest")[0]).toEqual({ column: "created_at", ascending: true });
    /* Every order ends on the unique id, so the cut at 200 is stable. */
    for (const s of LEAD_SORTS) expect(boardOrderFor(s).at(-1)?.column).toBe("id");
  });
});
