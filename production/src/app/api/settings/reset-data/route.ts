/**
 * POST /api/settings/reset-data
 *   { tables: string[], label: string, confirmStatutory?: boolean, password: string }
 *
 * The missing half of the reset feature. `reset_tenant_selected_tables` (0241) has
 * existed and been correct for a while; there was simply no way to reach it from
 * the app, so the safest destructive operation in the product was also the only
 * one an owner could not perform.
 *
 * ─── THIS ROUTE DELIBERATELY DECIDES NOTHING ─────────────────────────────────
 * It re-checks the password, then forwards the SESSION client to the function.
 * Every actual rule — owner-only, the table allowlist, the statutory refusal, the
 * pre-reset snapshot and its zero-byte check, the refusal to delete from a table
 * with no tenant_id — lives in Postgres, inside the same transaction as the
 * delete. Re-implementing any of it here would create a second, weaker copy that
 * a `curl` skips straight past.
 *
 * ─── WHY A PASSWORD, WHEN THE SESSION ALREADY PROVES WHO YOU ARE ─────────────
 * It does not add authentication; it adds INTENT. An open laptop, a borrowed
 * session or a stray click should not be able to empty a workspace. This is the
 * same reason a bank re-asks at transfer time.
 *
 * The check runs on a THROWAWAY client, never the cookie-backed one: verifying a
 * password with the request's own client would mint a fresh session and rotate
 * the caller's tokens as a side effect of a safety check.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { createBareClient } from "@/lib/supabase/bare";

const schema = z.object({
  tables:           z.array(z.string().min(1)).min(1, "Tick at least one section to reset."),
  label:            z.string().trim().min(1).max(120),
  confirmStatutory: z.boolean().optional().default(false),
  password:         z.string().min(1, "Enter your password to confirm."),
});

export async function POST(request: NextRequest) {
  const supabase = createSessionClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  // ── Re-confirm intent. Throwaway client: no cookies, no session written. ──
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });
  }
  const check = createBareClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: pwErr } = await check.auth.signInWithPassword({
    email:    authData.user.email,
    password: parsed.data.password,
  });
  if (pwErr) {
    // Same message whatever went wrong — this endpoint must not become a way to
    // probe passwords.
    return NextResponse.json({ error: "That password is not correct." }, { status: 403 });
  }

  // ── Hand over to the function. It owns every rule. ───────────────────────
  const { data, error } = await supabase.rpc("reset_tenant_selected_tables", {
    p_tables:            parsed.data.tables,
    p_label:             parsed.data.label,
    p_confirm_statutory: parsed.data.confirmStatutory,
  });

  if (error) {
    // 409, not 500: every refusal in that function is a state the owner can act
    // on, and its messages already carry the reason and the next step (§24).
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, result: data });
}
