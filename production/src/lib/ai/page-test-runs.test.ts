/** R-352 — browser test results come back into the app; AI Help remembers them. */
import { describe, it, expect, vi } from "vitest";
import {
  parsePageTestRunBody, normalizePagePath, summarizeRun, compareBuild, lastTestedLine,
  testHistoryForPrompt, loadLastPageTestRun, isMissingTable, resultsFromJson, type PageTestRun,
} from "./page-test-runs";

const T = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const run: PageTestRun = {
  pagePath: "/deals",
  runAt: "2026-10-07T05:22:00Z",
  buildSha: "51629ab",
  runBy: "AI browser test",
  results: [
    { test: "Add a deal with ₹0 value", result: "pass" },
    { test: "Drag a deal to Won", result: "pass" },
    { test: "Back button keeps the filter", result: "fail", note: "filter lost", card: "R-360" },
    { test: "Phone width", result: "skipped", note: "no device" },
  ],
};

describe("parsePageTestRunBody", () => {
  const ok = { tenantId: T, page: "/deals/?tab=kanban", buildSha: "51629AB", results: [{ test: " Add  deal ", result: "pass" }] };
  it("accepts a proper body and normalises page, sha and text", () => {
    const r = parsePageTestRunBody(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ tenantId: T, pagePath: "/deals", buildSha: "51629ab", runBy: "AI browser test", results: [{ test: "Add deal", result: "pass" }] });
  });
  it("rejects a bad tenant, page, sha or result", () => {
    expect(parsePageTestRunBody(null).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, tenantId: "x" }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, page: "https://evil.example/deals" }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, page: "//evil.example" }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, buildSha: "main; rm" }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, results: [] }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, results: [{ test: "x", result: "maybe" }] }).ok).toBe(false);
    expect(parsePageTestRunBody({ ...ok, results: Array.from({ length: 31 }, () => ({ test: "x", result: "pass" })) }).ok).toBe(false);
  });
  it("keeps a card only when it looks like R-123", () => {
    const r = parsePageTestRunBody({ ...ok, results: [{ test: "a", result: "fail", card: "R-360" }, { test: "b", result: "fail", card: "drop table" }] });
    expect(r.ok && r.value.results.map((x) => x.card)).toEqual(["R-360", undefined]);
  });
  it("accepts 'dev' as a build sha", () => {
    expect(parsePageTestRunBody({ ...ok, buildSha: "dev" }).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("normalizePagePath drops query, hash and trailing slash", () => {
    expect(normalizePagePath("/deals/?a=1#x")).toBe("/deals");
    expect(normalizePagePath("/")).toBe("/");
  });
  it("summarizeRun counts and names the failed tests", () => {
    expect(summarizeRun(run)).toEqual({ passed: 2, failed: 1, skipped: 1, failedTests: ["Back button keeps the filter"] });
  });
  it("compareBuild: short vs long sha is the same build; dev is unknown", () => {
    expect(compareBuild("51629ab", "51629ab3f00")).toBe("same");
    expect(compareBuild("51629ab", "aaaaaaa")).toBe("changed");
    expect(compareBuild("51629ab", "dev")).toBe("unknown");
    expect(compareBuild(null, "51629ab")).toBe("unknown");
  });
  it("lastTestedLine reads like the card asks, in IST", () => {
    expect(lastTestedLine(run)).toBe("Last tested 7 Oct, 10:52 · 2 ✓ 1 ✗ 1 skipped");
    expect(lastTestedLine({ runAt: "2026-10-07T05:22:00Z", results: [{ test: "a", result: "pass" }] })).toBe("Last tested 7 Oct, 10:52 · 1 ✓");
  });
  it("resultsFromJson drops malformed rows", () => {
    expect(resultsFromJson([{ test: "a", result: "pass" }, { test: "", result: "pass" }, { test: "b", result: "x" }, 5])).toEqual([{ test: "a", result: "pass" }]);
    expect(resultsFromJson("nope")).toEqual([]);
  });
  it("isMissingTable knows both codes", () => {
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "42501" })).toBe(false);
  });
});

describe("testHistoryForPrompt — passed tests are not suggested again", () => {
  it("no run → null (prompt unchanged)", () => {
    expect(testHistoryForPrompt(null, "51629ab")).toBeNull();
  });
  it("same build: lists every result and forbids repeating ✓ tests", () => {
    const h = testHistoryForPrompt(run, "51629ab")!;
    expect(h).toContain("SAME BUILD");
    expect(h).toContain("✓ passed: Add a deal with ₹0 value");
    expect(h).toContain("✗ failed: Back button keeps the filter (filter lost) [card R-360]");
    expect(h).toContain("– could not run: Phone width");
    expect(h).toMatch(/do NOT suggest any ✓ passed test again/);
    expect(h).toContain("Re-check after the fix");
  });
  it("local dev (unknown build) is treated as the same build", () => {
    const h = testHistoryForPrompt(run, "dev")!;
    expect(h).toMatch(/do NOT suggest any ✓ passed test again/);
  });
  it("changed build: ✓ tests may come back only as a short regression line", () => {
    const h = testHistoryForPrompt(run, "abcdef1")!;
    expect(h).toContain("CHANGED");
    expect(h).not.toMatch(/do NOT suggest any ✓ passed test again/);
    expect(h).toContain("NEW, untested");
  });
});

function reader(result: { data: unknown; error: { code?: string; message?: string } | null } | Error) {
  const calls: Array<[string, unknown]> = [];
  const q = {
    select: (c: string) => { calls.push(["select", c]); return q; },
    eq: (c: string, v: unknown) => { calls.push([c, v]); return q; },
    order: (c: string) => { calls.push(["order", c]); return q; },
    limit: () => q,
    maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
  return { client: { from: (t: string) => { calls.push(["from", t]); return q; } }, calls };
}

describe("loadLastPageTestRun — never breaks AI Help", () => {
  it("reads the tenant's last run for the normalised page", async () => {
    const r = reader({ data: { page_path: "/deals", run_at: run.runAt, build_sha: "51629ab", run_by: "AI browser test", results: run.results }, error: null });
    const got = await loadLastPageTestRun(r.client, T, "/deals?x=1");
    expect(got?.results).toHaveLength(4);
    expect(r.calls).toContainEqual(["from", "page_test_runs"]);
    expect(r.calls).toContainEqual(["tenant_id", T]);
    expect(r.calls).toContainEqual(["page_path", "/deals"]);
  });
  it("missing table (migration not applied) → null, silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadLastPageTestRun(reader({ data: null, error: { code: "42P01" } }).client, T, "/deals")).toBeNull();
    expect(await loadLastPageTestRun(reader({ data: null, error: { code: "PGRST205" } }).client, T, "/deals")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("any other error, a throw, no row or no tenant → null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadLastPageTestRun(reader({ data: null, error: { code: "42501", message: "denied" } }).client, T, "/deals")).toBeNull();
    expect(await loadLastPageTestRun(reader(new Error("network")).client, T, "/deals")).toBeNull();
    expect(await loadLastPageTestRun(reader({ data: null, error: null }).client, T, "/deals")).toBeNull();
    expect(await loadLastPageTestRun({}, T, "/deals")).toBeNull();
    expect(await loadLastPageTestRun(reader({ data: null, error: null }).client, null, "/deals")).toBeNull();
    warn.mockRestore();
  });
});
