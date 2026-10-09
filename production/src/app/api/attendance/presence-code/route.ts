/**
 * GET /api/attendance/presence-code → { code, secondsRemaining, windowSec }
 *
 * Returns the CURRENT rotating office code for the caller's tenant, for display
 * on the office kiosk/tablet. The seed (presence_secret) is read + used only
 * server-side; if the tenant has none yet, one is generated lazily. Never
 * exposes the seed — only the derived 6-digit code.
 *
 * R-601: `authenticated` can no longer select presence_secret at all, so the seed
 * is read and created through the server client, scoped to the caller's tenant.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { presenceCode, currentWindow, secondsRemaining, newPresenceSecret, PRESENCE_WINDOW_SEC } from "@/lib/attendance/presence";

export async function GET() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const admin = createAdminClientFor(authData.user.id);
  const { data: settings } = await admin
    .from("attendance_settings").select("presence_secret").eq("tenant_id", me.tenant_id).maybeSingle();

  let secret = settings?.presence_secret ?? null;
  if (!secret) {
    secret = newPresenceSecret();
    // Upsert keeps any existing allowed_ips / require_selfie untouched.
    await admin.from("attendance_settings").upsert(
      { tenant_id: me.tenant_id, presence_secret: secret, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id" },
    );
  }

  const now = Date.now();
  return NextResponse.json({
    code: presenceCode(secret, currentWindow(now)),
    secondsRemaining: secondsRemaining(now),
    windowSec: PRESENCE_WINDOW_SEC,
  });
}
