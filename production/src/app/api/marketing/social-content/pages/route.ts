/**
 * PATCH /api/marketing/social-content/pages — R-2729 (G-SOCIAL): "Manage Pages".
 * { pageId, active } switches one of the company's Facebook Pages on or off for Social growth.
 * The list itself comes with GET /api/marketing/social-content (pages). New Pages appear after
 * connecting Facebook again (every Page the login manages is saved then).
 * Who: the marketing team, owner or manager (all of them see every Page — Abhishek, 13 Nov 2026).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantSession } from "@/server/auth/session";
import { createAdminClientFor } from "@/lib/supabase/server";
import { canReviewSocial, socialRole } from "@/lib/marketing/social-content";
import { listPages, updatePage } from "@/lib/marketing/social-pages.server";
import { logPersonActivity } from "@/lib/marketing/social-activity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ pageId: z.string().regex(/^\d{1,30}$/, "Choose a Page."), active: z.boolean() });

export async function PATCH(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!canReviewSocial(await socialRole(session))) return NextResponse.json({ error: "Only the marketing team can choose Pages.", description: "Ask the owner to give you marketing access." }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Choose a Page." }, { status: 400 });
  const admin = createAdminClientFor(session.userId) as unknown as SupabaseClient;
  try {
    const pages = await listPages(admin, session.tenantId);
    const page = pages.find((p) => p.page_id === parsed.data.pageId);
    if (!page) return NextResponse.json({ error: "This Page is not connected.", description: "Connect Facebook again to add it (Marketing Hub → Facebook Page)." }, { status: 404 });
    if (!parsed.data.active && pages.filter((p) => p.active).length <= 1 && page.active) return NextResponse.json({ error: "Keep at least one Page switched on.", description: "Switch another Page on first." }, { status: 409 });
    await updatePage(admin, session.tenantId, page.page_id, { active: parsed.data.active });
    await logPersonActivity(session, { pageId: page.page_id, action: parsed.data.active ? "Switched a Page on" : "Switched a Page off", detail: page.name });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[social-pages] switch failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not change the Page.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}
