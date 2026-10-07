/**
 * R-352 (7 Oct 2026): browser test results come back into the app, and AI Help remembers them.
 *
 * Pardeep: AI Help's tests were run in a browser (/deals, /online-orders), but "Check this
 * page" suggested the same tests again — the result went only to the work board. The test
 * session now posts its result to /api/agent/page-test-runs (table page_test_runs); AI Help
 * reads the page's last run, shows "Last tested … 5 ✓ 1 ✗", and the prompt tells the model:
 * passed tests on the same build are not suggested again, failed ones come back as "re-check
 * after the fix", only new / untested parts are suggested.
 *
 * Pure helpers (parse, summarise, prompt text) plus one reader that never throws: a missing
 * table (migration not applied: 42P01 / PGRST205) or any read error means "no previous runs".
 */

export type TestResultKind = "pass" | "fail" | "skipped";
export interface PageTestResult { test: string; result: TestResultKind; note?: string; card?: string }
export interface PageTestRun { pagePath: string; runAt: string; buildSha: string; runBy: string; results: PageTestResult[] }

export const MAX_TEST_RESULTS = 30;
const KINDS: readonly TestResultKind[] = ["pass", "fail", "skipped"];
/** A short or full git sha, or "dev" for a local build without one. */
const SHA = /^(?:[0-9a-f]{7,40}|dev)$/i;
const CARD = /^R-\d{1,5}$/;

/** "/deals/?x=1#y" → "/deals". Results are kept per path, without query or hash. */
export function normalizePagePath(raw: string): string {
  const p = raw.split(/[?#]/)[0].trim().replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export type ParsedRunBody =
  | { ok: true; value: { tenantId: string; pagePath: string; buildSha: string; runBy: string; results: PageTestResult[] } }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The POST body of /api/agent/page-test-runs: {tenantId, page, buildSha, runBy?, results}. */
export function parsePageTestRunBody(raw: unknown): ParsedRunBody {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  const tenantId = s(o.tenantId, 36);
  if (!UUID.test(tenantId)) return { ok: false, error: "tenantId must be a uuid" };
  const page = s(o.page, 300);
  if (!/^\/(?!\/)[A-Za-z0-9\-._~/%[\]]*(?:[?#].*)?$/.test(page)) return { ok: false, error: "page must be an app path like /deals" };
  const buildSha = s(o.buildSha, 40);
  if (!SHA.test(buildSha)) return { ok: false, error: "buildSha must be a git sha (or \"dev\")" };
  if (!Array.isArray(o.results) || o.results.length === 0) return { ok: false, error: "results must be a non-empty array" };
  if (o.results.length > MAX_TEST_RESULTS) return { ok: false, error: `at most ${MAX_TEST_RESULTS} results` };
  const results: PageTestResult[] = [];
  for (const r of o.results) {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const test = s(x.test, 300);
    if (!test || !KINDS.includes(x.result as TestResultKind)) {
      return { ok: false, error: "each result needs {test, result: pass|fail|skipped}" };
    }
    const note = s(x.note, 500);
    const card = s(x.card, 10);
    results.push({ test, result: x.result as TestResultKind, ...(note ? { note } : {}), ...(CARD.test(card) ? { card } : {}) });
  }
  return { ok: true, value: { tenantId, pagePath: normalizePagePath(page), buildSha: buildSha.toLowerCase(), runBy: s(o.runBy, 80) || "AI browser test", results } };
}

/** Rows read back from the table: anything malformed is dropped, never shown. */
export function resultsFromJson(raw: unknown): PageTestResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const test = s(x.test, 300);
    if (!test || !KINDS.includes(x.result as TestResultKind)) return [];
    const note = s(x.note, 500);
    const card = s(x.card, 10);
    return [{ test, result: x.result as TestResultKind, ...(note ? { note } : {}), ...(card ? { card } : {}) }];
  });
}

export interface RunSummary { passed: number; failed: number; skipped: number; failedTests: string[] }
export function summarizeRun(run: Pick<PageTestRun, "results">): RunSummary {
  const by = (k: TestResultKind) => run.results.filter((r) => r.result === k);
  return { passed: by("pass").length, failed: by("fail").length, skipped: by("skipped").length, failedTests: by("fail").map((r) => r.test) };
}

/**
 * Is the app still the build the tests ran on? "same" when the shas match (a short sha
 * matches its long form), "changed" when both are known and differ, "unknown" when either is
 * "dev" / empty (a local dev server has no BUILD_SHA).
 */
export type BuildMatch = "same" | "changed" | "unknown";
export function compareBuild(runSha: string | null | undefined, currentSha: string | null | undefined): BuildMatch {
  const a = (runSha ?? "").trim().toLowerCase();
  const b = (currentSha ?? "").trim().toLowerCase();
  if (!a || !b || a === "dev" || b === "dev") return "unknown";
  return a.startsWith(b) || b.startsWith(a) ? "same" : "changed";
}

/** "Last tested 7 Oct, 10:52 · 5 ✓ 1 ✗" — the line at the top of AI Help. IST, as the team reads it. */
export function lastTestedLine(run: Pick<PageTestRun, "runAt" | "results">): string {
  const sum = summarizeRun(run);
  const d = new Date(run.runAt);
  const when = Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const parts = [`${sum.passed} ✓`];
  if (sum.failed) parts.push(`${sum.failed} ✗`);
  if (sum.skipped) parts.push(`${sum.skipped} skipped`);
  return `Last tested ${when} · ${parts.join(" ")}`;
}

/**
 * The PREVIOUS TESTS block for AI Help's prompt, and the rule that goes with it. Null when
 * there is no run — the prompt is then exactly what it was before R-352.
 */
export function testHistoryForPrompt(run: PageTestRun | null, currentSha: string | null | undefined): string | null {
  if (!run || run.results.length === 0) return null;
  const match = compareBuild(run.buildSha, currentSha);
  const mark = { pass: "✓ passed", fail: "✗ failed", skipped: "– could not run" } as const;
  const lines = run.results.map((r) => `${mark[r.result]}: ${r.test}${r.note ? ` (${r.note})` : ""}${r.card ? ` [card ${r.card}]` : ""}`);
  const build = match === "same"
    ? `The app is still the SAME BUILD (${run.buildSha}) the tests ran on.`
    : match === "changed"
      ? `The app has CHANGED since (tests ran on build ${run.buildSha}, now ${currentSha}).`
      : `Build unknown (local dev server) — treat it as the same build the tests ran on (${run.buildSha}).`;
  const rule = match === "changed"
    ? "Rules: a ✓ test may come back only as one short regression line if the change could have touched it; ✗ tests come back as 'Re-check after the fix: …'; otherwise suggest only NEW, untested parts of the page."
    : "Rules: do NOT suggest any ✓ passed test again (same build, it passed). ✗ failed tests come back only as 'Re-check after the fix: …'. Suggest only NEW, untested parts of the page. If everything visible is already tested, say so in reply and keep checklist short.";
  return [`Last run ${run.runAt} by ${run.runBy}. ${build}`, ...lines, rule].join("\n");
}

/** PostgREST / Postgres "table does not exist" — the migration is not applied yet. */
export function isMissingTable(err: { code?: string | null } | null | undefined): boolean {
  return err?.code === "42P01" || err?.code === "PGRST205";
}

interface RunRow { page_path: string; run_at: string; build_sha: string; run_by: string; results: unknown }
/** Minimal shape of the Supabase client this reader needs — the browser and server clients both fit. */
interface RunReader {
  from(table: "page_test_runs"): {
    select(cols: string): {
      eq(c: string, v: string): {
        eq(c: string, v: string): {
          order(c: string, o: { ascending: boolean }): {
            limit(n: number): { maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string | null; message?: string } | null }> };
          };
        };
      };
    };
  };
}

/**
 * The page's last run for this tenant, or null (no run, no table, no permission, any error).
 * `client` is a Supabase client (browser or server). page_test_runs is not in the generated
 * database types until the migration is applied, so the client is read through RunReader.
 */
export async function loadLastPageTestRun(client: object, tenantId: string | null | undefined, pagePath: string | null | undefined): Promise<PageTestRun | null> {
  if (!tenantId || !pagePath) return null;
  const db = client as RunReader;
  try {
    const { data, error } = await db
      .from("page_test_runs")
      .select("page_path, run_at, build_sha, run_by, results")
      .eq("tenant_id", tenantId)
      .eq("page_path", normalizePagePath(pagePath))
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (!isMissingTable(error)) console.warn("[page-test-runs] read failed:", error.message ?? error.code);
      return null;
    }
    if (!data) return null;
    const row = data as RunRow;
    const results = resultsFromJson(row.results);
    if (!results.length) return null;
    return { pagePath: row.page_path, runAt: row.run_at, buildSha: row.build_sha, runBy: row.run_by, results };
  } catch {
    return null;
  }
}
