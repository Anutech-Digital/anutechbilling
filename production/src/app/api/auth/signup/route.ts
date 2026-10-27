/**
 * POST /api/auth/signup
 *
 * Server-side signup using the service role key so we can:
 * 1. Create the auth user — confirmed only when an invite token proves the mailbox; everyone
 *    else is unconfirmed and gets a verification link (R-048, 4 Oct 2026)
 * 2. Decide where that person BELONGS
 * 3. Create only what that decision calls for
 *
 * ─── WHY STEP 2 IS NEW, AND WHY IT IS NOT OPTIONAL ───────────────────────────
 * This route used to go straight from "auth user created" to "create a tenant",
 * unconditionally. It never looked at `team_invites` at all — so it was a second
 * door into the product with none of the guard the OAuth callback had, and an
 * invited teammate who happened to use the email form instead of the Google button
 * got a private company of their own with the same name as the real one.
 *
 * A company is now created only when nothing recognises the person. Three
 * outcomes, in strict order of how much a human already decided:
 *
 *   invite (someone chose them)     → join that tenant, no tenant created
 *   company domain (evidence only)  → no workspace; once the email is confirmed a
 *                                     join request goes to the owner (R-822), NOTHING granted
 *   nothing                         → create the tenant they asked for
 *
 * ─── THE DOMAIN CHECK OVERRIDES THE FORM ON PURPOSE ──────────────────────────
 * This form asks for a company name, so filling it in looks like an explicit "I am
 * a new business". It is not reliable evidence: the person who typed "Demo
 * Co" into it while his colleagues already had an Demo Co
 * workspace was not lying, he simply did not know. The domain knows. So a verified
 * domain match wins over the typed name, and the response says exactly why —
 * `pending_approval` is not a failure and must not be shown as one.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { turnstileRefusal } from "@/lib/security/turnstile-guard";
import { createAdminClient } from "@/lib/supabase/server";
import { GST_STATE_BY_CODE, initials } from "@/lib/utils";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { normalizeEmail, type InviteMatch } from "@/lib/auth/membership";
import { decideOnboarding } from "@/lib/auth/domain";
import { startEmailVerification } from "@/lib/auth/email-verification";
import { findVerifiedDomainTenant } from "@/lib/auth/tenant-match";
import { checkNewPassword } from "@/lib/auth/password-rules";
import { INVITE_EXPIRED_MESSAGE, inviteAcceptRefusal, isInviteExpired } from "@/lib/auth/invite-accept";
import { CHECK_EMAIL_RESPONSE, SIGNUP_FAILED_MESSAGE, SIGNUP_SERVER_FAILED_MESSAGE, isEmailTaken } from "./signup-response";
import { apiFailure } from "@/lib/errors/api-error";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      email: string;
      password: string;
      fullName: string;
      companyName: string;
      gstin?: string;
      /** Invite-email ke link se aaya raaz — iske bina invite se join NAHI hota. */
      inviteToken?: string;
    };

    /* R-020: a bot is refused here; a no-op until TURNSTILE_SECRET_KEY is set. */
    const botRefusal = await turnstileRefusal(request.headers, body);
    if (botRefusal) return botRefusal;

    const { password, fullName, companyName, gstin } = body;
    const email = normalizeEmail(body.email);

    if (!email || !password || !fullName || !companyName) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    /* R-736: the same password rules as reset / change password (lib/auth/password-rules.ts).
       Before this only GoTrue's own floor (6) applied, so "123456" made an owner account. */
    const passwordProblem = checkNewPassword(password);
    if (passwordProblem) {
      return NextResponse.json({ error: passwordProblem.message, field: "password" }, { status: 400 });
    }

    const admin = createAdminClient();

    // ── 1. Where does this person belong? Decided BEFORE anything is created,
    //       so a decision of "join" or "wait" never leaves a stray tenant behind.
    //
    // ⚠️ Password-raaste par invite EMAIL SE NAHI pehchana jata — token se.
    // 1 Sep 2026 ke audit ka #1 khatra yahi tha: is route ne kabhi mailbox
    // saabit nahi kiya (email_confirm: true), to sirf email-match par join
    // dena har invited address ko ek khula darwaza banata tha — koi bhi
    // billing@company.com ka andaza laga kar, apna password rakh kar, us
    // tenant me (owner tak ke role me) ghus sakta tha. Token sirf invite-
    // email me jata hai, isliye uska hona hi mailbox ka saboot hai. Google
    // wala raasta (callback) pehle jaisa — wahan saboot Google deta hai.
    const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
    const { data: inviteRow } = inviteToken
      ? await admin
          .from("team_invites")
          .select("tenant_id, role, expires_at")
          .eq("token", inviteToken)
          .eq("email", email)
          .is("accepted_at", null)
          .maybeSingle()
      : { data: null };

    /* R-733: an expired link is refused BEFORE any account exists — the person is told to ask
       for a new invite, not left with a login that belongs nowhere. */
    if (inviteRow && isInviteExpired(inviteRow.expires_at)) {
      return NextResponse.json({ error: INVITE_EXPIRED_MESSAGE }, { status: 410 });
    }

    // Invite pending hai par token nahi/galat? Account banate hi NAHI —
    // warna wahi takeover, ya (ignore karne par) invited insaan ki apni
    // alag company ban jati (13 stranded-users wala purana bug). §24:
    // kya hua + kyun + aage kya, teeno.
    if (!inviteRow) {
      const { data: pendingByEmail } = await admin
        .from("team_invites")
        .select("id, expires_at")
        .eq("email", email)
        .is("accepted_at", null)
        .maybeSingle();
      if (pendingByEmail && isInviteExpired(pendingByEmail.expires_at)) {
        return NextResponse.json({ error: INVITE_EXPIRED_MESSAGE }, { status: 410 });
      }
      if (pendingByEmail) {
        return NextResponse.json(
          {
            error:
              "This email has a workspace invite. Two ways to join: " +
              "(1) open the link in the invite email, or (2) sign in with Google using this same email. " +
              "A new password account cannot skip the invite.",
          },
          { status: 409 },
        );
      }
    }

    const domainMatch = await findVerifiedDomainTenant(email);
    const decision = decideOnboarding({
      invite: (inviteRow as InviteMatch | null) ?? null,
      domainMatch,
    });

    // ── 2. Create auth user ────────────────────────────────────────────────
    /* R-048 (4 Oct 2026): only an INVITE proves the mailbox (the token came by email to this
       address), so only an invited signup is confirmed here. Everyone else is created
       unconfirmed and must follow the link sent below before GoTrue lets them sign in —
       otherwise anyone could open an account, or a join request to someone's company, with
       an address they do not own. */
    const confirmedByInvite = decision.mode === "join";
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: confirmedByInvite,
      user_metadata: {
        full_name: fullName,
        company_name: companyName,
        gstin: gstin ?? null,
      },
    });

    if (authError) {
      /* R-736: never echo the provider's text. "already registered" turned this form into a
         lookup of who has an account; that case now gets exactly the answer a new company
         signup gets (signup-response.ts). The real owner of the address can sign in or use
         Forgot password; nobody else learns anything. */
      if (isEmailTaken(authError)) {
        return NextResponse.json(CHECK_EMAIL_RESPONSE);
      }
      console.warn("[signup] createUser failed:", authError.code ?? authError.status ?? "", authError.message);
      return NextResponse.json({ error: SIGNUP_FAILED_MESSAGE }, { status: 400 });
    }

    const userId = authData.user.id;

    // ── 3a. Invited → join the inviting tenant. No tenant is created. ──────
    /* R-733: claim the invite + create the membership in ONE transaction (accept_team_invite,
       CLAUDE.md §17b). It used to be "insert users row, then mark the invite used" — two
       requests on one link both joined, and a crash between them left the link reusable. */
    if (decision.mode === "join") {
      const { error: joinErr } = await admin.rpc("accept_team_invite", {
        p_email:     email,
        p_user_id:   userId,
        p_full_name: fullName,
        p_initials:  initials(fullName),
        p_token:     inviteToken,
      });
      if (joinErr) {
        await admin.auth.admin.deleteUser(userId);
        console.warn("[signup] accept_team_invite refused:", joinErr.message);
        const refusal = inviteAcceptRefusal(joinErr.message);
        return NextResponse.json({ error: refusal.error }, { status: refusal.status });
      }

      return NextResponse.json({ success: true, status: "joined" });
    }

    // ── 3b. Domain match → NO workspace; the join request waits for the email. ──
    /* R-822 (10 Oct 2026): the company already uses ResellerOS, so no second workspace.
       But this address is NOT verified yet (R-048) — a typed-in email proves nothing, and
       opening the join request now would let anyone ping a company's owner in someone
       else's name. So the request is opened by /api/auth/verify-email once the link in the
       confirmation email is followed (routeVerifiedSignupToCompany). The workspace name is
       not echoed back either: before verification it would turn this form into a lookup
       of which companies use ResellerOS. */
    if (decision.mode === "request_approval") {
      const verify = await startEmailVerification(admin, { userId, email, name: fullName, origin: originOf(request) });
      return NextResponse.json({
        success: true,
        status: "pending_approval",
        needsVerification: true,
        verificationSent: verify.sent,
      });
    }

    // ── 3c. Nobody recognised them → this really is a new company. ─────────
    const tenantId = crypto.randomUUID();

    /* R-1927 (OB-6): a checksum-valid GSTIN proves the company's state (first 2 digits),
       so the setup wizard opens with State already filled. No GSTIN / a wrong one → no state
       (R-250: never a guessed state). */
    const cleanGstin = gstin?.trim().toUpperCase() || null;
    const gstinStateCode = stateCodeFromGstin(cleanGstin);

    const { error: tenantError } = await admin.from("tenants").insert({
      id: tenantId,
      name: companyName,
      gstin: cleanGstin,
      email,
      ...(gstinStateCode ? { state: GST_STATE_BY_CODE[gstinStateCode], state_code: gstinStateCode } : {}),
    });

    if (tenantError) {
      // Rollback: delete the auth user we just created
      await admin.auth.admin.deleteUser(userId);
      /* R-1137 pattern: the database text is logged here, never sent to the browser. */
      return NextResponse.json(apiFailure("signup_company_failed", SIGNUP_SERVER_FAILED_MESSAGE, tenantError, "signup"), { status: 500 });
    }

    const { error: userError } = await admin.from("users").insert({
      id: userId,
      tenant_id: tenantId,
      email,
      full_name: fullName,
      initials: initials(fullName),
      role: "owner",
      color: "amber",
    });

    if (userError) {
      // Rollback: delete tenant + auth user
      await admin.from("tenants").delete().eq("id", tenantId);
      await admin.auth.admin.deleteUser(userId);
      return NextResponse.json(apiFailure("signup_user_failed", SIGNUP_SERVER_FAILED_MESSAGE, userError, "signup"), { status: 500 });
    }

    // Claim the company's own domain for this new tenant, unverified. It costs
    // nothing, it is what a future owner would have to type by hand anyway, and
    // an unverified claim routes nobody (0242) — so it cannot misfire.
    await claimDomainQuietly(admin, tenantId, email);

    const verify = await startEmailVerification(admin, { userId, email, name: fullName, origin: originOf(request) });
    /* R-736: no ids in the body — an existing address gets CHECK_EMAIL_RESPONSE, and the two
       must not be told apart. (The page never used userId/tenantId.) verificationSent stays
       honest (§24): when the mail really failed the page must offer Resend, and that failure
       is not something a visitor can cause on purpose. */
    return NextResponse.json({ ...CHECK_EMAIL_RESPONSE, verificationSent: verify.sent });
  } catch (e) {
    return NextResponse.json(apiFailure("signup_failed", SIGNUP_SERVER_FAILED_MESSAGE, e, "signup"), { status: 500 });
  }
}

/** Public host for links in outbound alerts — never `new URL(request.url).origin`,
 *  which is the container's internal address on Cloud Run. */
function originOf(request: NextRequest): string {
  // R-723: allowlisted request host or NEXT_PUBLIC_APP_URL — never a caller-chosen host.
  return trustedOrigin(request.headers);
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** Best-effort domain claim. A failure here must never fail a signup that has
 *  already succeeded — the tenant exists and the user can work. */
async function claimDomainQuietly(admin: AdminClient, tenantId: string, email: string) {
  const { emailDomain, isPublicEmailDomain } = await import("@/lib/auth/domain");
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return;
  const { error } = await admin.from("tenant_domains").insert({ tenant_id: tenantId, domain });
  if (error && error.code !== "23505") {
    console.warn("[signup] domain claim skipped:", error.message);
  }
}
