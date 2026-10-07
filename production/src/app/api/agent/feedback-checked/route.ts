/**
 * POST /api/agent/feedback-checked — the AI browser check says "this fixed report works" (R-188).
 *
 * Pardeep, 6 Oct 2026: "ye automatically nahi lag sakta jaise hi browser test pass ho". The
 * "Check in browser" prompt runs in a Claude Code session on his computer; when the re-test
 * passes, that session calls this route so the report shows "✓ checked · AI browser check"
 * without anyone pressing Mark checked.
 *
 * The narrowest write we could give it: body {id}; only a row that is status "fixed" and not
 * yet checked is touched; only checked_at / checked_by_name change. Same AGENT_QUEUE_TOKEN as
 * the read-only queue, so a leaked token can at most put a tick on a fixed report — it cannot
 * open, close, rewrite or read anything else. Fails closed without the token.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AI_CHECKER_NAME = "AI browser check";

export async function POST(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let id: unknown;
  try { ({ id } = await req.json()); } catch { /* falls through to the check below */ }
  if (typeof id !== "string" || !UUID.test(id)) {
    return NextResponse.json({ error: "body must be {\"id\": \"<feedback uuid>\"}" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("feedback")
    .update({ checked_at: now, checked_by_name: AI_CHECKER_NAME, updated_at: now })
    .eq("id", id)
    .eq("status", "fixed")
    .is("checked_at", null)
    .select("id");
  if (error) return NextResponse.json({ error: "could not mark it checked" }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "no fixed, unchecked report with that id" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id, checked_at: now });
}
