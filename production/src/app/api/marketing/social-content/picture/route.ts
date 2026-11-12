/**
 * POST /api/marketing/social-content/picture — R-2697 (G-SOCIAL): "Make picture with AI".
 * Body { topic, caption } → the AI draws one square picture for the post and keeps it as a hidden
 * photo on the company's Facebook Page. Returns { mediaUrl: <Facebook photo link + "&ros=ai">, previewUrl }.
 * Who: anyone who may write social posts. One picture = one AI call against the monthly cap.
 * 401 no session · 403 no marketing access · 400 nothing to draw · 409 no Page / no Gemini key ·
 * 429 AI cap used up · 422 safety filter · 502 Google or Facebook failed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { createAdminClientFor } from "@/lib/supabase/server";
import { canWriteSocial, socialRole } from "@/lib/marketing/social-content";
import { makePostPicture } from "@/lib/marketing/social-picture.server";
import { logPersonActivity } from "@/lib/marketing/social-activity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  topic: z.string().trim().max(500).default(""),
  caption: z.string().trim().max(2200).default(""),
});

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!canWriteSocial(await socialRole(session))) return NextResponse.json({ error: "Marketing access required.", description: "Ask the owner to give you marketing access." }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Write the post first, then make the picture." }, { status: 400 });
  try {
    const result = await makePostPicture(createAdminClientFor(session.userId), session.tenantId, parsed.data);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });
    await logPersonActivity(session, { platform: "facebook", action: "Made a picture with AI", detail: (parsed.data.topic || parsed.data.caption).slice(0, 120) });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[social-picture] failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not make the picture.", description: "Nothing was posted. Try again in a minute." }, { status: 502 });
  }
}
