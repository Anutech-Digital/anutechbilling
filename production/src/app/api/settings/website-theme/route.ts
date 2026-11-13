/**
 * GET   /api/settings/website-theme   → { visible, theme, ready, error? }
 * PATCH /api/settings/website-theme   { theme: "classic" | "warm" } → { ok, theme }
 *
 * The public website's theme (lib/website-theme.ts), switched by the OWNER of the website's
 * own workspace from Settings → Branding. A route rather than a direct client update because
 * only the server knows which workspace owns the website (BUY_PAGE_TENANT_ID), and because a
 * switch must refresh the already-built website pages (revalidatePath) to show at once.
 *
 * The write goes through the caller's own session client, so the database's owner-only RLS on
 * tenants (tenants_self_update) is enforced as well as the check here; `.select("id")` tells
 * "saved" from "matched no row" (AGENTS.md L84).
 */
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import {
  DEFAULT_WEBSITE_THEME,
  WEBSITE_THEME_NEEDS_DB,
  isWebsiteThemeColumnMissing,
  parseWebsiteTheme,
  websiteThemeAccess,
} from "@/lib/website-theme";
import { rememberWebsiteTheme } from "@/lib/website-theme.server";

export const dynamic = "force-dynamic";

async function caller() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, role: null, tenantId: null };
  const { data: me } = await supabase.from("users").select("role, tenant_id").eq("id", user.id).maybeSingle();
  return {
    supabase,
    user,
    role: (me?.role as string | null | undefined) ?? null,
    tenantId: (me?.tenant_id as string | null | undefined) ?? null,
  };
}

export async function GET() {
  const c = await caller();
  const access = websiteThemeAccess({
    signedIn: Boolean(c.user),
    role: c.role,
    tenantId: c.tenantId,
    websiteTenantId: websiteTenantId(),
  });
  // The card is shown only to the person who can use it; everyone else gets "not visible".
  if (!access.ok) return NextResponse.json({ visible: false });

  const db = c.supabase as unknown as SupabaseClient;
  const { data, error } = await db.from("tenants").select("website_theme").eq("id", c.tenantId as string).maybeSingle();
  if (isWebsiteThemeColumnMissing(error)) {
    return NextResponse.json({ visible: true, ready: false, theme: DEFAULT_WEBSITE_THEME, error: WEBSITE_THEME_NEEDS_DB });
  }
  if (error) return NextResponse.json({ visible: true, ready: false, error: error.message }, { status: 500 });
  const theme = parseWebsiteTheme((data as { website_theme?: unknown } | null)?.website_theme);
  if (!theme) {
    return NextResponse.json(
      { visible: true, ready: false, error: "The saved website theme is not one this app knows. Choose Classic or Warm to fix it." },
      { status: 500 },
    );
  }
  return NextResponse.json({ visible: true, ready: true, theme });
}

export async function PATCH(req: NextRequest) {
  const c = await caller();
  const site = websiteTenantId();
  const access = websiteThemeAccess({ signedIn: Boolean(c.user), role: c.role, tenantId: c.tenantId, websiteTenantId: site });
  if (!access.ok) return NextResponse.json({ ok: false, error: access.error }, { status: access.status });

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "The request was not valid JSON. Reload Settings and try again." }, { status: 400 }); }
  const theme = parseWebsiteTheme((body as { theme?: unknown } | null)?.theme);
  if (!theme) {
    return NextResponse.json({ ok: false, error: "Choose Classic or Warm — that theme is not one this app knows." }, { status: 400 });
  }

  const db = c.supabase as unknown as SupabaseClient;
  const { data, error } = await db.from("tenants").update({ website_theme: theme }).eq("id", site as string).select("id");
  if (isWebsiteThemeColumnMissing(error)) {
    // Ours to fix (a deploy step), not the owner's — 503, and the message says what happens next.
    console.warn("[website-theme] switch refused: migration 20261113102122 not applied on this database");
    return NextResponse.json({ ok: false, error: WEBSITE_THEME_NEEDS_DB }, { status: 503 });
  }
  if (error) {
    console.error(`[website-theme] switch failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: `The theme was not saved: ${error.message}. Try again; if it repeats, report it.` }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json(
      { ok: false, error: "The theme was not saved: the database allows only the workspace owner to change it. Ask the owner." },
      { status: 403 },
    );
  }

  rememberWebsiteTheme(site as string, theme);
  // Every (marketing) page is built ahead of time (revalidate 60–600 s); rebuild them now.
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, theme });
}
