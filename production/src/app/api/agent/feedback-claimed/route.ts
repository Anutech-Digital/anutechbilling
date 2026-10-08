/**
 * POST /api/agent/feedback-claimed — the AI worker says "board card R-xxx is fixing this report" (R-357).
 *
 * Pardeep, 7 Oct 2026: after a report went to the AI queue nothing on the report said the AI had
 * picked it up, so it looked untouched until it was fixed. The worker routine that turns the
 * queue into board cards calls this with {id, card}; the report then shows "AI working · R-xxx"
 * and /api/agent/feedback-queue stops handing it out again.
 *
 * Same narrow shape as /api/agent/feedback-checked: body {id, card}; only an open or queued row
 * that has not been claimed yet is touched; only agent_card / agent_claimed_at / updated_at
 * change. Same AGENT_QUEUE_TOKEN, compared in constant time; 503 when it is not configured.
 * Calling it again with the same card is a no-op success, so a retried routine is safe.
 *
 * Before migration 20261007110000_feedback_agent_claim.sql the columns do not exist: the route
 * answers 503 naming the migration instead of a bare 500, and nothing else in the app changes.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import type { Database } from "@/lib/supabase/database.types";
import {
  AGENT_CARD_RE,
  AGENT_CLAIM_MIGRATION,
  agentClaim,
  isMissingColumnError,
} from "@/lib/feedback/auto-send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FeedbackUpdate = Database["public"]["Tables"]["feedback"]["Update"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let id: unknown;
  let card: unknown;
  try { ({ id, card } = await req.json()); } catch { /* falls through to the check below */ }
  if (typeof id !== "string" || !UUID.test(id) || typeof card !== "string" || !AGENT_CARD_RE.test(card)) {
    return NextResponse.json({ error: "body must be {\"id\": \"<feedback uuid>\", \"card\": \"R-123\"}" }, { status: 400 });
  }

  const now = new Date().toISOString();
  /* Typed as the table Update: database.generated.ts learns these columns only after the
     migration is applied and the types are regenerated (scripts/check-db-types.mjs --write). */
  const patch = { agent_card: card, agent_claimed_at: now, updated_at: now } as FeedbackUpdate;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("feedback")
    .update(patch)
    .eq("id", id)
    .in("status", ["open", "agent_queued"])
    .is("agent_claimed_at", null)
    .select("id");
  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json({ error: `claim columns missing - migration ${AGENT_CLAIM_MIGRATION} not applied yet` }, { status: 503 });
    }
    return NextResponse.json({ error: "could not mark it claimed" }, { status: 500 });
  }
  if (data && data.length > 0) return NextResponse.json({ ok: true, id, card, claimed_at: now });

  /* Nothing matched: same card again is fine (retry); anything else is a real "no". */
  const { data: row } = await admin.from("feedback").select("*").eq("id", id).maybeSingle();
  const claim = agentClaim(row);
  if (claim && claim.card === card) {
    return NextResponse.json({ ok: true, id, card, claimed_at: claim.claimedAt, already: true });
  }
  if (claim) return NextResponse.json({ error: `already claimed by ${claim.card}` }, { status: 409 });
  return NextResponse.json({ error: "no open or queued report with that id" }, { status: 404 });
}
