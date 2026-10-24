/**
 * R-1684: the rule for "Correct details" changing a subscription's COMMERCIAL terms (seats, plan,
 * price) — what the dialog shows and asks for. The database enforces the same rule
 * (correct_subscription_terms, migration 20261024030954): reason required, seat cut / plan change
 * owner or manager only, plan only from the catalog.
 *
 * Staging 19 Oct (T-12): an annual commitment went 15 → 10 seats mid-term with no warning, MRR
 * stayed ₹16,200 (so MRR and next term's bill disagreed) and the plan was free text.
 *
 * ─── THE RULE (decided on the card) ─────────────────────────────────────────
 *   1. Any change to seats, plan or price needs a reason (kept on the change history).
 *   2. Cutting seats or changing the plan: owner or manager. Price only / adding seats: also
 *      accountant or billing (R-885's money group).
 *   3. Seats cut inside an annual (12+ month) term that is running today: allowed, but the money
 *      is said plainly — the term was committed and invoiced; nothing is refunded by itself. A
 *      refund is a credit note on the term's invoice (CGST s.34), which is the next step shown.
 *   4. MRR follows the seats: changing seats re-prices MRR per seat (current MRR ÷ current seats)
 *      unless the operator typed a price of their own — so MRR and the next-term schedule agree.
 *   5. The plan is a catalog row (items), never typed text.
 */
import { currentTermStart } from "@/lib/billing/subscription-schedule";

export type StaffRole = string | null | undefined;

const SEAT_CUT_ROLES = new Set(["owner", "manager"]);
const PRICE_ROLES = new Set(["owner", "manager", "accountant", "billing"]);

/** The reason must be at least this long — the same floor as pausing (R-1681). */
export const MIN_CORRECTION_REASON = 3;

export interface CorrectionFacts {
  role: StaffRole;
  seatsNow: number;
  seatsNext: number;
  mrrNow: number;
  mrrNext: number;
  itemNow: string | null;
  itemNext: string | null;
  termMonths: number | null;
  startDate: string | null;
  renewalDate: string | null;
  today: string;
}

export interface CorrectionVerdict {
  /** seats, plan or price differ from the record. */
  changed: boolean;
  seatCut: boolean;
  planChanged: boolean;
  /** Seats cut inside a running annual commitment — the money warning applies. */
  midTermCommitmentCut: boolean;
  /** Why this login may not save it, or null. */
  roleBlock: string | null;
}

export function correctionVerdict(f: CorrectionFacts): CorrectionVerdict {
  const seatCut = f.seatsNext < f.seatsNow;
  const planChanged = (f.itemNext ?? null) !== (f.itemNow ?? null) && f.itemNext != null;
  const changed = seatCut || planChanged || f.seatsNext !== f.seatsNow || f.mrrNext !== f.mrrNow;

  const termStart = currentTermStart({ term_months: f.termMonths ?? 12, start_date: f.startDate, renewal_date: f.renewalDate });
  const annual = (f.termMonths ?? 12) >= 12;
  const running = termStart != null && f.renewalDate != null && termStart <= f.today && f.today <= f.renewalDate.slice(0, 10);
  const midTermCommitmentCut = seatCut && annual && running;

  const role = f.role ?? "";
  let roleBlock: string | null = null;
  if (changed) {
    if ((seatCut || planChanged) && !SEAT_CUT_ROLES.has(role)) {
      roleBlock = "Only an owner or manager can cut seats or change the plan. Ask one of them.";
    } else if (!PRICE_ROLES.has(role)) {
      roleBlock = "Only an owner, manager, accountant or billing user can correct the seats or price.";
    }
  }
  return { changed, seatCut, planChanged, midTermCommitmentCut, roleBlock };
}

/**
 * The MRR for a new seat count at the subscription's own per-seat price. Whole rupees. Zero seats
 * → 0; no seats on record → the MRR is left as it is (no per-seat price to scale by).
 */
export function mrrForSeats(mrrNow: number, seatsNow: number, seatsNext: number): number {
  if (seatsNext <= 0) return 0;
  if (seatsNow <= 0) return mrrNow;
  return Math.round((mrrNow * seatsNext) / seatsNow);
}

/** The money warning for a mid-term seat cut on an annual commitment. */
export function seatCutWarning(args: { seatsNow: number; seatsNext: number; renewalDate: string | null; fmt: (iso: string) => string }): string {
  const cut = args.seatsNow - args.seatsNext;
  const until = args.renewalDate ? ` until ${args.fmt(args.renewalDate)}` : "";
  return `This is an annual commitment${until}. Cutting ${cut} ${cut === 1 ? "seat" : "seats"} now refunds nothing — `
    + `this term's invoice stays as it is and the customer still owes it. To give money back for the cut seats, `
    + `issue a credit note on that invoice. From the next renewal the bill is for ${args.seatsNext} ${args.seatsNext === 1 ? "seat" : "seats"}.`;
}
