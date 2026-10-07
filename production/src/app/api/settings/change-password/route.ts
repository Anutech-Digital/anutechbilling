/**
 * POST /api/settings/change-password — change your own password from inside the app.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Until 22 Aug 2026 there was no way to change a password at all. The only route to a new
 * one was the recovery email, and before that morning not even that — `(auth)/` held login,
 * signup, callback and welcome and nothing else (AGENTS.md L15). A teammate who simply
 * wanted to rotate a password they already knew had to ask an owner to go into the Supabase
 * dashboard.
 *
 * ─── THE CURRENT PASSWORD IS RE-CHECKED, AND NOT ON THE CLIENT ──────────────
 * `updateUser({ password })` needs only a valid session, so a stolen or borrowed browser
 * tab could change the password and lock the real owner out. Asking for the current one
 * closes that.
 *
 * It is checked with a THROWAWAY client, the same device `api/settings/reset-data` uses and
 * for the same reason: calling `signInWithPassword` on the request's own client mints a
 * fresh session and rotates the caller's cookies mid-request. Nothing is persisted here —
 * no cookies, no session — and the answer is used only as a yes/no.
 *
 * ─── THE UPDATE GOES THROUGH THE ADMIN CLIENT ───────────────────────────────
 * For the same reason: the session client would write new tokens as a side effect of the
 * update. `auth.admin.updateUserById` changes the password and leaves this request's
 * session alone, so the operator stays signed in on the device they are using.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient as createSessionClient, createAdminClient } from "@/lib/supabase/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { checkPasswordChange } from "@/lib/auth/password-rules";
import { MUST_CHANGE_PASSWORD_KEY, mustChangePassword } from "@/lib/auth/must-change-password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword:     z.string().min(1, "Enter a new password."),
});

export async function POST(req: Request) {
  const supabase = createSessionClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Both your current password and a new one are required." },
      { status: 400 },
    );
  }

  /* The new password is judged BEFORE the current one is checked, so somebody who typed a
     weak new password is told that rather than being sent hunting for a typo in the old
     one. Neither answer leaks anything: the rules are public and the account is already
     proven by the session. */
  const problem = checkPasswordChange(parsed.currentPassword, parsed.newPassword);
  if (problem) {
    return NextResponse.json({ error: problem.message }, { status: 422 });
  }

  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });
  }

  const check = createBareClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: pwErr } = await check.auth.signInWithPassword({
    email:    user.email,
    password: parsed.currentPassword,
  });
  if (pwErr) {
    /* One message whatever went wrong, so this cannot become a way to probe passwords —
       the same posture as the reset-data endpoint. */
    return NextResponse.json({ error: "That current password is not correct." }, { status: 403 });
  }

  const admin = createAdminClient();
  /* R-391: an owner-set temporary password carries app_metadata.must_change_password, which
     sends the member to /change-password until they pick their own. Choosing one here is
     exactly that, so the flag is cleared in the same write — null removes the key on GoTrue
     and reads as "not set" on R-161's Auth.js store. Only when set, so an ordinary change
     does not touch app_metadata at all. */
  const forced = mustChangePassword(user);
  const { error: upErr } = await admin.auth.admin.updateUserById(user.id, {
    password: parsed.newPassword,
    ...(forced ? { app_metadata: { [MUST_CHANGE_PASSWORD_KEY]: null } } : {}),
  });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  /* Other devices keep their existing sessions — Supabase does not invalidate them on a
     password change, and saying so is better than implying a change that did not happen.
     Signing every session out would be a defensible choice, but it is a different decision
     and would knock the operator out of the app they are standing in. */
  return NextResponse.json({
    ok: true,
    note: "Password changed. Sessions already signed in elsewhere are not signed out.",
  });
}
