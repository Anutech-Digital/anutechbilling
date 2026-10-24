/**
 * R-1301 (P1, launch safety): a first Google sign-in must never move an existing person's
 * profile to a new id.
 *
 * ─── THE HOLE ────────────────────────────────────────────────────────────────────────────
 * The GoTrue-era callback matched public.users by email on a first Google login and ran
 * `update users set id = <new auth uid>` without reading the error. 26 foreign keys point at
 * users(id) with no ON UPDATE CASCADE, so for anyone who had ever done anything (activity_log,
 * leads, quotes …) the update FAILED silently — and the person landed in the app signed in as
 * a login with no profile: no tenant, empty lists. For someone with no linked rows it
 * SUCCEEDED, which is worse in a quieter way: the profile silently changed owner by email
 * alone, verified or not.
 *
 * ─── THE RULE NOW ────────────────────────────────────────────────────────────────────────
 *   · users.id is never rewritten here. Identity linking belongs to the login layer
 *     (Auth.js: src/server/auth/accounts.ts#linkOAuthUser maps Google → the profile's id
 *     before a session exists). If the callback still meets a profile with this email under a
 *     DIFFERENT id, the login and the profile disagree: refuse, sign the fresh session out,
 *     write it to activity_log, and say so on /login. db/ops/22-r529-merge-duplicate-google-
 *     login.sql is the repair.
 *   · Nothing email-based (profile match, invite, domain) is read for an address the login
 *     layer has not confirmed.
 */

/** /login?error= values this callback can produce (the login page explains each). */
export const LINK_CONFLICT_ERROR = "account_link_conflict";
export const EMAIL_UNVERIFIED_ERROR = "email_unverified";
/** R-733: the invite for this address expired / was already used (texts: lib/auth/invite-accept.ts). */
export const INVITE_EXPIRED_ERROR = "invite_expired";
export const INVITE_USED_ERROR = "invite_used";

export const LINK_CONFLICT_MESSAGE =
  "This email already has an account, but this Google sign-in is not linked to it. Sign in with your email and password, or ask your workspace owner to contact support. Nothing in your account was changed.";
export const EMAIL_UNVERIFIED_MESSAGE =
  "Your email address is not verified with this sign-in, so we could not connect it to an account. Verify the address and try again.";

/**
 * Has the login layer confirmed this address? Only `email_confirmed_at` counts: it is set by
 * GoTrue / Auth.js when the provider proved the address. `user_metadata.email_verified` is NOT
 * trusted — a signed-in user can write their own user_metadata.
 */
export function isEmailVerified(u: { email?: string | null; email_confirmed_at?: string | null }): boolean {
  return Boolean(u.email && u.email.trim() && u.email_confirmed_at);
}

/** Which login layer handed the person to the callback. */
export type LoginLayer = "gotrue" | "authjs";

/**
 * The activity_log row for a refused link: who (the profile's id), when (created_at default),
 * old id (profile) → new id (the login), provider. No email in `changes`, no token, no secret.
 */
export function linkRefusedLogRow(a: {
  tenantId: string;
  profileId: string;
  newAuthId: string;
  provider: string;
  layer: LoginLayer;
}) {
  return {
    tenant_id:   a.tenantId,
    user_id:     a.profileId,
    action:      "auth.oauth_link_refused",
    entity:      "user",
    entity_id:   a.profileId,
    label:       "Google sign-in not linked to existing profile (id unchanged)",
    actor_label: "system: oauth callback",
    changes: {
      old_id:   a.profileId,
      new_id:   a.newAuthId,
      provider: a.provider,
      layer:    a.layer,
      outcome:  "refused_id_unchanged",
      card:     "R-1301",
    },
  };
}
