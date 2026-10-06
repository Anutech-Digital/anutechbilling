/**
 * POST /api/agent/feedback-fixed — "the AI fixed this report" (R-200, 6 Oct 2026).
 *
 * Pardeep: "staging se bug karwata hu, aap localhost me fix karte ho — mujhe kaise pata
 * chalega ki ye task AI ne complete kar diye aur browser check ka wait kar rahe hain". The
 * reports live in the app (staging or live); the fix is made in a Claude Code session on
 * his computer. When that session has committed the fix, it calls this route on the app the
 * report came from, so the report moves to Fixed and reads "done · waiting for browser test"
 * with a note saying which card and commit, and when it reaches that app.
 *
 * Narrow on purpose, like /feedback-checked: body {id, note}; only an open, queued or
 * already-fixed-but-unchecked report is touched; only status / resolved_at /
 * resolution_note / the check fields change. Same AGENT_QUEUE_TOKEN. Fails closed.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 500;

export async function POST(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { id?: unknown; note?: unknown } = {};
  try { body = await req.json(); } catch { /* checked below */ }
  const id = typeof body.id === "string" ? body.id : "";
  const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
  if (!UUID.test(id) || note.length < 5) {
    return NextResponse.json({ error: "body must be {\"id\": \"<feedback uuid>\", \"note\": \"<card, commit, when it reaches this app>\"}" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("feedback")
    .update({ status: "fixed", resolved_at: now, resolution_note: note, checked_at: null, checked_by_name: null, updated_at: now })
    .eq("id", id)
    .in("status", ["open", "agent_queued", "fixed"])
    .is("checked_at", null)
    .select("id");
  if (error) return NextResponse.json({ error: "could not mark it fixed" }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "no open, queued or unchecked report with that id" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id, resolved_at: now });
}
