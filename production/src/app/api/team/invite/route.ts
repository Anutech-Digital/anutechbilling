/**
 * POST /api/team/invite  { email, role }
 *
 * Owner-only. Pre-authorises `email` to join the caller's tenant (a
 * team_invites row — the invitee joins on first Google sign-in with that
 * email) AND emails the invitee an instruction to sign in.
 *
 * The email is best-effort: if Resend isn't configured (RESEND_API_KEY unset)
 * it stubs, and the invite is still created — the pre-authorisation is what
 * actually grants access, the email is just the nudge. The response reports
 * the email status so the UI can tell the operator whether it went out.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

const schema = z.object({
  email: z.string().email().max(200),
  role:  z.enum(["owner", "manager", "sales", "sales_senior", "billing", "accountant", "delivery", "support"]),
});

export async function POST(request: NextRequest) {
  const supabase = createClient();

  // ── Auth: must be signed in ───────────────────────────────────────────
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // ── Caller's tenant + role — only an OWNER may invite ─────────────────
  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "User not linked to a tenant" }, { status: 403 });
  }
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can invite teammates" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or role" }, { status: 400 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const role  = parsed.data.role;

  // ── Create the invite (RLS: team_invites is owner-scoped) ─────────────
  const { error: insErr } = await supabase
    .from("team_invites")
    .insert({ tenant_id: me.tenant_id, email, role, invited_by: authData.user.id });
  if (insErr) {
    // 23505 = unique violation (email already invited, here or elsewhere)
    if (insErr.code === "23505") {
      return NextResponse.json({ error: "That email is already invited (here or to another workspace)." }, { status: 409 });
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // ── Notify the invitee (best-effort) ──────────────────────────────────
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name")
    .eq("id", me.tenant_id)
    .maybeSingle();
  const workspace = tenant?.name ?? "the workspace";

  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host  = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const loginUrl = host ? `${proto}://${host}/login` : (process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "");

  const emailRes = await sendEmail({
    to:      email,
    from:    FROM_EMAIL,
    subject: `You've been invited to ${workspace} on ResellerOS`,
    text:
`Hello,

You've been added to ${workspace} on ResellerOS as ${role}.

To join, sign in with Google using THIS email address (${email}):
${loginUrl}

That's it — signing in with this email drops you straight into ${workspace}. No password or separate account needed.

— ${workspace} (via ResellerOS)`,
  });

  return NextResponse.json({
    ok: true,
    emailStatus: emailRes.status,             // "sent" | "stubbed" | "failed"
    emailError:  emailRes.errorMessage,
  });
}
