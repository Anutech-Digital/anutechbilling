import { NextResponse } from "next/server";
import { logPersonActivity } from "@/lib/marketing/social-activity";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { canReviewSocial, canWriteSocial, claimApproved, completePublish, publishSocial, socialRole, updateSocial, validMediaUrl } from "@/lib/marketing/social-content";
import { parseIstLocal, scheduleProblem } from "@/lib/marketing/social-schedule";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const payload = z.object({ action: z.enum(["save", "submit", "approve", "return", "publish", "stop"]),
  caption: z.string().trim().max(2200).optional(), mediaUrl: z.string().trim().max(2000).nullable().optional(),
  topic: z.string().trim().max(500).optional(),
  /* R-2510: post time as typed in the form ("2026-11-06T09:00", India time); null clears it. */
  scheduledAt: z.string().trim().max(16).nullable().optional() });
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Marketing access required." }, { status: 403 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid draft." }, { status: 400 });
  const parsed = payload.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid action." }, { status: 400 });
  const input = parsed.data;
  if (input.mediaUrl !== undefined && !validMediaUrl(input.mediaUrl)) return NextResponse.json({ error: "Use a public HTTPS media URL." }, { status: 400 });
  let scheduledAt: Date | null | undefined;
  if (input.scheduledAt !== undefined) {
    if (!["save", "submit"].includes(input.action)) return NextResponse.json({ error: "Change the post time while the draft is being edited." }, { status: 400 });
    scheduledAt = input.scheduledAt ? parseIstLocal(input.scheduledAt) : null;
    if (scheduledAt === null && input.scheduledAt) return NextResponse.json({ error: "Choose a valid post date and time." }, { status: 400 });
    const problem = scheduledAt ? scheduleProblem(scheduledAt) : null;
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  if (["approve", "return", "publish", "stop"].includes(input.action) && !canReviewSocial(role)) return NextResponse.json({ error: "Only an owner or manager can review and publish." }, { status: 403 });
  try {
    if (input.action === "publish") {
      const item = await claimApproved(session, id);
      if (!item) return NextResponse.json({ error: "Approve this draft before publishing." }, { status: 409 });
      try {
        const externalId = await publishSocial(session, item);
        await completePublish(session, id, externalId, null);
        await logPersonActivity(session, { platform: item.platform, action: "Posted now", detail: item.caption.slice(0, 120), contentId: id });
        return NextResponse.json({ ok: true, externalId });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "Meta publishing failed.";
        await completePublish(session, id, null, message);
        await logPersonActivity(session, { platform: item.platform, action: "Post failed", detail: message, contentId: id, result: "failed" });
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
    const before = await withTenant(session, tx => tx.$queryRaw<{ status: string; platform: string; format: string; media_url: string | null; caption: string }[]>`
      select status, platform, format, media_url, caption from public.social_content where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid limit 1`);
    const current = before[0];
    if (!current) return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    /* R-2672: "stop" takes a scheduled (approved) post — e.g. one the AI autopilot planned — back to Drafts before it goes out. */
    /* R-2687: a scheduled (approved) post can be edited too — by an owner/manager only — and stays scheduled. */
    if (input.action === "save" && current.status === "approved" && !canReviewSocial(role)) return NextResponse.json({ error: "Only an owner or manager can change a scheduled post.", description: "Ask them, or press Stop first." }, { status: 403 });
    const allowed = input.action === "save" ? ["draft", "review", "failed", "approved"] : input.action === "submit" ? ["draft", "failed"] : input.action === "stop" ? ["approved"] : ["review"];
    if (!allowed.includes(current.status)) return NextResponse.json({ error: "This draft is no longer in that stage. Refresh the page." }, { status: 409 });
    const media = input.mediaUrl === undefined ? current.media_url : input.mediaUrl;
    const caption = input.caption === undefined ? current.caption : input.caption;
    if (current.platform === "instagram" && !media) return NextResponse.json({ error: "Instagram needs an image URL." }, { status: 400 });
    if (current.format === "post" && !caption) return NextResponse.json({ error: "Write a caption." }, { status: 400 });
    const next = input.action === "submit" ? "review" : input.action === "approve" ? "approved" : input.action === "return" || input.action === "stop" ? "draft" : undefined;
    const item = await updateSocial(session, id, { caption: input.caption, mediaUrl: input.mediaUrl, topic: input.topic, status: next, scheduledAt }, current.status as "draft" | "review" | "failed" | "approved", input.action === "approve" || input.action === "return" || input.action === "stop");
    if (!item) return NextResponse.json({ error: "Draft changed. Refresh the page." }, { status: 409 });
    const verb: Record<string, string> = { save: "Edited a post", submit: "Sent a post for approval", approve: "Approved a post", return: "Sent a post back", stop: "Stopped a scheduled post" };
    await logPersonActivity(session, { platform: current.platform, action: verb[input.action] ?? input.action, detail: (caption ?? "").slice(0, 120), contentId: id });
    return NextResponse.json({ item });
  } catch (error) {
    console.error("[social-content] action failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not update this draft." }, { status: 500 });
  }
}

/**
 * R-2687: delete a post that has not gone out (draft, waiting, scheduled, failed). A published post
 * stays — it is on the Page. Owner / manager may delete any; the marketing person only their own.
 */
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Marketing access required." }, { status: 403 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid post." }, { status: 400 });
  try {
    const rows = await withTenant(session, tx => tx.$queryRaw<{ status: string; platform: string; caption: string; created_by: string | null }[]>`
      select status, platform, caption, created_by from public.social_content where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid limit 1`);
    const current = rows[0];
    if (!current) return NextResponse.json({ error: "Post not found. Refresh the page." }, { status: 404 });
    if (["published", "publishing"].includes(current.status)) return NextResponse.json({ error: "This post is already on the Page.", description: "Delete it on Facebook / Instagram itself." }, { status: 409 });
    if (!canReviewSocial(role) && current.created_by !== session.userId) return NextResponse.json({ error: "You can delete only your own posts.", description: "Ask the owner or a manager." }, { status: 403 });
    await logPersonActivity(session, { platform: current.platform, action: "Deleted a post", detail: current.caption.slice(0, 120) });
    const deleted = await withTenant(session, tx => tx.$executeRaw`
      delete from public.social_content where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid and status not in ('published', 'publishing')`);
    if (!deleted) return NextResponse.json({ error: "This post changed. Refresh the page." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[social-content] delete failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not delete the post.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}
