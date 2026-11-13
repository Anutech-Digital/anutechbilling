/**
 * R-2726 — /admin/feedback search, filters, sorting and paging.
 *
 * The owner's path first: on "All workspaces" he types "scorecard" and Hitesh's report must
 * show; reporter = hitesh + status open → only his open reports; a reload keeps the filters.
 * Then the access rule: nothing a tenant user can type widens the scope.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FEEDBACK_FILTERS,
  FEEDBACK_PAGE_SIZE,
  SEARCH_COLUMNS,
  activeFilterChips,
  applyFeedbackOps,
  applyFeedbackSort,
  buildFacets,
  escapeLikeText,
  feedbackFilterOps,
  feedbackFiltersToParams,
  filtersInScope,
  hasAnyFilter,
  isRealReporter,
  panelFilterCount,
  reporterKey,
  reporterNameRegex,
  nextVisitMemory,
  pageRange,
  parseFeedbackFilters,
  parseSince,
  quoteLogicValue,
  removeFilter,
  statusFilterOf,
  statusOps,
  tallyStatuses,
  type FeedbackFilters,
  type FeedbackOp,
  type FeedbackQueryLike,
} from "./list-filters";
import { parseQuery } from "@/server/postgrest/parse";

const F = (over: Partial<FeedbackFilters> = {}): FeedbackFilters => ({ ...DEFAULT_FEEDBACK_FILTERS, ...over });
const OTHER_TENANT = "11111111-1111-4111-8111-111111111111";

/** Records the calls a real postgrest-js builder would get, and the URL params they make. */
class Recorder implements FeedbackQueryLike<Recorder> {
  calls: string[] = [];
  params = new URLSearchParams();
  eq(c: string, v: string) { this.calls.push(`eq ${c} ${v}`); this.params.append(c, `eq.${v}`); return this; }
  gte(c: string, v: string) { this.calls.push(`gte ${c} ${v}`); this.params.append(c, `gte.${v}`); return this; }
  gt(c: string, v: string) { this.calls.push(`gt ${c} ${v}`); this.params.append(c, `gt.${v}`); return this; }
  lt(c: string, v: string) { this.calls.push(`lt ${c} ${v}`); this.params.append(c, `lt.${v}`); return this; }
  is(c: string, v: null) { this.calls.push(`is ${c} ${v}`); this.params.append(c, "is.null"); return this; }
  not(c: string, op: string, v: null) { this.calls.push(`not ${c} ${op} ${v}`); this.params.append(c, `not.${op}.null`); return this; }
  or(expr: string) { this.calls.push(`or ${expr}`); this.params.append("or", `(${expr})`); return this; }
  order(c: string, o: { ascending: boolean; nullsFirst?: boolean }) {
    this.calls.push(`order ${c} ${o.ascending ? "asc" : "desc"}${o.nullsFirst === false ? " nullslast" : ""}`);
    return this;
  }
}

const ors = (ops: FeedbackOp[]) => ops.filter((o): o is Extract<FeedbackOp, { k: "or" }> => o.k === "or").map((o) => o.expr);

describe("URL ↔ filters", () => {
  it("an empty URL is the default view: every status, newest first, page 1", () => {
    expect(parseFeedbackFilters(new URLSearchParams(""))).toEqual(DEFAULT_FEEDBACK_FILTERS);
    expect(feedbackFiltersToParams(DEFAULT_FEEDBACK_FILTERS).toString()).toBe("");
    expect(hasAnyFilter(DEFAULT_FEEDBACK_FILTERS)).toBe(false);
  });

  it("a reload keeps the filters — params round-trip", () => {
    const f = F({
      q: "scorecard total", status: "open", type: "bug", severity: "high", reporter: "hitesh@exceltechnologies.in",
      workspace: OTHER_TENANT, page: "/reports/scorecards", from: "2026-11-01", to: "2026-11-12", card: "none",
      real: true, fresh: true, sort: "oldest", pageNo: 3,
    });
    expect(parseFeedbackFilters(new URLSearchParams(feedbackFiltersToParams(f).toString()))).toEqual(f);
    expect(hasAnyFilter(f)).toBe(true);
  });

  it("unknown or malformed values fall back to the default instead of reaching a query", () => {
    const f = parseFeedbackFilters(new URLSearchParams(
      "status=deleted&type=drop&sev=x&card=maybe&sort=tenant_id&ws=not-a-uuid&from=2026-13-99&to=yesterday&p=-4&real=true&new=yes",
    ));
    expect(f).toEqual(DEFAULT_FEEDBACK_FILTERS);
  });

  it("search text is trimmed, single-spaced, capped at 100 characters and loses control characters", () => {
    const f = parseFeedbackFilters(new URLSearchParams({ q: `  score\u0000card \n  total ${"x".repeat(300)}` }));
    expect(f.q.startsWith("score card total xxx")).toBe(true);
    expect(f.q.length).toBe(100);
  });

  it("parseSince takes an ISO instant and nothing else", () => {
    expect(parseSince("2026-11-12T10:00:00.000Z")).toBe("2026-11-12T10:00:00.000Z");
    expect(parseSince("2026-11-12T15:30:00+05:30")).toBe("2026-11-12T10:00:00.000Z");
    expect(parseSince("now()")).toBeNull();
    expect(parseSince("")).toBeNull();
    expect(parseSince(null)).toBeNull();
  });
});

describe("search", () => {
  it("'scorecard' is looked for in title, body, reporter name/email, page path and card id", () => {
    const [expr] = ors(feedbackFilterOps(F({ q: "scorecard" }), { scope: "all" }));
    for (const col of ["title", "body", "reporter_name", "reporter_email", "page_path", "agent_card", "resolution_note"]) {
      expect(expr).toContain(`${col}.ilike."%scorecard%"`);
    }
    expect(expr.split(",").length).toBe(SEARCH_COLUMNS.length);
  });

  it("every word must match: one or=(…) per word, at most five", () => {
    expect(ors(feedbackFilterOps(F({ q: "hitesh scorecard" }), { scope: "mine" })).length).toBe(2);
    expect(ors(feedbackFilterOps(F({ q: "a b c d e f g" }), { scope: "mine" })).length).toBe(5);
  });

  it("ILIKE wildcards in the text are literal: % _ \\ escaped, * (PostgREST's %) becomes one character", () => {
    expect(escapeLikeText("100%_done\\*")).toBe("100\\%\\_done\\\\_");
    const [expr] = ors(feedbackFilterOps(F({ q: "%" }), { scope: "mine" }));
    expect(expr).toContain('title.ilike."%\\\\%%"'); // quoted: \ doubled → the pattern is %\%%
    expect(expr).not.toMatch(/ilike\."%%%"/);
    const [star] = ors(feedbackFilterOps(F({ q: "*" }), { scope: "mine" }));
    expect(star).not.toContain("*");
  });

  it("text cannot add a condition of its own: quotes, commas and brackets stay inside the value", () => {
    const evil = 'x",tenant_id.eq.' + OTHER_TENANT + ',title.ilike."';
    expect(quoteLogicValue('a"b\\c')).toBe('"a\\"b\\\\c"');
    const rec = applyFeedbackOps(new Recorder(), feedbackFilterOps(F({ q: evil.replace(/ /g, "") }), { scope: "mine" }));
    /* The data gateway's own parser reads the or=(…) the builder made: nine ilike conditions
       per word, every one on a search column, none on tenant_id. */
    const parsed = parseQuery(rec.params);
    const flat = JSON.stringify(parsed.scopes.get("")!.filters);
    expect(flat).not.toContain('"column":"tenant_id"');
    const logic = parsed.scopes.get("")!.filters[0] as { op: string; children?: unknown[]; conditions?: unknown[] };
    expect(JSON.stringify(logic).match(/"op":"ilike"/g)!.length).toBe(SEARCH_COLUMNS.length);
  });

  it("the same holds for the reporter and page pickers", () => {
    const rec = applyFeedbackOps(new Recorder(), feedbackFilterOps(
      F({ reporter: `a",tenant_id.eq.${OTHER_TENANT},x.eq."`, page: `/x",tenant_id.eq.${OTHER_TENANT},y.eq."` }), { scope: "mine" },
    ));
    const flat = JSON.stringify(parseQuery(rec.params).scopes.get("")!.filters);
    expect(flat).not.toContain('"column":"tenant_id"');
  });
});

describe("access rule — a tenant user cannot widen the scope with params", () => {
  it("'This workspace' never builds a tenant step, whatever ws= says", () => {
    const f = parseFeedbackFilters(new URLSearchParams({ ws: OTHER_TENANT, q: "x", status: "open" }));
    expect(f.workspace).toBe(OTHER_TENANT); // parsed, but…
    const ops = feedbackFilterOps(f, { scope: "mine" });
    expect(JSON.stringify(ops)).not.toContain("tenant_id");
    const rec = applyFeedbackOps(new Recorder(), ops);
    expect(rec.calls.some((c) => c.includes("tenant_id"))).toBe(false);
  });

  it("no combination of params builds a tenant step in 'This workspace'", () => {
    const every = F({
      q: "tenant_id " + OTHER_TENANT, status: "ai_working", type: "feature", severity: "low", reporter: OTHER_TENANT,
      workspace: OTHER_TENANT, page: "tenant_id", from: "2026-01-01", to: "2026-12-31", card: "has", real: true, fresh: true,
    });
    for (const skipStatus of [false, true]) {
      const ops = feedbackFilterOps(every, { scope: "mine", since: "2026-11-01T00:00:00.000Z", skipStatus });
      for (const op of ops) {
        if (op.k !== "or") expect(op.col).not.toBe("tenant_id");
        else expect(op.expr).not.toMatch(/(^|[,(])tenant_id\./);
      }
    }
  });

  it("'All workspaces' pins one workspace only for a well-formed id", () => {
    expect(feedbackFilterOps(F({ workspace: OTHER_TENANT }), { scope: "all" })[0]).toEqual({ k: "eq", col: "tenant_id", v: OTHER_TENANT });
    expect(feedbackFilterOps(F({ workspace: "x' or 1=1" }), { scope: "all" })).toEqual([]);
  });
});

describe("filters", () => {
  it("status uses the real values; agent_queued splits on the worker's claim", () => {
    expect(statusOps("all")).toEqual([]);
    expect(statusOps("open")).toEqual([{ k: "eq", col: "status", v: "open" }]);
    expect(statusOps("queued")).toEqual([{ k: "eq", col: "status", v: "agent_queued" }, { k: "is_null", col: "agent_claimed_at" }]);
    expect(statusOps("ai_working")).toEqual([{ k: "eq", col: "status", v: "agent_queued" }, { k: "not_null", col: "agent_claimed_at" }]);
    expect(statusOps("wont_fix")).toEqual([{ k: "eq", col: "status", v: "wont_fix" }]);
    expect(statusFilterOf({ status: "agent_queued", agent_claimed_at: null })).toBe("queued");
    expect(statusFilterOf({ status: "agent_queued", agent_claimed_at: "2026-11-12T10:00:00Z" })).toBe("ai_working");
    expect(statusFilterOf({ status: "open" })).toBe("open");
  });

  it("reporter = hitesh + status open → both steps", () => {
    const ops = feedbackFilterOps(F({ reporter: "hitesh@exceltechnologies.in", status: "open" }), { scope: "all" });
    expect(ops[0]).toEqual({ k: "eq", col: "status", v: "open" });
    expect(ors(ops)[0]).toBe(
      `reporter_email.ilike."hitesh@exceltechnologies.in",and(or(reporter_email.is.null,reporter_email.eq.""),reporter_name.imatch.${quoteLogicValue(reporterNameRegex("hitesh@exceltechnologies.in"))})`,
    );
  });

  it("type reads the inferred type, else what the reporter picked", () => {
    expect(ors(feedbackFilterOps(F({ type: "bug" }), { scope: "mine" }))[0])
      .toBe("inferred_type.eq.bug,and(inferred_type.is.null,reported_type.eq.bug)");
  });

  it("a date range is IST days, both included", () => {
    const ops = feedbackFilterOps(F({ from: "2026-11-12", to: "2026-11-12" }), { scope: "mine" });
    expect(ops).toEqual([
      { k: "gte", col: "created_at", v: "2026-11-11T18:30:00.000Z" },
      { k: "lt", col: "created_at", v: "2026-11-12T18:30:00.000Z" },
    ]);
  });

  it("'New since my last visit' needs a time; without one it filters nothing", () => {
    expect(feedbackFilterOps(F({ fresh: true }), { scope: "mine", since: "2026-11-12T04:00:00.000Z" }))
      .toEqual([{ k: "gt", col: "created_at", v: "2026-11-12T04:00:00.000Z" }]);
    expect(feedbackFilterOps(F({ fresh: true }), { scope: "mine", since: null })).toEqual([]);
  });

  it("has card = the worker's claim or a card id in the AI note; no card = neither", () => {
    expect(ors(feedbackFilterOps(F({ card: "has" }), { scope: "mine" }))[0])
      .toBe('agent_card.not.is.null,resolution_note.match."R-[0-9]{2,5}"');
    const none = feedbackFilterOps(F({ card: "none" }), { scope: "mine" });
    expect(none[0]).toEqual({ k: "is_null", col: "agent_card" });
    expect(ors(none)[0]).toBe('resolution_note.is.null,resolution_note.not.match."R-[0-9]{2,5}"');
  });

  it("skipStatus leaves only the status steps out (for the tab counts)", () => {
    const f = F({ status: "fixed", severity: "high" });
    expect(feedbackFilterOps(f, { scope: "mine", skipStatus: true })).toEqual([{ k: "eq", col: "reported_severity", v: "high" }]);
  });

  it("every filter the builder makes is grammar the data gateway accepts", () => {
    const f = F({
      q: "score card", status: "ai_working", type: "bug", severity: "high", reporter: "hitesh@x.in", workspace: OTHER_TENANT,
      page: "/reports/[id]", from: "2026-11-01", to: "2026-11-12", card: "none", real: true, fresh: true,
    });
    const rec = applyFeedbackOps(new Recorder(), feedbackFilterOps(f, { scope: "all", since: "2026-11-01T00:00:00.000Z" }));
    expect(() => parseQuery(rec.params)).not.toThrow();
    const has = applyFeedbackOps(new Recorder(), feedbackFilterOps(F({ card: "has" }), { scope: "all" }));
    expect(() => parseQuery(has.params)).not.toThrow();
  });
});

describe("review fixes (independent review of a22b0458)", () => {
  it("a day that does not exist is ignored, not rolled over (2026-02-31 is not 3 March)", () => {
    const f = parseFeedbackFilters(new URLSearchParams("from=2026-02-31&to=2026-04-31"));
    expect(f.from).toBe("");
    expect(f.to).toBe("");
    expect(feedbackFilterOps(f, { scope: "mine" })).toEqual([]);
    expect(parseFeedbackFilters(new URLSearchParams("from=2028-02-29&to=2026-11-30"))).toMatchObject({ from: "2028-02-29", to: "2026-11-30" });
  });

  it("a reporter with no email — null OR empty — and a double-spaced name: the picker's entry finds their reports", () => {
    const rows = [
      { tenant_id: "t1", reporter_name: "Walk  In   Tester", reporter_email: "", route_pattern: null, page_path: null },
      { tenant_id: "t1", reporter_name: " walk in tester ", reporter_email: null, route_pattern: null, page_path: null },
    ];
    const { reporters } = buildFacets(rows);
    expect(reporters).toEqual([{ value: "walk in tester", label: "Walk In Tester", count: 2 }]);
    for (const r of rows) expect(reporterKey(r)).toBe(reporters[0].value);

    // The value survives the address unchanged, and the filter it builds covers null AND empty emails.
    const f = parseFeedbackFilters(feedbackFiltersToParams(F({ reporter: reporters[0].value })));
    expect(f.reporter).toBe("walk in tester");
    const [expr] = ors(feedbackFilterOps(f, { scope: "mine" }));
    expect(expr).toContain('and(or(reporter_email.is.null,reporter_email.eq.""),reporter_name.imatch.');

    // The name pattern (POSIX; [[:space:]] read as a space class here) matches both spellings and nothing longer.
    const posix = reporterNameRegex(f.reporter);
    expect(posix).toBe("^[[:space:]]*walk[[:space:]]+in[[:space:]]+tester[[:space:]]*$");
    const js = new RegExp(posix.split("[[:space:]]").join("[ ]"), "i");
    for (const r of rows) expect(js.test(r.reporter_name)).toBe(true);
    expect(js.test("Walk In Tester Jr")).toBe(false);
    // Regex characters in a name are literal.
    expect(reporterNameRegex("a.b (c)")).toBe("^[[:space:]]*a[.]b[[:space:]]+[(]c[)][[:space:]]*$");
    // …and it is still grammar the data gateway accepts.
    const rec = applyFeedbackOps(new Recorder(), feedbackFilterOps(F({ reporter: "a.b (c), \"x\"" }), { scope: "mine" }));
    expect(() => parseQuery(rec.params)).not.toThrow();
    expect(JSON.stringify(parseQuery(rec.params).scopes.get("")!.filters)).not.toContain('"column":"tenant_id"');
  });

  it("'This workspace': ?ws= filters nothing, so it is not shown or counted as a filter", () => {
    const f = parseFeedbackFilters(new URLSearchParams({ ws: OTHER_TENANT }));
    expect(hasAnyFilter(f, "mine")).toBe(false);
    expect(panelFilterCount(f, "mine")).toBe(0);
    expect(activeFilterChips(filtersInScope(f, "mine"))).toEqual([]);
    // On "All workspaces" it is a real filter.
    expect(hasAnyFilter(f, "all")).toBe(true);
    expect(panelFilterCount(f, "all")).toBe(1);
    expect(activeFilterChips(filtersInScope(f, "all")).map((c) => c.key)).toEqual(["workspace"]);
    expect(panelFilterCount(F({ reporter: "x", from: "2026-11-01", to: "2026-11-02", card: "has" }), "mine")).toBe(3);
  });
});

describe("'Real users'", () => {
  it("internal and test addresses are not real users; everyone else — and no address — is", () => {
    expect(isRealReporter("pardeep@anutech.in")).toBe(false);
    expect(isRealReporter("Owner@Example.Test")).toBe(false);
    expect(isRealReporter("someone@example.com")).toBe(false);
    expect(isRealReporter("hitesh@exceltechnologies.in")).toBe(true);
    expect(isRealReporter("a@contest.in")).toBe(true);
    expect(isRealReporter("x@notanutech.in")).toBe(true);
    expect(isRealReporter(null)).toBe(true);
  });

  it("the query says the same thing", () => {
    const [expr] = ors(feedbackFilterOps(F({ real: true }), { scope: "all" }));
    expect(expr.startsWith("reporter_email.is.null,and(")).toBe(true);
    expect(expr).toContain('reporter_email.not.ilike."%@anutech.in"');
    expect(expr).toContain('reporter_email.not.ilike."%.test"');
  });
});

describe("sorting and paging", () => {
  const order = (sort: FeedbackFilters["sort"]) => applyFeedbackSort(new Recorder(), sort).calls;
  it("newest is the default; oldest flips it; both end on id so pages never overlap", () => {
    expect(order("newest")).toEqual(["order created_at desc", "order id asc"]);
    expect(order("oldest")).toEqual(["order created_at asc", "order id asc"]);
  });
  it("severity puts untriaged (no score) last; status groups, newest inside", () => {
    expect(order("severity")).toEqual(["order severity_score desc nullslast", "order created_at desc", "order id asc"]);
    expect(order("status")).toEqual(["order status asc", "order created_at desc", "order id asc"]);
  });
  it("pages are 50 rows", () => {
    expect(FEEDBACK_PAGE_SIZE).toBe(50);
    expect(pageRange(1)).toEqual({ from: 0, to: 49 });
    expect(pageRange(3)).toEqual({ from: 100, to: 149 });
    expect(pageRange(0)).toEqual({ from: 0, to: 49 });
  });
});

describe("counts, facets, chips", () => {
  it("tallies the tabs", () => {
    expect(tallyStatuses([
      { status: "open" }, { status: "open" }, { status: "agent_queued", agent_claimed_at: null },
      { status: "agent_queued", agent_claimed_at: "x" }, { status: "fixed" }, { status: "wont_fix" }, { status: "duplicate" },
    ])).toEqual({ all: 7, open: 2, queued: 1, ai_working: 1, fixed: 1, wont_fix: 1, duplicate: 1 });
  });

  it("facets: reporters by email (name when none), pages by route, workspaces only when names are given", () => {
    const rows = [
      { tenant_id: "t1", reporter_name: "Hitesh", reporter_email: "Hitesh@Excel.in", route_pattern: "/reports/scorecards", page_path: "/reports/scorecards" },
      { tenant_id: "t1", reporter_name: "Hitesh", reporter_email: "hitesh@excel.in", route_pattern: null, page_path: "/quotes/12" },
      { tenant_id: "t2", reporter_name: "Walk-in", reporter_email: null, route_pattern: null, page_path: null },
    ];
    const mine = buildFacets(rows);
    expect(mine.reporters).toEqual([
      { value: "hitesh@excel.in", label: "Hitesh · hitesh@excel.in", count: 2 },
      { value: "walk-in", label: "Walk-in", count: 1 },
    ]);
    expect(mine.pages.map((p) => p.value)).toEqual(["/quotes/12", "/reports/scorecards"]);
    expect(mine.workspaces).toEqual([]);
    const all = buildFacets(rows, new Map([["t1", "Excel"]]));
    expect(all.workspaces).toEqual([{ value: "t1", label: "Excel", count: 2 }, { value: "t2", label: "(unknown workspace)", count: 1 }]);
  });

  it("chips name the active filters and removing one goes back to page 1", () => {
    const f = F({ q: "scorecard", reporter: "hitesh@excel.in", from: "2026-11-01", pageNo: 4 });
    expect(activeFilterChips(f).map((c) => c.key)).toEqual(["q", "reporter", "date"]);
    const next = removeFilter(f, "reporter");
    expect(next.reporter).toBe("");
    expect(next.pageNo).toBe(1);
    expect(next.q).toBe("scorecard");
  });
});

describe("'New since my last visit' memory", () => {
  const at = (s: string) => new Date(s);
  it("first ever visit: nothing is 'new' yet", () => {
    expect(nextVisitMemory(null, at("2026-11-13T05:00:00Z"))).toEqual({ seenAt: "2026-11-13T05:00:00.000Z", since: null });
  });
  it("coming back after 30+ minutes: 'since' is when the page was last seen", () => {
    const prev = { seenAt: "2026-11-12T10:00:00.000Z", since: null };
    expect(nextVisitMemory(prev, at("2026-11-13T05:00:00Z"))).toEqual({ seenAt: "2026-11-13T05:00:00.000Z", since: "2026-11-12T10:00:00.000Z" });
  });
  it("a reload inside the visit keeps the same 'since'", () => {
    const prev = { seenAt: "2026-11-13T05:00:00.000Z", since: "2026-11-12T10:00:00.000Z" };
    expect(nextVisitMemory(prev, at("2026-11-13T05:10:00Z")).since).toBe("2026-11-12T10:00:00.000Z");
  });
});
