// @vitest-environment jsdom
//
// R-432 (staging 7 Oct): /leads?source=website with no website lead showed a blank page —
// no rows, no message, so the user thought the data was gone. Under the default
// "Everything" view the old hint never fired, and the Kanban drew empty columns.
// Pinned here: the words, the one "Clear filters" button, and that a truly empty
// workspace still gets the first-lead state instead.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  LeadsNoResults, LeadsStatusStates, hasActiveLeadFilters, showNoMatch, deepLinkOutcome,
  type LeadFilterState, type LeadsNoResultsProps,
} from "./leads-empty-states";

afterEach(cleanup);

const none: LeadFilterState = { search: "", stages: [], priorities: [], owners: [], sources: [], who: "team", folder: "all" };

describe("hasActiveLeadFilters", () => {
  it("is false with nothing narrowing the list", () => {
    expect(hasActiveLeadFilters(none)).toBe(false);
    expect(hasActiveLeadFilters({ ...none, search: "   " })).toBe(false);
  });
  it.each<[string, Partial<LeadFilterState>]>([
    ["search", { search: "acme" }],
    ["stage", { stages: ["trial"] }],
    ["priority", { priorities: ["high"] }],
    ["owner", { owners: ["u1"] }],
    ["source", { sources: ["website"] }],
    ["who=mine", { who: "mine" }],
    ["folder", { folder: "won" }],
  ])("is true for %s", (_n, over) => {
    expect(hasActiveLeadFilters({ ...none, ...over })).toBe(true);
  });
});

describe("showNoMatch", () => {
  const base = { isLoading: false, error: null, totalLeads: 12, shownCount: 0, smartView: "everything" as const };
  it("fires on the default Everything view (the R-432 gap) and on All open", () => {
    expect(showNoMatch(base)).toBe(true);
    expect(showNoMatch({ ...base, smartView: "all" })).toBe(true);
  });
  it("stays quiet while loading, on error, with rows, or in an empty workspace", () => {
    expect(showNoMatch({ ...base, isLoading: true })).toBe(false);
    expect(showNoMatch({ ...base, error: new Error("x") })).toBe(false);
    expect(showNoMatch({ ...base, shownCount: 3 })).toBe(false);
    expect(showNoMatch({ ...base, totalLeads: 0 })).toBe(false);
    expect(showNoMatch({ ...base, totalLeads: undefined })).toBe(false);
  });
  it("leaves the other smart views to their own message", () => {
    expect(showNoMatch({ ...base, smartView: "hot" })).toBe(false);
  });
});

const props = (over: Partial<LeadsNoResultsProps> = {}): LeadsNoResultsProps => ({
  isLoading: false, error: null, totalLeads: 12, shownCount: 0, smartView: "everything",
  isDealsPage: false, search: "", filtersActive: true, onClearFilters: () => {}, ...over,
});

describe("<LeadsNoResults>", () => {
  it('says "No leads match these filters" and Clear filters resets them', () => {
    const clear = vi.fn();
    render(<LeadsNoResults {...props({ onClearFilters: clear })} />);
    expect(screen.getByText("No leads match these filters")).toBeTruthy();
    expect(screen.getByText(/still here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("names the search term", () => {
    render(<LeadsNoResults {...props({ search: "zzz" })} />);
    expect(screen.getByText(/Nothing matches "zzz"/)).toBeTruthy();
  });
  it('says "deals" on /deals', () => {
    render(<LeadsNoResults {...props({ isDealsPage: true })} />);
    expect(screen.getByText("No deals match these filters")).toBeTruthy();
  });
  it("renders nothing when there are rows", () => {
    render(<LeadsNoResults {...props({ shownCount: 2 })} />);
    expect(screen.queryByTestId("leads-no-match")).toBeNull();
  });
  it("without filters there is no Clear button to press for nothing", () => {
    render(<LeadsNoResults {...props({ filtersActive: false })} />);
    expect(screen.getByText("No leads in this view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear filters/ })).toBeNull();
  });
});

describe("<LeadsStatusStates> keeps the first-lead state for an empty workspace", () => {
  const status = { error: null, refetch: () => {}, isLoading: false, isDealsPage: false, isSales: false,
    setAddOpen: () => {}, setCsvImportOpen: () => {}, setSmartView: () => {} };
  it("empty workspace → No leads yet + Add your first lead, never the filter message", () => {
    render(<>
      <LeadsStatusStates {...status} totalLeads={0} shownCount={0} smartView="everything" filtersActive onClearFilters={() => {}} />
      <LeadsNoResults {...props({ totalLeads: 0 })} />
    </>);
    expect(screen.getByText("No leads yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add your first lead/ })).toBeTruthy();
    expect(screen.queryByText(/match these filters/)).toBeNull();
  });
  it("a smart view with filters on also offers Clear filters", () => {
    const clear = vi.fn();
    render(<LeadsStatusStates {...status} totalLeads={5} shownCount={0} smartView="hot" filtersActive onClearFilters={clear} />);
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("the page wires it for List and Kanban", () => {
  const page = readFileSync(join(__dirname, "../../../app/(app)/leads/page.tsx"), "utf8");
  it("Clear filters resets search, stage, priority, owner, source, who and folder — not sort", () => {
    const body = page.slice(page.indexOf("const clearAllFilters"), page.indexOf("const clearAllFilters") + 500);
    for (const call of ['setSearch("")', "setStageFilter([])", "setPriorityFilter([])", "setOwnerFilter([])",
      "setSourceFilter([])", 'setLeadTeamMode("team")', 'setFolder("all")']) {
      expect(body).toContain(call);
    }
    expect(body).not.toMatch(/setLeadSort/);
  });
  it("the Kanban is not drawn as empty columns when no card matches", () => {
    expect(page).toMatch(/effectiveView === "kanban" && boardLeads\.length > 0 && \(\s*<LeadsKanbanBoard/);
  });
});

/* R-1535: a failed load is not an empty workspace, and its box speaks plain words. */
describe("<LeadsStatusStates> on a failed load (R-1535)", () => {
  const status = { isLoading: false, isSales: false, totalLeads: undefined, shownCount: 0,
    smartView: "everything" as const, setAddOpen: () => {}, setCsvImportOpen: () => {}, setSmartView: () => {} };
  const RAW = "permission denied for table leads";
  it.each([false, true])("isDealsPage=%s: plain words + Try again, no raw text, no empty state", (isDealsPage) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const refetch = vi.fn();
    render(<LeadsStatusStates {...status} isDealsPage={isDealsPage} refetch={refetch} error={Object.assign(new Error(RAW), { code: "42501" })} />);
    expect(screen.getByText(isDealsPage ? /Deals didn.t load/ : /Leads didn.t load/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(RAW))).toBeNull();
    expect(screen.queryByText(/No (leads|deals) yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

/* R-1535: /leads?lead=<id> — "not found" only when the read SUCCEEDED with no row. */
describe("deepLinkOutcome", () => {
  it("waits until the read has finished", () => {
    expect(deepLinkOutcome({ isFetched: false, isError: false, data: undefined })).toBe("wait");
  });
  it("a failed read is 'error' (keep ?lead= and offer retry), not 'not-found'", () => {
    expect(deepLinkOutcome({ isFetched: true, isError: true, data: undefined })).toBe("error");
  });
  it("a successful read with no row is 'not-found'", () => {
    expect(deepLinkOutcome({ isFetched: true, isError: false, data: null })).toBe("not-found");
  });
  it("a row opens", () => {
    expect(deepLinkOutcome({ isFetched: true, isError: false, data: { id: "l1" } })).toBe("open");
  });
  it("the page no longer says 'not found' on a failed read", () => {
    const page = readFileSync(join(__dirname, "../../../app/(app)/leads/page.tsx"), "utf8");
    expect(page).toMatch(/deepLinkOutcome\(/);
    expect(page).not.toMatch(/toast\.error\(`Lead \$\{focusLeadId\} not found`\)/);
  });
});
