/**
 * POST /api/integrations/google-contacts/sync — run a two-way sync now.
 *
 * On-demand counterpart to the daily cron. Runs the sync for the signed-in user
 * and returns how many contacts were pulled/pushed/created. Records last_error on
 * failure so the Settings card can surface it.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { syncUserContacts } from "@/lib/google/contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant." }, { status: 400 });

  const admin = createAdminClient();
  try {
    // Manual sync = full pull, so a just-created phone contact always shows up
    // (Google's incremental sync can lag on brand-new contacts).
    const result = await syncUserContacts(admin, user.id, me.tenant_id, { full: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = (e as Error).message || "Sync failed";
    await admin.from("user_google_tokens").update({ last_error: msg }).eq("user_id", user.id);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
