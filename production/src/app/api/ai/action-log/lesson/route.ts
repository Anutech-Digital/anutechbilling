/**
 * POST /api/ai/action-log/lesson — Use lesson / Discard for a website-chat lesson (R-727).
 *
 * The public chat proposes lessons as HELD rows in ai_action_log; they show on /automation under
 * "waiting on you". This route records a person's decision as a NEW row (the log is append-only —
 * nothing holding a session can edit it, see the 20260823140000 migration), and the chat reads
 * only approved decision rows (lib/ai/public-chat-lessons.ts).
 *
 * Owner or manager only — the same people who may change the autonomy dial. The proposal is
 * looked up in the caller's own workspace; the write uses the service role, like every
 * ai_action_log write.
 *
 * Body: {"id": <held row id>, "decision": "approve" | "discard"}
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createBareClient } from "@/lib/supabase/bare";
import { buildAiActionRecord } from "@/lib/ai/action-log";
import { sanitizeLearning } from "@/lib/ai/public-sales-chat";
import { LESSON_ACTION, LESSON_DECISION_ENTITY } from "@/lib/ai/public-chat-lessons";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* ai_action_log is not in the generated Database type (see api/ai/action-log/route.ts) —
   the same untyped service-role client autonomy.server.ts uses. */
function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).single();
  const row = data as { tenant_id?: string | null; role?: string | null } | null;
  if (!row?.tenant_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (row.role !== "owner" && row.role !== "manager") {
    return NextResponse.json(
      { error: "Only an owner or a manager can decide what the website chat learns. Ask one of them to open Automation and approve or discard this lesson." },
      { status: 403 },
    );
  }
  const tenantId = row.tenant_id;

  let body: { id?: unknown; decision?: unknown } = {};
  try { body = (await request.json()) as typeof body; } catch { /* checked below */ }
  const id = typeof body.id === "number" && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
  const decision = body.decision === "approve" || body.decision === "discard" ? body.decision : null;
  if (id === null || decision === null) {
    return NextResponse.json({ error: "body must be {\"id\": <lesson id>, \"decision\": \"approve\" | \"discard\"}" }, { status: 400 });
  }

  const db = bare();
  if (!db) return NextResponse.json({ error: "Supabase is not configured on the server. Nothing was changed." }, { status: 503 });

  const { data: proposal } = await db
    .from("ai_action_log")
    .select("id, reason")
    .eq("id", id)
    .eq("tenant_id", tenantId)          // <- the caller's own workspace only
    .eq("action", LESSON_ACTION)
    .eq("outcome", "held")
    .maybeSingle();
  if (!proposal) {
    return NextResponse.json(
      { error: "This lesson is no longer waiting in your workspace. Reload Automation to see the current list." },
      { status: 404 },
    );
  }

  const { data: earlier } = await db
    .from("ai_action_log")
    .select("id, outcome")
    .eq("tenant_id", tenantId)
    .eq("action", LESSON_ACTION)
    .eq("entity", LESSON_DECISION_ENTITY)
    .eq("entity_id", String(id))
    .limit(1);
  if ((earlier ?? []).length > 0) {
    const was = (earlier as Array<{ outcome?: string }>)[0]?.outcome === "did" ? "approved" : "discarded";
    return NextResponse.json(
      { error: `This lesson was already ${was}. Reload Automation to see the current list.` },
      { status: 409 },
    );
  }

  const lesson = sanitizeLearning((proposal as { reason?: unknown }).reason);
  if (decision === "approve" && !lesson) {
    return NextResponse.json(
      { error: "This lesson contains a number, a price or a link, which the website chat is never allowed to learn. Press Discard to remove it from the list." },
      { status: 422 },
    );
  }

  const rec = buildAiActionRecord({
    tenantId,
    action: LESSON_ACTION,
    outcome: decision === "approve" ? "did" : "skipped",
    reason: decision === "approve" ? lesson! : "a person discarded this website-chat lesson; the chat will not use it",
    mode: "hold",
    entity: LESSON_DECISION_ENTITY,
    entityId: String(id),
    facts: decision === "approve"
      ? { approvedFrom: id, decidedBy: auth.user.id }
      : { rejectedFrom: id, decidedBy: auth.user.id },
  });
  const { error } = await db.from("ai_action_log").insert({
    tenant_id: rec.tenantId,
    action:    rec.action,
    outcome:   rec.outcome,
    reason:    rec.reason,
    mode:      rec.mode,
    entity:    rec.entity,
    entity_id: rec.entityId,
    facts:     rec.facts,
  });
  if (error) {
    console.error("[ai/action-log/lesson] decision insert failed:", error.message);
    return NextResponse.json(
      { error: "Could not save your decision. Nothing changed — the lesson is still waiting. Please try again." },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, id, decision });
}
