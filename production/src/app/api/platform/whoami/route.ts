/**
 * GET /api/platform/whoami — is the SIGNED-IN caller a platform (founder) admin?
 *
 * R-730 (19 Oct 2026): the browser used to work this out itself from
 * NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS, which put the whole god-mode allowlist into the JS
 * bundle. The list is now server-only (lib/platform.ts); the browser asks here and gets one
 * boolean about itself — never the list. It only toggles nav/UI: every platform route still
 * re-checks isPlatformAdmin() on the authenticated email before touching the admin client.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return NextResponse.json(
    { isPlatformAdmin: Boolean(user) && isPlatformAdmin(user?.email) },
    { headers: NO_STORE },
  );
}
