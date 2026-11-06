/**
 * R-2469 (4 Nov 2026) — what Team → Invite says when an address is held elsewhere.
 *
 * `release_stale_team_invite(email)` (migration 20261104090100) runs before the invite is written:
 *   member_elsewhere — the address belongs to a member of another REAL company: refused, never moved;
 *   released         — another workspace's expired / used / blank-workspace invite was cleared;
 *   in_use           — another workspace holds a live invite;
 *   none             — nothing elsewhere.
 * Every refusal carries a next step that works today (CLAUDE.md §24) and, per R-721, never names
 * the other company or says how big it is.
 */

export type StaleInviteOutcome = "member_elsewhere" | "released" | "in_use" | "none";

export function parseStaleInviteOutcome(v: unknown): StaleInviteOutcome | null {
  return v === "member_elsewhere" || v === "released" || v === "in_use" || v === "none" ? v : null;
}

/** The person is a member of another real company — they stay there. */
export function memberElsewhereMessage(email: string): string {
  return (
    `${email} is already a member of another company on ResellerOS, so they can't join yours with this address. ` +
    "Next step: ask them — they know which company it is — to have that company's owner contact " +
    "ResellerOS support to release them, then invite them again. Or invite them with a different email address."
  );
}

/** Another workspace holds a live (not expired) invite for this address. */
export function inviteInUseMessage(email: string): string {
  return (
    `${email} has an open invite from another company on ResellerOS. ` +
    "Next step: invites expire after 7 days — invite them again after that and it will go through. " +
    "If it can't wait, ask them to have that company remove the invite (they know which one), or use a different email address."
  );
}

/** R-2469: the address check (an existence probe if unlimited) is capped per owner. */
export const INVITE_CHECK_RATE = { limit: 30, windowMs: 60 * 60_000 } as const;

/** R-534 temp-password path: the address already has a login that is not in this workspace. */
export function loginElsewhereMessage(email: string): string {
  return (
    `${email} already has a login, so no temporary password can be set. ` +
    "Invite them without a temporary password — the invite then tells you the next step. " +
    "If they ended up in an empty workspace of their own, they sign in once and you use Claim a colleague on this page."
  );
}

/* ── R-2477 (memberships slice 3): inviting a login that already works in another company ── */

/** What invite_existing_login answers. R-2477 re-review (migration 20261106034600): "plain" for both
    "no login" and "works in no company" (it no longer says whether an address has a login); the
    older "no_company" / "not_found" are still understood while a database runs the earlier body. */
export type ExistingLoginInvite = "invited" | "already_member" | "plain" | "no_company" | "not_found";

export function parseExistingLoginInvite(v: unknown): ExistingLoginInvite | null {
  return v === "invited" || v === "already_member" || v === "plain" || v === "no_company" || v === "not_found" ? v : null;
}

/** The login is already a member of the inviting company (maybe working in another one right now). */
export function alreadyMemberMessage(email: string): string {
  return (
    `${email} is already a member of your company, so there is nothing to invite. ` +
    "Next step: change their role on the Team page if needed. If they can't see your company, ask them to pick it from the company switcher in the top bar."
  );
}

/** Shown to the owner after inviting a login that already works in another company. */
export function existingLoginInvitedNote(email: string): string {
  return (
    `${email} already uses ResellerOS with another company — they keep it. ` +
    "Next step: they see your invite at the top of their app and accept it themselves; then they appear in your Team list. You can withdraw it from Pending invites."
  );
}

/** The email such a person gets: no signup link (they have a login), and what happens next. */
export function existingLoginInviteEmail(p: { workspace: string; roleName: string; email: string; loginUrl: string }): string {
  return `Hello,

${p.workspace} has invited you to join them on ResellerOS as ${p.roleName}.

You already have a ResellerOS login with this address (${p.email}) — you keep your current company. Sign in here, the way you always do:
${p.loginUrl}

At the top of the app you will see "Invite from ${p.workspace}" — press Accept to join. Nothing changes until you accept. After that you can switch between your companies from the top bar.

— ${p.workspace} (via ResellerOS)`;
}
