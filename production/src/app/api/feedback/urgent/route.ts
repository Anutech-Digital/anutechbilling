/**
 * POST /api/feedback/urgent — R-397: mark a bug report "⚡ Urgent" (or take it back).
 *
 *   Body: { id: <report uuid>, urgent: true | false }
 *   200 → { ok: true, urgent, queued }   queued = this press also sent an OPEN report to the AI
 *
 * Who: the workspace OWNER or MANAGER for their own workspace's report — role and tenant are
 * read from the users row in the DB, never from the body — or the platform owner
 * (isPlatformAdmin on the AUTHENTICATED email, same gate as admin/feedback/platform/dispatch)
 * for any workspace. Anyone else: 403 before the service role is created. A report in another
 * workspace answers 404 to a non-platform caller, so ids cannot be probed.
 *
 * What it writes (service role, pinned to the row's OWN tenant):
 *   - ON, report open      → queues it too, conditional on it still being open with the same
 *                            dispatched_at it was read with (R-357/R-366's rule), plus urgent_at/by.
 *                            If someone queued it a moment ago, it is marked urgent as queued.
 *   - ON, report queued/claimed → urgent_at/by only.
 *   - OFF                  → clears urgent_at/by only; never un-queues.
 *
 * Before migration 20261007234000_feedback_urgent.sql the row has no urgent_at column: 409
 * naming the file (the page hides the button then anyway).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { isPlatformAdmin } from "@/lib/platform";
import { isMissingColumnError } from "@/lib/feedback/auto-send";
import {
  urgentBody,
  mayMarkUrgent,
  urgentReady,
  canSetUrgent,
  urgentPatch,
  urgentQueuePatch,
  URGENT_MIGRATION,
} from "@/lib/feedback/urgent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FeedbackUpdate = Database["public"]["Tables"]["feedback"]["Update"];
type ReadRow = { id: string; tenant_id: string; status: string; dispatched_at: string | null };

const NOT_READY = {
  error: `Urgent needs migration ${URGENT_MIGRATION} — not applied on this server yet.`,
  nextStep: "Ask the owner to apply it; until then use Run AI Auto-Fix.",
};

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const parsed = urgentBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Body must be {"id": "<report id>", "urgent": true|false}.' }, { status: 400 });
  }

  const platform = isPlatformAdmin(auth.user.email);
  let myTenant: string | null = null;
  if (!platform) {
    const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).maybeSingle();
    if (!me?.tenant_id || !mayMarkUrgent(me.role)) {
      return NextResponse.json(
        { error: "Only the workspace owner or a manager can mark a report urgent.", nextStep: "Ask one of them to press it." },
        { status: 403 },
      );
    }
    myTenant = me.tenant_id as string;
  }

  const admin = createAdminClient();
  const { data: found, error: readErr } = await admin.from("feedback").select("*").eq("id", parsed.data.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: "Could not read the report." }, { status: 500 });
  if (!found || (!platform && found.tenant_id !== myTenant)) {
    return NextResponse.json({ error: "Report not found." }, { status: 404 });
  }
  if (!urgentReady(found)) return NextResponse.json(NOT_READY, { status: 409 });
  const row = found as unknown as ReadRow;

  const on = parsed.data.urgent;
  if (on && !canSetUrgent(row.status)) {
    return NextResponse.json(
      { error: "Only an open or queued report can be marked urgent.", nextStep: "Reopen it first if it still matters." },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const write = async (patch: Record<string, unknown>, status?: "open" | "agent_queued", dispatchedAt?: string | null) => {
    let q = admin
      .from("feedback")
      .update(patch as FeedbackUpdate)
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id);
    if (status) q = q.eq("status", status);
    if (dispatchedAt !== undefined) q = dispatchedAt === null ? q.is("dispatched_at", null) : q.eq("dispatched_at", dispatchedAt);
    const { data, error } = await q.select("id");
    return { hit: (data ?? []).length > 0, error };
  };
  const fail = (error: { code?: string | null; message?: string | null }) =>
    isMissingColumnError(error)
      ? NextResponse.json(NOT_READY, { status: 409 })
      : NextResponse.json({ error: "Could not save. Reload and try again." }, { status: 500 });

  if (!on) {
    const r = await write(urgentPatch(false, auth.user.id, now));
    if (r.error) return fail(r.error);
    return NextResponse.json({ ok: true, urgent: false, queued: false });
  }

  if (row.status === "open") {
    const r = await write(urgentQueuePatch(auth.user.id, now), "open", row.dispatched_at);
    if (r.error) return fail(r.error);
    if (r.hit) return NextResponse.json({ ok: true, urgent: true, queued: true });
    /* Lost a race: the auto-send or another tab queued it a moment ago — mark that one urgent. */
  }

  const r = await write(urgentPatch(true, auth.user.id, now), "agent_queued");
  if (r.error) return fail(r.error);
  if (!r.hit) {
    return NextResponse.json(
      { error: "The report changed while you pressed it.", nextStep: "Reload the page and press Urgent again." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, urgent: true, queued: false });
}
