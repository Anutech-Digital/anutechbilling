/**
 * OAuth callback handler — runs after Google sign-in redirects back.
 *
 *  1. Exchanges the auth code for a session (sets the cookie).
 *  2. Looks up a public.users row for the new auth.uid.
 *  3. If MISSING (first-time Google sign-in), decides where they BELONG:
 *       invite matches their exact address → join that tenant
 *       verified domain matches           → join_requests, owner alerted, no access
 *       neither                           → /welcome, and they choose
 *  4. If EXISTING user, redirects to ?next= (defaults to /dashboard).
 *
 * Before this fix, Google OAuth would create the auth user but skip the
 * public.users + tenant rows that email/password signup creates via
 * /api/auth/signup — leaving the user logged-in but stranded in a broken
 * state with no tenant_id (every RLS-scoped query failed).
 *
 * ─── AND THEN THE FIX FOR THAT CAUSED THIS ONE (corrected 14 Aug 2026) ───────
 * Auto-provisioning a tenant did cure the stranding, and introduced a quieter
 * failure in its place: a person who should have joined an existing workspace got
 * a private one instead, named after their own email domain — so it looked exactly
 * like the workspace they expected. Four of the five tenants in this database were
 * created on this line, one of them holding two days of real customer work and a
 * ₹21,240 payment.
 *
 * The lesson is narrow and worth keeping: "create something so the user is not
 * stuck" is only safe when the thing created is the thing they wanted. When that
 * is unknowable — and at first sign-in it genuinely is — the correct move is to
 * ask, not to guess well. Step 3 no longer creates anything it was not told to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appPathOr } from "@/lib/safe-path";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { authProvider } from "@/server/auth/authjs";
import { currentAuthUser } from "@/server/auth/compat";
import { initials } from "@/lib/utils";
import { normalizeEmail, type InviteMatch } from "@/lib/auth/membership";
import { decideOnboarding } from "@/lib/auth/domain";
import {
  findVerifiedDomainTenant,
  openJoinRequest,
  notifyOwnerOfJoinRequest,
} from "@/lib/auth/tenant-match";

/** Derive a sensible default tenant name from the user's email domain. */
function tenantNameFromEmail(email: string | undefined): string {
  if (!email || !email.includes("@")) return "My Company";
  const domain = email.split("@")[1] ?? "";
  // Strip common TLDs, hyphens → spaces, capitalise the leading word.
  const base = domain
    .replace(/\.(in|com|co|org|net|io|app|dev|tech|biz|info|ai)$/i, "")
    .replace(/\.(in|com|co|org|net|io)\.[a-z]+$/i, "") // .co.in, .com.au etc.
    .split(".")[0]
    .replace(/-/g, " ")
    .trim();
  if (!base) return "My Company";
  return base
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  /* Prefixing origin below already stops an off-site redirect, so this is defence in
     depth rather than a fix — but the same string is validated the same way everywhere,
     which is cheaper to keep true than three subtly different checks. */
  const next = appPathOr(searchParams.get("next"));

  // Public host for redirects — NEVER new URL(request.url).origin. On Cloud Run
  // the container binds 0.0.0.0:3000, so that origin is the internal address and
  // sends users to dead https://0.0.0.0:3000 links after Google sign-in.
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  const origin  = fwdHost
    ? `${proto}://${fwdHost}`
    : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(request.url).origin);

  /* A password-recovery link in the token_hash form (5 Oct 2026). Supabase's own SSR
     pattern for email links: `/callback?token_hash=…&type=recovery`. The code flow above
     needs a PKCE verifier from the browser that asked; a recovery link made by an admin (or
     an email template using {{ .TokenHash }}) has none, so it used to end on "no_code".
     Recovery only — the one-time token signs the person in and the next stop is always
     /reset-password, where they choose the password. */
  /* AUTH_PROVIDER=authjs: Auth.js has already finished the Google round-trip and set the session
     before redirecting here, so there is no code to exchange — read the signed-in user and run
     the same first-sign-in decisions below. */
  let authjsUser: Awaited<ReturnType<typeof currentAuthUser>> = null;
  if (authProvider() === "authjs") {
    authjsUser = await currentAuthUser();
    if (!authjsUser) return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const tokenHash = searchParams.get("token_hash");
  if (!authjsUser && !code && tokenHash && searchParams.get("type") === "recovery") {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    if (error) return NextResponse.redirect(`${origin}/login?error=link_expired`);
    return NextResponse.redirect(`${origin}/reset-password`);
  }

  if (!authjsUser && !code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  let authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
  if (authjsUser) {
    authUser = authjsUser.user;
  } else {
    const supabase = createClient();
    const { data: exchData, error: exchError } =
      await supabase.auth.exchangeCodeForSession(code!);
    if (exchError || !exchData?.user) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    authUser = exchData.user;
  }

  // ─── Check if public.users row already exists ────────────────────────────
  // Use the admin client for this read — the new OAuth user has no
  // public.users row yet so they can't read their own row via RLS until
  // we create it. Admin bypasses RLS.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("id", authUser.id)
    .maybeSingle();

  if (existing) {
    // Returning user — straight to the requested destination.
    return NextResponse.redirect(`${origin}${next}`);
  }

  /* Apprentice Academy (R-149): an apprentice has no users row ON PURPOSE (that is what
     hides company data from them). Without this they would fall through to the
     new-workspace / join-request flow below. A password reset keeps its own destination. */
  const { data: apprentice } = await admin
    .from("academy_apprentices")
    .select("id")
    .eq("user_id", authUser.id)
    .maybeSingle();
  if (apprentice) {
    return NextResponse.redirect(`${origin}${next === "/reset-password" ? next : "/learn"}`);
  }

  // ─── First-time sign-in with Google OAuth ──────────────────────────────────────────────────
  const email = authUser.email ?? "";
  const fullName =
    (authUser.user_metadata?.full_name as string | undefined) ||
    (authUser.user_metadata?.name as string | undefined) ||
    authUser.email?.split("@")[0] ||
    "New user";

  // Check if a pre-existing user record exists with this email address in public.users
  //
  // `.eq`, not `.ilike`. Both `_` and `%` are ILIKE wildcards AND legal characters
  // in an email local part, so an address containing one matched patterns rather
  // than itself — in the one branch that then REBINDS that row to a different auth
  // uid. Emails are stored lower-cased, and the input is normalised, so an exact
  // comparison is both correct and the only one that cannot match a stranger.
  const { data: preExistingUser } = await admin
    .from("users")
    .select("id, tenant_id, role")
    .eq("email", normalizeEmail(email))
    .maybeSingle();

  if (preExistingUser) {
    // Re-link pre-existing user profile to this new Auth UID
    await admin
      .from("users")
      .update({
        id: authUser.id,
        full_name: fullName,
        initials: initials(fullName),
      })
      .eq("id", preExistingUser.id);

    return NextResponse.redirect(`${origin}${next}`);
  }

  // Was this email invited to an existing tenant by its owner? If so, JOIN that
  // tenant. Exact match — see the note on `.eq` above; the unique index on
  // lower(email) guarantees at most one row, and invites are stored lower-cased.
  const { data: inviteRow } = await admin
    .from("team_invites")
    .select("tenant_id, role")
    .eq("email", normalizeEmail(email))
    .is("accepted_at", null)
    .maybeSingle();

  // No invite? Before assuming this is a new company, look at the domain — the
  // signal that was always available and never read. See domain.ts for why a
  // match can never do more than ask.
  const domainMatch = await findVerifiedDomainTenant(email);

  const decision = decideOnboarding({
    invite: (inviteRow as InviteMatch | null) ?? null,
    domainMatch,
  });

  if (decision.mode === "join") {
    const { error: joinErr } = await admin.from("users").insert({
      id:        authUser.id,
      tenant_id: decision.tenantId,
      email,
      full_name: fullName,
      initials:  initials(fullName),
      role:      decision.role,
      color:     "indigo",
    });
    if (joinErr) {
      console.error("[oauth/callback] invite-join failed:", joinErr);
      return NextResponse.redirect(`${origin}/login?error=provision_failed`);
    }
    // One-time: mark the invite accepted so it can't be reused.
    await admin.from("team_invites").update({ accepted_at: new Date().toISOString() })
      .ilike("email", normalizeEmail(email)).is("accepted_at", null);
    // Joined an existing, set-up tenant — go straight to the app.
    return NextResponse.redirect(`${origin}${next}`);
  }

  // ─── Domain matched a verified tenant → park them, alert the owner ────────
  // No users row, no tenant, no access. Just a request and a person who knows
  // what is happening.
  if (decision.mode === "request_approval") {
    const parked = await openJoinRequest({
      tenantId:   decision.tenantId,
      email:      normalizeEmail(email),
      fullName,
      authUserId: authUser.id,
      matchedBy:  "domain",
    });

    if (parked.ok) {
      await notifyOwnerOfJoinRequest({
        tenantId:   decision.tenantId,
        tenantName: decision.tenantName,
        email:      normalizeEmail(email),
        fullName,
        appUrl:     origin,
      });
      return NextResponse.redirect(
        `${origin}/welcome?pending=${encodeURIComponent(decision.tenantName)}`,
      );
    }

    // Could not record the request. Fall through to the fork rather than
    // stranding them — /welcome can still create a workspace or ask again.
    console.error("[oauth/callback] could not open join request; falling through to /welcome");
  }

  // ─── Nobody recognised them → ASK. Do not manufacture a company. ─────────
  //
  // This is the line that used to create a tenant, and creating one here is what
  // produced four of the five tenants in this database. The suggested name is
  // still derived from the domain, but it is now a prefill on a screen someone
  // has to look at, not a decision made on their behalf while they wait for a
  // redirect. The person is authenticated and has no users row; /welcome is built
  // for exactly that state and is reachable in it (middleware.ts).
  const suggested = tenantNameFromEmail(authUser.email ?? undefined);
  return NextResponse.redirect(
    `${origin}/welcome?suggested=${encodeURIComponent(suggested)}&next=${encodeURIComponent(next)}`,
  );
}
