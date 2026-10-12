/**
 * Who can clear a pending quote, and whose queue it belongs in.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The quote page said "Waiting for the owner to approve. It is in their approvals queue."
 * Three things were wrong with that sentence, and only the first is cosmetic:
 *
 *   1. It says "the owner" as though there is one. ANUTECH has three.
 *   2. It named nobody, so the person who raised the quote could not tell whether it was
 *      waiting on them. Pardeep raised this one, and cannot approve his own quote —
 *      canApprove refuses that outright — so "the owner" meant someone else entirely.
 *   3. There WAS no approvals queue. No screen listed pending approvals and the quotes
 *      list had no approval filter, so the other owner had no way of knowing. The only
 *      working mechanism was the sentence's afterthought: "nudge them".
 *
 * ─── ONE PREDICATE, THREE SURFACES ──────────────────────────────────────────
 * The sidebar badge, the list filter and this module must agree exactly.
 * useNavBadges already carries that rule in writing — a badge reading "Leads 14" over a
 * page showing nothing was a real dogfood bug — so `awaitsMyApproval` is the single test,
 * used by all three.
 *
 * ─── THE STORED TIER IS THE ONE THAT COUNTS ─────────────────────────────────
 * This reads `approval_tier` off the quote rather than recomputing it from the current
 * numbers. The stored tier is what was actually asked for; a recomputation can differ
 * because the quote has been edited since, and that difference is what `isStale` in
 * approval.ts is for. Deciding "may this person clear it" from a tier nobody requested
 * would let an edit quietly change who is in charge of a sign-off.
 */
import { MANAGER_APPROVERS, OWNER_APPROVERS } from "./approval";
import type { UserRole } from "@/lib/auth/roles";

/** Just enough of a quote. Deliberately not the whole row, so callers and tests are free. */
export interface PendingQuoteFacts {
  approval_status: string | null;
  approval_tier: string | null;
  approval_requested_by: string | null;
}

export interface Viewer {
  id: string;
  role: string | null | undefined;
}

export interface ApproverPerson {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

/** Which roles may clear a given tier. Empty for anything else, including null. */
export function approversForTier(tier: string | null | undefined): readonly UserRole[] {
  if (tier === "owner") return OWNER_APPROVERS;
  if (tier === "manager") return MANAGER_APPROVERS;
  return [];
}

/**
 * Is this quote waiting on THIS person?
 *
 * The self-approval exclusion is the part that matters: without it, the person who
 * requested sign-off sees their own quote in their own queue and the count is a lie that
 * never goes down.
 */
export function awaitsMyApproval(quote: PendingQuoteFacts, viewer: Viewer): boolean {
  if (quote.approval_status !== "pending") return false;
  if (!quote.approval_requested_by) return false;
  if (quote.approval_requested_by === viewer.id) return false;
  return approversForTier(quote.approval_tier).includes((viewer.role ?? "") as UserRole);
}

/**
 * Every tier that means "somebody must sign this off".
 *
 * Typed as the literals rather than `string[]` on purpose: `quotes.approval_tier` accepts
 * only these two (plus null), so this list stays assignable to a `.in()` filter and the
 * compiler catches a third tier being invented in one place and not the other. It already
 * did — the first draft of this was `readonly string[]` and the badge query would not
 * compile against the generated column type.
 */
export const APPROVAL_TIERS = ["manager", "owner"] as const;
export type ApprovableTier = (typeof APPROVAL_TIERS)[number];

/**
 * Which tiers this person can clear — the same rule as `awaitsMyApproval`, turned inside
 * out so a database COUNT can ask it.
 *
 * The sidebar badge cannot run a predicate over rows it has not fetched; it runs
 * `.in("approval_tier", …)`. Two hand-written copies of "an owner may clear a manager-tier
 * quote" is exactly the drift that made a badge read "Leads 14" over an empty page, so
 * this derives from the same constants, and a test cross-checks it against
 * `awaitsMyApproval` for every role × tier pair rather than trusting the reading.
 */
export function tiersApprovableBy(role: string | null | undefined): ApprovableTier[] {
  return APPROVAL_TIERS.filter((tier) =>
    approversForTier(tier).includes((role ?? "") as UserRole),
  );
}

/**
 * The people who could actually clear this quote, for naming them on the banner.
 *
 * The requester is excluded here too, for the same reason: listing them as an approver of
 * their own quote sends somebody to ask themselves.
 */
export function eligibleApprovers(
  users: readonly ApproverPerson[],
  quote: PendingQuoteFacts,
): ApproverPerson[] {
  const roles = approversForTier(quote.approval_tier);
  if (roles.length === 0) return [];
  return users.filter(
    (u) =>
      u.id !== quote.approval_requested_by &&
      roles.includes((u.role ?? "") as UserRole),
  );
}

/**
 * "Deepak Sharma or Omega Co can clear this."
 *
 * Returns null when NOBODY can — which is a real state worth surfacing rather than
 * printing an empty list: a one-owner tenant where the owner raised the quote has nobody
 * left to approve it, and the honest answer is that the rule cannot be satisfied, not
 * that the queue is empty.
 */
export function approverSentence(people: readonly ApproverPerson[]): string | null {
  const names = people.map((p) => p.full_name?.trim() || p.email || "a colleague");
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
