/**
 * POST /api/academy/apprentices/[id]/login — give an apprentice their own sign-in (R-149).
 *
 * Owner / manager only. Creates an auth account for the apprentice's email (confirmed, no
 * password), links it to the academy_apprentices row, and emails them how to set a password
 * (the normal Forgot-password page — the same reset flow staff use). The account starts with
 * a long random password nobody sees; no password is ever shown or emailed.
 *
 * The apprentice gets NO public.users row: that is what keeps every company table hidden
 * from them (current_tenant_id() is null) — see migration 20261004150000. So an email that
 * already belongs to a staff member, or to another company's account, is refused rather
 * than linked: one sign-in must never be both.
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClientFor, createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id, role, full_name").eq("id", auth.user.id).maybeSingle();
  if (!me || !["owner", "manager"].includes(me.role as string)) {
    return NextResponse.json({ error: "Only an owner or manager can create an apprentice login." }, { status: 403 });
  }

  // Read through the caller's own session: RLS proves this apprentice is in their company.
  const { data: appr } = await supabase.from("academy_apprentices").select("id, tenant_id, full_name, email, user_id").eq("id", id).maybeSingle();
  if (!appr || appr.tenant_id !== me.tenant_id) return NextResponse.json({ error: "Apprentice not found." }, { status: 404 });
  const email = (appr.email ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Add the apprentice's email first." }, { status: 400 });
  }

  const admin = createAdminClientFor(auth.user.id);

  // An email that is a staff login anywhere can never become an apprentice login.
  const { data: staff } = await admin.from("users").select("id").eq("email", email).maybeSingle();
  if (staff) return NextResponse.json({ error: "This email is already a staff login. Use a different email for the apprentice." }, { status: 409 });

  let userId = appr.user_id as string | null;
  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      // Unusable random password: the apprentice sets their own through Forgot password.
      password: randomBytes(24).toString("base64url") + "Aa1!",
      user_metadata: { full_name: appr.full_name, academy: true },
    });
    if (created.error) {
      if (/already|registered|exists/i.test(created.error.message)) {
        return NextResponse.json({ error: "This email already has an account elsewhere. Use a different email for the apprentice." }, { status: 409 });
      }
      console.error("[academy/login] createUser failed:", created.error.message);
      return NextResponse.json({ error: "Could not create the login. Try again." }, { status: 500 });
    }
    userId = created.data.user.id;
    const { error: linkErr } = await admin.from("academy_apprentices").update({ user_id: userId }).eq("id", appr.id).eq("tenant_id", me.tenant_id as string);
    if (linkErr) {
      await admin.auth.admin.deleteUser(userId).catch(() => null);
      console.error("[academy/login] link failed:", linkErr.message);
      return NextResponse.json({ error: "Could not link the login. Try again." }, { status: 500 });
    }
  }

  const origin = request.nextUrl.origin;
  const firstName = (appr.full_name as string).split(" ")[0];
  const result = await sendEmail({
    to: email,
    from: FROM_EMAIL,
    kind: "academy_login",
    route: { tenantId: me.tenant_id as string },
    subject: "Your ANUTECH Academy login",
    text: [
      `Hi ${firstName},`,
      "",
      `${me.full_name ?? "Your mentor"} has set up your ANUTECH Academy account — your training, tasks and feedback are there.`,
      "",
      "To sign in the first time, set your password:",
      `1. Open ${origin}/forgot-password`,
      `2. Enter this email: ${email}`,
      "3. Open the link we send you and choose a password.",
      "",
      `After that, sign in at ${origin}/login.`,
      "",
      "Never share your password, API keys or company files with anyone or paste them into an AI tool.",
    ].join("\n"),
  }).catch(() => null);

  return NextResponse.json({ ok: true, emailSent: result?.status === "sent" });
}
