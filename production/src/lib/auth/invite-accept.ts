/**
 * R-733 (19 Oct 2026) — team invites expire (7 days) and are accepted once, atomically.
 *
 * The accept itself is the SQL function `accept_team_invite` (migration
 * 20261019010621_r733_team_invite_expiry): one conditional UPDATE claims the invite and the
 * users row is inserted in the same transaction, so two requests on one link cannot both join
 * and a failed insert leaves the invite open. This file is the app half: the expiry check
 * done BEFORE an account is created, and turning the function's refusals into answers with a
 * next step (CLAUDE.md §24).
 */

/** How long an invite link works. Mirrors the column default in the migration. */
export const INVITE_TTL_DAYS = 7;

export const INVITE_EXPIRED_MESSAGE =
  "This invite link has expired — invite links work for 7 days. " +
  "Ask the workspace owner to invite you again from Team → Invite member; the new email has a fresh link.";

export const INVITE_USED_MESSAGE =
  "This invite link has already been used. If it was you, sign in with that email address. " +
  "Otherwise ask the workspace owner to invite you again from Team → Invite member.";

/** A fresh expiry for a new or renewed invite. */
export function inviteExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Missing expiry (row read before the migration ran) counts as NOT expired — the DB decides. */
export function isInviteExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

/** accept_team_invite refused → what to tell the person. */
export function inviteAcceptRefusal(message: string | null | undefined): { status: number; error: string } {
  const m = message ?? "";
  if (/expired/i.test(m)) return { status: 410, error: INVITE_EXPIRED_MESSAGE };
  if (/already been used/i.test(m)) return { status: 409, error: INVITE_USED_MESSAGE };
  if (/not valid/i.test(m)) {
    return {
      status: 404,
      error: "This invite link does not match this email address. Open the link from the invite email exactly as it came, " +
        "or ask the workspace owner to invite you again from Team → Invite member.",
    };
  }
  return {
    status: 500,
    error: "We could not add you to the workspace just now — nothing was saved. Please try again in a minute; " +
      "if it keeps failing, ask the workspace owner to invite you again.",
  };
}
