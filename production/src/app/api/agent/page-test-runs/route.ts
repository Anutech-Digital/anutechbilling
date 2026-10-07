/**
 * POST /api/agent/page-test-runs — the browser test session reports its result (R-352).
 *
 * Pardeep, 7 Oct 2026: AI Help's tests were run in a browser, yet "Check this page" suggested
 * the same tests again, because the result only reached the work board. The "Run these tests
 * in browser" prompt (lib/ai/app-help.ts buildTestRunPrompt) now ends with a curl to this
 * route on the local app; AI Help reads the page's last run (lib/ai/page-test-runs.ts).
 *
 * Same AGENT_QUEUE_TOKEN as feedback-checked, compared timing-safe, closed without it. The
 * narrowest write: one new row in page_test_runs — nothing is read back, updated or deleted,
 * so a leaked token can at most add a test result. A missing table (migration not applied)
 * answers 503 and writes nothing.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { parsePageTestRunBody, isMissingTable } from "@/lib/ai/page-test-runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** page_test_runs is not in the generated types until its migration is applied. */
interface RunInserter {
  from(table: "page_test_runs"): {
    insert(row: Record<string, unknown>): {
      select(cols: string): PromiseLike<{ data: Array<{ id: string }> | null; error: { code?: string | null; message?: string } | null }>;
    };
  };
}

export async function POST(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown = null;
  try { raw = await req.json(); } catch { /* falls through to the check below */ }
  const parsed = parsePageTestRunBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { tenantId, pagePath, buildSha, runBy, results } = parsed.value;

  const now = new Date().toISOString();
  const admin = createAdminClient() as unknown as RunInserter;
  const { data, error } = await admin
    .from("page_test_runs")
    .insert({ tenant_id: tenantId, page_path: pagePath, build_sha: buildSha, run_by: runBy, results, run_at: now })
    .select("id");
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ error: "page_test_runs is not set up yet (migration pending)" }, { status: 503 });
    if (error.code === "23503") return NextResponse.json({ error: "no workspace with that tenantId" }, { status: 404 });
    return NextResponse.json({ error: "could not save the test run" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: data?.[0]?.id ?? null, page: pagePath, run_at: now, count: results.length });
}
