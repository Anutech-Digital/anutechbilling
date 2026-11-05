import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { canReviewSocial, canWriteSocial, claimApproved, completePublish, publishSocial, socialRole, updateSocial, validMediaUrl } from "@/lib/marketing/social-content";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const payload = z.object({ action: z.enum(["save", "submit", "approve", "return", "publish"]),
  caption: z.string().trim().max(2200).optional(), mediaUrl: z.string().trim().max(2000).nullable().optional(),
  topic: z.string().trim().max(500).optional() });
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
  if (["approve", "return", "publish"].includes(input.action) && !canReviewSocial(role)) return NextResponse.json({ error: "Only an owner or manager can review and publish." }, { status: 403 });
  try {
    if (input.action === "publish") {
      const item = await claimApproved(session, id);
      if (!item) return NextResponse.json({ error: "Approve this draft before publishing." }, { status: 409 });
      try {
        const externalId = await publishSocial(session, item);
        await completePublish(session, id, externalId, null);
        return NextResponse.json({ ok: true, externalId });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "Meta publishing failed.";
        await completePublish(session, id, null, message);
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
    const before = await withTenant(session, tx => tx.$queryRaw<{ status: string; platform: string; format: string; media_url: string | null; caption: string }[]>`
      select status, platform, format, media_url, caption from public.social_content where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid limit 1`);
    const current = before[0];
    if (!current) return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    const allowed = input.action === "save" ? ["draft", "review", "failed"] : input.action === "submit" ? ["draft", "failed"] : ["review"];
    if (!allowed.includes(current.status)) return NextResponse.json({ error: "This draft is no longer in that stage. Refresh the page." }, { status: 409 });
    const media = input.mediaUrl === undefined ? current.media_url : input.mediaUrl;
    const caption = input.caption === undefined ? current.caption : input.caption;
    if (current.platform === "instagram" && !media) return NextResponse.json({ error: "Instagram needs an image URL." }, { status: 400 });
    if (current.format === "post" && !caption) return NextResponse.json({ error: "Write a caption." }, { status: 400 });
    const next = input.action === "submit" ? "review" : input.action === "approve" ? "approved" : input.action === "return" ? "draft" : undefined;
    const item = await updateSocial(session, id, { caption: input.caption, mediaUrl: input.mediaUrl, topic: input.topic, status: next }, current.status as "draft" | "review" | "failed", input.action === "approve" || input.action === "return");
    if (!item) return NextResponse.json({ error: "Draft changed. Refresh the page." }, { status: 409 });
    return NextResponse.json({ item });
  } catch (error) {
    console.error("[social-content] action failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not update this draft." }, { status: 500 });
  }
}
