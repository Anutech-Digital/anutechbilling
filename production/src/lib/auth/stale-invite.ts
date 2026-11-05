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
