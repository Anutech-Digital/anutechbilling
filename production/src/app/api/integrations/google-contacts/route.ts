/**
 * Google Contacts integration status + disconnect.
 *
 *   GET    → { connected, email, last_synced_at, configured } (never returns tokens)
 *   DELETE → disconnect (removes the stored tokens for this user)
 *
 * Reads/writes go through the service-role admin client (the token table is
 * RLS-locked); the caller is always identified by their own session.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_google_tokens")
    .select("google_email, refresh_token, last_synced_at, last_error")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    configured: !!googleOAuthCreds(),
    connected: !!data?.refresh_token,
    email: data?.google_email ?? null,
    last_synced_at: data?.last_synced_at ?? null,
    last_error: data?.last_error ?? null,
  });
}

export async function DELETE() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const { error } = await admin.from("user_google_tokens").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
