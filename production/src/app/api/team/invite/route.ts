/**
 * POST /api/team/invite  { email, role, tempPassword? }
 *
 * Owner-only. Pre-authorises `email` to join the caller's tenant (a
 * team_invites row — the invitee joins on first Google sign-in with that
 * email) AND emails the invitee an instruction to sign in.
 *
 * The email is best-effort: if Resend isn't configured (RESEND_API_KEY unset)
 * it stubs, and the invite is still created — the pre-authorisation is what
 * actually grants access, the email is just the nudge. The response reports
 * the email status so the UI can tell the operator whether it went out.
 *
 * R-534 (10 Oct 2026): optional `tempPassword`. With it, the login is created NOW (email +
 * that password, already in this workspace with the invited role) instead of waiting for a
 * Google sign-in, and the member must choose their own password at the first sign-in
 * (app_metadata.must_change_password — same flag and rules as R-391, lib/auth/temp-password.ts):
 *   - never for an owner invite, never for an email that already has a login;
 *   - rate-limited with the same per-owner bucket as "Set temporary password";
 *   - audit row (who, whom, when — never the password) BEFORE the login is created;
 *   - the password comes back ONCE in this response (no-store) and is not put in the email.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { rateLimitShared } from "@/lib/security/rate-limit";
import { TEMP_PASSWORD_RATE, checkTypedTempPassword } from "@/lib/auth/temp-password";
import { MUST_CHANGE_PASSWORD_KEY } from "@/lib/auth/must-change-password";
import { initials } from "@/lib/utils";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

const schema = z.object({
  email: z.string().email().max(200),
  role:  z.enum(["owner", "manager", "sales", "sales_senior", "billing", "accountant", "delivery", "support"]),
  /** R-534: optional temporary password — creates the login now, must change at first sign-in. */
  tempPassword: z.string().max(128).optional(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

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
  const tempPassword = parsed.data.tempPassword?.length ? parsed.data.tempPassword : null;

  /* R-534: every check on the temporary password runs BEFORE the invite is written, so a
     refused password never leaves a half-done invite behind. */
  if (tempPassword !== null) {
    if (role === "owner") {
      return NextResponse.json(
        { error: "An owner sets their own password. Invite without a temporary password, or pick another role." },
        { status: 422 },
      );
    }
    const problem = checkTypedTempPassword(tempPassword);
    if (problem) return NextResponse.json({ error: problem.message }, { status: 422 });

    const rl = await rateLimitShared(`team-temp-pw:${authData.user.id}`, TEMP_PASSWORD_RATE);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many temporary passwords in the last hour. Try again later, or invite without one." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    const { data: hasLogin } = await createAdminClientFor(authData.user.id)
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (hasLogin) {
      return NextResponse.json(
        { error: `${email} already has a login. Invite without a temporary password, or use Set temporary password on their row.` },
        { status: 409 },
      );
    }
  }

  // ── Create the invite (RLS: team_invites is owner-scoped) ─────────────
  let roleChangedFrom: string | null = null;
  /* Token email ke signup-link me jata hai — password-raaste se join ka
     ek-matra saboot (migration 20260901090000). */
  let inviteToken: string | null = null;

  const { data: insData, error: insErr } = await supabase
    .from("team_invites")
    .insert({ tenant_id: me.tenant_id, email, role, invited_by: authData.user.id })
    .select("token")
    .single();
  if (insData) inviteToken = insData.token;

  if (insErr) {
    // 23505 = unique violation: this email already has an invite somewhere.
    if (insErr.code !== "23505") {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    /* ─── AN EXISTING INVITE IS UPDATED, NOT REFUSED ────────────────────────
       This used to answer "That email is already invited" and stop, which is a dead
       end with no next step (CLAUDE.md §24) and, worse, one with no way round: there
       is no UI anywhere to change an invite's role, so an owner who invited somebody
       as Billing and then wanted them as Sales Senior simply could not do it.

       Found live on 18 Aug 2026 — ananya@anutech.in had been invited on 10 Aug as
       `billing`, and re-inviting as `sales_senior` changed nothing while the screen
       gave no clue why.

       RLS already permits this: team_invites_owner_manage is an ALL policy scoped to
       the caller's own tenant, so the update below cannot touch anyone else's row. */
    const { data: existing } = await supabase
      .from("team_invites")
      .select("role, tenant_id, token")
      .eq("email", email)
      .maybeSingle();

    if (!existing) {
      /* RLS hid it, which means it belongs to ANOTHER workspace. Refused, and
         deliberately without naming which one — that would leak who else is using the
         product to anyone who can guess an address. */
      return NextResponse.json(
        { error: "That email is already invited to a different workspace. They need to leave it, or use another address." },
        { status: 409 },
      );
    }

    /* Same role and no password to add → nothing to do. With a temporary password the
       re-invite is how an owner says "create their login now", so it goes on. */
    if (existing.role === role && tempPassword === null) {
      return NextResponse.json(
        { error: `${email} is already invited as ${role}. Nothing to change — they just need to sign in with Google using that address.` },
        { status: 409 },
      );
    }

    if (existing.role !== role) {
      const { error: updErr } = await supabase
        .from("team_invites")
        .update({ role, invited_by: authData.user.id })
        .eq("email", email)
        .eq("tenant_id", me.tenant_id);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      roleChangedFrom = existing.role;
    }
    inviteToken = existing.token;
  }

  // ── R-534: create the login now, with the temporary password ─────────
  let memberCreated = false;
  if (tempPassword !== null) {
    const made = await createLoginWithTempPassword(createAdminClientFor(authData.user.id), {
      callerId: authData.user.id,
      tenantId: me.tenant_id,
      email,
      role,
      password: tempPassword,
    });
    if (!made.ok) {
      return NextResponse.json(
        { error: `${made.error} The invite is saved — they can still join by signing in with Google.` },
        { status: made.status, headers: NO_STORE },
      );
    }
    memberCreated = true;
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
  const base  = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL?.trim()?.replace(/\/+$/, "") ?? "");
  const loginUrl  = `${base}/login`;
  /* Password-raasta: token wale link se hi khulta hai. Ye link hi mailbox ka
     saboot hai — bina iske signup 409 deta hai (audit 1 Sep 2026). */
  const signupUrl = inviteToken && !memberCreated ? `${base}/signup?invite=${inviteToken}` : null;

  const emailRes = await sendEmail({
    /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
          me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
    route: { tenantId: me.tenant_id },
    to:      email,
    from:    FROM_EMAIL,
    subject: `You've been invited to ${workspace} on ResellerOS`,
    /* R-534: the password itself is never in the email — the owner hands it over. */
    text: memberCreated
? `Hello,

You've been added to ${workspace} on ResellerOS as ${role}.

Sign in here with this email address (${email}) and the temporary password ${workspace} gives you:
${loginUrl}

You'll choose your own password straight after signing in.

— ${workspace} (via ResellerOS)`
: `Hello,

You've been added to ${workspace} on ResellerOS as ${role}.

Easiest way to join — sign in with Google using THIS email address (${email}):
${loginUrl}
${signupUrl ? `
Prefer a password instead? Use your personal invite link (it only works for ${email}):
${signupUrl}
` : ""}
— ${workspace} (via ResellerOS)`,
  });

  return NextResponse.json({
    ok: true,
    /* R-534: shown ONCE on the owner's screen with a Copy button. */
    ...(memberCreated ? { memberCreated: true, password: tempPassword, mustChange: true } : {}),
    /* Reported so the screen can say "role changed from billing to sales_senior" rather
       than "invited", which would read as a new person to anyone glancing at it. */
    roleChangedFrom,
    emailStatus: emailRes.status,             // "sent" | "stubbed" | "failed"
    emailError:  emailRes.errorMessage,
  }, { headers: NO_STORE });
}

/**
 * R-534: auth user (password + must_change flag) and the users row in the inviting tenant,
 * audited first. Works on GoTrue and on R-161's Auth.js store — both honour app_metadata on
 * createUser. The password is never logged or written to a table.
 */
async function createLoginWithTempPassword(admin: ReturnType<typeof createAdminClientFor>, input: {
  callerId: string; tenantId: string; email: string; role: z.infer<typeof schema>["role"]; password: string;
}): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const { data: audit, error: auditErr } = await admin
    .from("activity_log")
    .insert({
      tenant_id: input.tenantId,
      user_id:   input.callerId,
      action:    "temp_password_set",
      entity:    "user",
      label:     `Invited ${input.email} with a temporary password (must change at next sign-in)`,
    })
    .select("id")
    .single();
  if (auditErr || !audit) {
    return { ok: false, status: 500, error: "Could not write the audit record, so no login was created." };
  }
  const markFailed = (why: string) =>
    admin.from("activity_log")
      .update({ action: "temp_password_failed", label: `Login for ${input.email} NOT created — ${why}`.slice(0, 300) })
      .eq("id", audit.id);

  const fullName = nameFromEmail(input.email);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    /* The owner vouches for this address inside their own workspace; the member proves it
       by signing in with the password the owner gave them directly. */
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: {
      [MUST_CHANGE_PASSWORD_KEY]: true,
      temp_password_set_at: new Date().toISOString(),
      temp_password_set_by: input.callerId,
    },
  });
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? "no user returned";
    await markFailed(msg);
    if (/already|registered|exists/i.test(msg)) {
      return { ok: false, status: 409, error: `${input.email} already has a login, so no temporary password was set.` };
    }
    return { ok: false, status: 500, error: `Could not create the login: ${msg}.` };
  }
  const userId = created.user.id;

  const { error: rowErr } = await admin.from("users").insert({
    id:        userId,
    tenant_id: input.tenantId,
    email:     input.email,
    full_name: fullName,
    initials:  initials(fullName),
    role:      input.role,
    color:     "indigo",
  });
  if (rowErr) {
    /* Same rollback as /api/auth/signup: this request created the auth user a moment ago and
       nobody has signed in with it. Leaving it would strand a login with no workspace. */
    await admin.auth.admin.deleteUser(userId);
    await markFailed(rowErr.message);
    return { ok: false, status: 500, error: "Could not add them to the workspace." };
  }

  await admin.from("activity_log").update({ entity_id: userId }).eq("id", audit.id);
  await admin.from("team_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("email", input.email)
    .eq("tenant_id", input.tenantId)
    .is("accepted_at", null);

  return { ok: true, userId };
}

/** "ravi.kumar@x.com" → "Ravi Kumar". The member can change it later. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
