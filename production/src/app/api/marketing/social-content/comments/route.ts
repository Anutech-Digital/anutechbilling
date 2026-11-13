/**
 * POST /api/marketing/social-content/comments — R-2689 (G-SOCIAL): comments on the company's posts.
 * { action: "check" }                 — read new comments now and let the AI draft replies.
 * { action: "send", id, text }        — a person sends (or edits and sends) the reply.
 * { action: "ignore", id }            — no reply needed.
 * Who: the marketing team, owner or manager (R-2709). 401 · 403 · 400 · 409 no Page · 404 · 502 Meta.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantSession } from "@/server/auth/session";
import { createAdminClientFor } from "@/lib/supabase/server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { canReviewSocial, socialRole } from "@/lib/marketing/social-content";
import { draftReplies, fetchComments, sendReply, COMMENT_PERMISSION_HELP } from "@/lib/marketing/social-engagement.server";
import { readAutopilotSettings } from "@/lib/marketing/social-autopilot.server";
import { logPersonActivity } from "@/lib/marketing/social-activity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const UUID = z.string().uuid();
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("send"), id: UUID, text: z.string().trim().min(1, "Write the reply first.").max(800) }),
  z.object({ action: z.literal("ignore"), id: UUID }),
]);

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!canReviewSocial(await socialRole(session))) return NextResponse.json({ error: "Only the marketing team can answer comments.", description: "Ask the owner to give you marketing access." }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Choose what to do." }, { status: 400 });
  const typed = createAdminClientFor(session.userId);
  const admin = typed as unknown as SupabaseClient;
  const input = parsed.data;
  try {
    if (input.action === "ignore") {
      const { data, error } = await admin.from("social_comments").update({ status: "ignored" }).eq("tenant_id", session.tenantId).eq("id", input.id).neq("status", "replied").select("message, platform");
      if (error) throw error;
      const row = (data ?? [])[0] as { message: string; platform: string } | undefined;
      if (!row) return NextResponse.json({ error: "Comment not found, or it already has a reply.", description: "Refresh the page." }, { status: 404 });
      await logPersonActivity(session, { platform: row.platform, action: "Ignored a comment", detail: row.message.slice(0, 120) });
      return NextResponse.json({ ok: true });
    }
    const connection = await readFacebookPage(typed, session.tenantId);
    if (!connection.pageId || !connection.pageToken) return NextResponse.json({ error: "Connect your Facebook Page first.", description: "Marketing Hub → Facebook Page." }, { status: 409 });
    if (input.action === "check") {
      const s = await readAutopilotSettings(session);
      const { data: settings } = await admin.from("social_content_settings").select("comment_mode").eq("tenant_id", session.tenantId).maybeSingle();
      const mode = ((settings as { comment_mode?: "off" | "ask" | "auto" } | null)?.comment_mode ?? "ask");
      const got = await fetchComments(admin, session.tenantId, connection);
      if (got.noPermission) return NextResponse.json({ error: "Meta did not let the app read comments.", description: COMMENT_PERMISSION_HELP }, { status: 409 });
      const drafts = mode === "off" ? { drafted: 0, sent: 0 } : await draftReplies(admin, session.tenantId, connection, { mode, aiPaused: s.ai_paused, brief: s.brief });
      return NextResponse.json({ ok: true, added: got.added, ...drafts });
    }
    const sent = await sendReply(admin, session.tenantId, connection, input.id, input.text, { actor: "person", userId: session.userId, name: "" });
    if (!sent.ok) return NextResponse.json({ error: sent.error, description: sent.noPermission ? COMMENT_PERMISSION_HELP : "Nothing was posted. Try again." }, { status: sent.noPermission ? 409 : 502 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[social-comments] action failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not do that.", description: "Nothing was posted. Try again in a minute." }, { status: 502 });
  }
}
