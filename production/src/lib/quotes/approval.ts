/**
 * Discount and margin approval — who has to say yes before this quote goes out.
 *
 * ─── THE MATRIX ─────────────────────────────────────────────────────────────
 *   Discount ≤ 10%          → nobody, send it
 *   Discount 11–20%         → a manager
 *   Discount > 20%          → the owner
 *   Margin   < 12%          → the owner
 *
 * The last two are not in the brief in that form and both are decisions, so they
 * are stated here rather than buried:
 *
 * • The brief defines 11–20% and stops. A matrix where a 15% discount needs a
 *   manager and a 40% discount needs nobody is not a matrix, so anything past the
 *   top band escalates rather than falling through. Silence in a rule table is the
 *   one place a default must be the STRICTEST option, not the loosest.
 *
 * • "Owner/Finance" maps to the owner alone. This tenant has `billing` and
 *   `accountant` roles, but they are bookkeeping roles — they raise invoices and
 *   read the P&L. Letting them clear a thin-margin deal would hand pricing
 *   authority to whoever does the invoicing. If a real finance approver ever
 *   exists, it is one line in OWNER_APPROVERS.
 *
 * ─── BOTH TESTS RUN; THE STRICTER ONE WINS ──────────────────────────────────
 * A quote at 15% discount AND 8% margin needs the OWNER, not a manager. Taking
 * the first rule that matched would let a rep pick the cheaper approver by
 * arranging the discount, which is the whole game an approval matrix exists to
 * stop.
 *
 * ─── NOBODY APPROVES THEIR OWN QUOTE ────────────────────────────────────────
 * Not even an owner. This is not in the brief either, and it is the single hole
 * that makes every other rule decorative: a manager who can approve their own 20%
 * discount has no approval step at all, they have a checkbox. See `canApprove`.
 *
 * ─── AN APPROVAL IS FOR SPECIFIC NUMBERS, NOT FOR A QUOTE ───────────────────
 * Approving at 15% and then editing to 30% must not stay approved. `isStale`
 * compares what was approved against what the quote says now, and any move in the
 * customer's favour voids it. See `evaluateApproval`.
 *
 * Percentages are basis points throughout — 12% is 1200. Rounding a percentage to
 * an integer and comparing it to a threshold is how 10.4% becomes "10%, auto-
 * approved".
 */
import type { UserRole } from "@/lib/auth/roles";

export type ApprovalTier = "none" | "manager" | "owner";
export type ApprovalStatus = "not_required" | "pending" | "approved" | "rejected";

/** Discount at or below this needs nobody. 10.00%. */
export const AUTO_APPROVE_DISCOUNT_BPS = 1000;
/** Above this discount, a manager is not enough. 20.00%. */
export const MANAGER_MAX_DISCOUNT_BPS = 2000;
/** Below this gross margin, the owner decides. 12.00%. */
export const OWNER_MARGIN_FLOOR_BPS = 1200;

/** Who can clear a manager-tier quote. */
export const MANAGER_APPROVERS: readonly UserRole[] = ["owner", "manager"];
/** Who can clear an owner-tier quote. See the header on why "Finance" is not here. */
export const OWNER_APPROVERS: readonly UserRole[] = ["owner"];

export interface QuoteEconomics {
  /** ₹ the customer pays, ex-GST, after every discount. */
  subtotal: number;
  /** ₹ list value of the same lines — what they would pay at catalogue price. */
  listTotal: number;
  /** ₹ we pay vendors for those lines. */
  totalCost: number;
  /** True when any line's cost is unknown, so margin cannot be judged. */
  costUnknown?: boolean;
}

export interface ApprovalRequirement {
  tier: ApprovalTier;
  /** Basis points. Null when there is no list price to discount from. */
  discountBps: number | null;
  /** Basis points. Null when cost is unknown or there is no revenue. */
  marginBps: number | null;
  /** Every reason this quote needs sign-off, worst first. Empty when tier is "none". */
  reasons: string[];
  /** Roles that may clear it. Empty when tier is "none". */
  approvers: readonly UserRole[];
}

/** Discount in basis points: how far below list the customer is actually paying. */
export function discountBps(e: QuoteEconomics): number | null {
  if (e.listTotal <= 0) return null;
  const off = e.listTotal - e.subtotal;
  /* A quote priced ABOVE list is a 0% discount, not a negative one. Negative
     discounts would read as a premium and could clear a threshold from the wrong
     side. */
  if (off <= 0) return 0;
  return Math.round((off / e.listTotal) * 10_000);
}

/** Gross margin in basis points. Null when it cannot be known. */
export function marginBps(e: QuoteEconomics): number | null {
  if (e.costUnknown) return null;
  if (e.subtotal <= 0) return null;
  return Math.round(((e.subtotal - e.totalCost) / e.subtotal) * 10_000);
}

const fmtPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/**
 * What sign-off does this quote need?
 *
 * Cost being unknown is treated as a reason for OWNER approval, not as a pass.
 * A quote whose margin nobody can compute is exactly the quote that should not
 * leave the building unread — and the alternative, skipping the margin test when
 * cost is missing, means the cheapest way past the matrix is an incomplete
 * catalogue.
 */
export function requiredApproval(e: QuoteEconomics): ApprovalRequirement {
  const dBps = discountBps(e);
  const mBps = marginBps(e);
  const reasons: string[] = [];

  /* Tracked as a rank rather than as the tier string, so "take the strictest" is one
     `Math.max` instead of a comparison chain that has to be right in every branch. */
  const RANK: Record<ApprovalTier, number> = { none: 0, manager: 1, owner: 2 };
  const TIER_BY_RANK: ApprovalTier[] = ["none", "manager", "owner"];
  let rank = 0;
  const raise = (to: ApprovalTier) => { rank = Math.max(rank, RANK[to]); };

  if (dBps !== null && dBps > MANAGER_MAX_DISCOUNT_BPS) {
    reasons.push(`Discount is ${fmtPct(dBps)} — above the ${fmtPct(MANAGER_MAX_DISCOUNT_BPS)} a manager can clear.`);
    raise("owner");
  } else if (dBps !== null && dBps > AUTO_APPROVE_DISCOUNT_BPS) {
    reasons.push(`Discount is ${fmtPct(dBps)} — over the ${fmtPct(AUTO_APPROVE_DISCOUNT_BPS)} that goes out automatically.`);
    raise("manager");
  }

  if (e.costUnknown) {
    reasons.push("At least one line has no vendor cost, so the margin on this quote is unknown.");
    raise("owner");
  } else if (mBps !== null && mBps < OWNER_MARGIN_FLOOR_BPS) {
    reasons.push(`Gross margin is ${fmtPct(mBps)} — below the ${fmtPct(OWNER_MARGIN_FLOOR_BPS)} floor.`);
    raise("owner");
  }

  const tier = TIER_BY_RANK[rank];
  return {
    tier,
    discountBps: dBps,
    marginBps: mBps,
    reasons,
    approvers: tier === "owner" ? OWNER_APPROVERS : tier === "manager" ? MANAGER_APPROVERS : [],
  };
}

export interface ApprovalRecord {
  status: ApprovalStatus;
  tier: ApprovalTier | null;
  /** Who requested it — the person whose quote it is. */
  requestedBy: string | null;
  approvedBy: string | null;
  /** The numbers that were actually signed off. */
  approvedDiscountBps: number | null;
  approvedMarginBps: number | null;
  rejectionReason: string | null;
}

/**
 * Has the quote moved since it was approved, in a direction that needs a fresh look?
 *
 * Only moves in the CUSTOMER's favour void an approval. A rep who raises the price
 * or improves the margin after approval has done the thing the approver wanted; making
 * them queue again would teach everyone to stop improving quotes after sign-off.
 */
export function isStale(record: ApprovalRecord, now: ApprovalRequirement): boolean {
  if (record.status !== "approved") return false;

  const wasD = record.approvedDiscountBps;
  const nowD = now.discountBps;
  if (wasD !== null && nowD !== null && nowD > wasD) return true;

  const wasM = record.approvedMarginBps;
  const nowM = now.marginBps;
  if (wasM !== null && nowM !== null && nowM < wasM) return true;

  /* Margin was known at approval and is not any more — the quote now contains
     something the approver could not have seen. */
  if (wasM !== null && nowM === null) return true;

  return false;
}

export type SendGate =
  | { allowed: true }
  | { allowed: false; reason: string; nextStep: string; tier: ApprovalTier };

/**
 * May this quote be sent right now?
 *
 * §24 — every refusal names what happened, why, and the next step. "Needs approval"
 * on its own leaves a rep staring at a disabled button.
 *
 * `approvers` names the people who could actually clear a pending quote, and has three
 * meaningful states, because "we do not know yet" and "nobody can" are different answers
 * and only one of them is a problem:
 *   • `undefined` — the caller has not loaded the team, so say nothing about who.
 *   • `null`      — the team IS loaded and nobody is eligible. Usually the only owner is
 *                   the person who asked, and they cannot approve their own quote. That is
 *                   a dead end worth naming, not an empty list to print.
 *   • a string    — "Deepak Sharma or Omega Co", from approverSentence().
 * Build it with eligibleApprovers() + approverSentence() in ./awaiting-approval, so the
 * banner and the approvals queue can never name different people.
 */
export function canSend(
  record: ApprovalRecord,
  now: ApprovalRequirement,
  approvers?: string | null,
): SendGate {
  if (now.tier === "none") return { allowed: true };

  const who = now.tier === "owner" ? "the owner" : "a manager";

  if (record.status === "approved" && !isStale(record, now)) return { allowed: true };

  if (record.status === "approved") {
    return {
      allowed: false,
      tier: now.tier,
      reason: "This quote was approved, then changed in the customer's favour.",
      nextStep: `Send it back to ${who} — the approval covered the earlier numbers, not these.`,
    };
  }

  if (record.status === "rejected") {
    return {
      allowed: false,
      tier: now.tier,
      reason: record.rejectionReason
        ? `Rejected: ${record.rejectionReason}`
        : "This quote was rejected.",
      nextStep: "Change the pricing and ask again, or talk to the person who rejected it.",
    };
  }

  if (record.status === "pending") {
    return {
      allowed: false,
      tier: now.tier,
      reason: approvers
        ? `Waiting for ${approvers} to approve.`
        : `Waiting for ${who} to approve.`,
      /* "It is in their approvals queue" used to be a claim with nothing behind it —
         there was no queue, so the only working half of this sentence was "nudge them".
         The queue exists now (Quotes → Awaiting my approval, and the sidebar count), so
         the sentence is true, and when the team is loaded it names the actual people
         instead of "the owner", of which this workspace has three. */
      nextStep: approvers === null
        ? "Nobody else in this workspace can approve it — you cannot approve your own quote. Add another owner, or ask an owner to raise it."
        : "It is in their approvals queue on the Quotes page. Nudge them if it is urgent.",
    };
  }

  return {
    allowed: false,
    tier: now.tier,
    reason: now.reasons[0] ?? `This quote needs ${who} to approve it.`,
    nextStep: `Request approval — it goes to ${who}.`,
  };
}

/**
 * May this person clear this quote?
 *
 * The self-approval check comes FIRST and applies to every role including owner.
 * A rep who can approve their own quote has a checkbox, not an approval step.
 */
export function canApprove(
  viewer: { id: string; role: string | null | undefined },
  record: ApprovalRecord,
  now: ApprovalRequirement,
): { allowed: boolean; reason?: string } {
  if (now.tier === "none") return { allowed: false, reason: "This quote does not need approval." };
  if (record.requestedBy && record.requestedBy === viewer.id) {
    return { allowed: false, reason: "You cannot approve your own quote." };
  }
  if (!now.approvers.includes((viewer.role ?? "") as UserRole)) {
    return {
      allowed: false,
      reason: now.tier === "owner"
        ? "Only the owner can clear this one."
        : "Only a manager or the owner can clear this one.",
    };
  }
  return { allowed: true };
}

/** Badge text and tone for a quote row or header. */
export function approvalBadge(record: ApprovalRecord, now: ApprovalRequirement): {
  label: string;
  kind: "success" | "warning" | "danger" | "muted";
  title: string;
} | null {
  if (now.tier === "none" && record.status === "not_required") return null;

  if (record.status === "rejected") {
    return { label: "Rejected", kind: "danger", title: record.rejectionReason ?? "This quote was rejected." };
  }
  if (record.status === "approved") {
    return isStale(record, now)
      ? { label: "Approval stale", kind: "warning", title: "Changed in the customer's favour since it was approved — it needs a fresh look." }
      : { label: "Approved", kind: "success", title: "Cleared to send." };
  }
  if (record.status === "pending") {
    return {
      label: now.tier === "owner" ? "Owner approval" : "Manager approval",
      kind: "warning",
      title: "Waiting for sign-off.",
    };
  }
  if (now.tier !== "none") {
    return {
      label: "Needs approval",
      kind: "warning",
      title: now.reasons.join(" "),
    };
  }
  return { label: "Auto-approved", kind: "muted", title: "Within the limits a rep can send without asking." };
}
