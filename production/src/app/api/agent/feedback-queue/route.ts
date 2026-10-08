/**
 * GET /api/agent/feedback-queue — the reports someone pressed "Run AI Auto-Fix" on, for the
 * AI worker routine to turn into board cards (6 Oct 2026).
 *
 * Until now "Queued for agent" was only a label: the directive went to the clipboard and
 * nothing read the queue, so a report could sit there for days looking as if an agent had it.
 * Pardeep: "haan dusra raasta kar do" — the routine on his machine reads this list every run
 * and makes one card per report; he still decides on the board, and it is still Claude Code
 * that changes the code.
 *
 * Read-only on purpose. It returns only what a card needs (the directive and triage summary,
 * page, severity) — no reporter name or email, no screenshot — and never changes a row, so
 * a leaked token reads a work list and nothing else. Its own token, not CRON_SECRET: that
 * one can run every cron job; this one cannot run anything.
 *
 * Fails closed: no AGENT_QUEUE_TOKEN configured → 503.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { AGENT_CLAIMED_AT_COLUMN, isMissingColumnError } from "@/lib/feedback/auto-send";
import { URGENT_AT_COLUMN, isUrgent, urgentFirst } from "@/lib/feedback/urgent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIMIT = 50;
/** Read more than LIMIT so claimed rows filtered out below do not shorten the list. */
const FETCH = 200;
const COLS =
  "id, title, problem_summary, directive, reported_type, inferred_type, reported_severity, severity_score, page_path, target_files, dispatched_at, created_at, filed_via";

export async function GET(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* Every tenant: a tester's own workspace files reports too (see admin/feedback/platform).
     R-357: a report an AI card already took (agent_claimed_at set) is not handed out again.
     The claim column arrives with migration 20261007110000; until then the first read fails
     on the unknown column and the plain read runs — nothing can be claimed yet anyway. */
  /* R-397: urgent reports first (urgent_at, migration 20261007234000), each with `urgent: true`.
     Before that migration the urgent read fails on the unknown column and the R-357 read runs:
     same list, same order as before. Urgent rows are ordered first in the DB too, so a long
     queue cannot push one past FETCH. */
  const admin = createAdminClient();
  const read = async (cols: string, urgent: boolean) => {
    let q = admin.from("feedback").select(cols).eq("status", "agent_queued");
    if (urgent) q = q.order(URGENT_AT_COLUMN, { ascending: true, nullsFirst: false });
    const { data, error } = await q.order("dispatched_at", { ascending: true }).limit(FETCH);
    return { rows: (data ?? []) as unknown as Array<Record<string, unknown>>, error };
  };
  let res = await read(`${COLS}, ${AGENT_CLAIMED_AT_COLUMN}, ${URGENT_AT_COLUMN}`, true);
  if (res.error && isMissingColumnError(res.error)) res = await read(`${COLS}, ${AGENT_CLAIMED_AT_COLUMN}`, false);
  if (res.error && isMissingColumnError(res.error)) res = await read(COLS, false);
  if (res.error) return NextResponse.json({ error: "could not read the queue" }, { status: 500 });

  const items = urgentFirst(res.rows.filter((r) => !r[AGENT_CLAIMED_AT_COLUMN]))
    .slice(0, LIMIT)
    .map((r) => {
      const urgent = isUrgent(r);
      const out: Record<string, unknown> = { ...r };
      delete out[AGENT_CLAIMED_AT_COLUMN];
      delete out[URGENT_AT_COLUMN];
      return urgent ? { ...out, urgent: true } : out;
    });

  return NextResponse.json({ env: process.env.NEXT_PUBLIC_APP_ENV || "production", items });
}
