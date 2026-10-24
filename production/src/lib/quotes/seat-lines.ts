/**
 * R-389 (F7) — how many SEATS a quote is for.
 *
 * `quotes.seats` was saved as the sum of EVERY line's qty, so Q-FBB9-27-0013 (25 Google
 * Workspace seats + Standard Support ×1 + Data migration ×1) showed "Seats 27" on the
 * Activate-on-credit dialog. A seat is a licence: a recurring line (it has a commitment)
 * that is not a support plan. One-time services (no commitment — what record_payment
 * treats as one-off and never turns into a subscription) and support lines are not seats.
 *
 * R-1673 (4): nor is a domain registration — staging's T-3R lead (25 Workspace + 5 M365 +
 * 1 domain) showed "31 seats", and the domain line printed "Per seat per year".
 */
import { isSupportSkuId } from "@/lib/support/tiers";
import { isDomainPurchaseLine } from "@/lib/provisioning/products";

export interface SeatLineLike {
  qty?: number | null;
  commitment?: string | null;
  item_id?: string | null;
  name?: string | null;
  /** Bulk Workspace line (one subscription per domain) — seats, never a registration. */
  bulk?: boolean | null;
  domain?: string | null;
  /** Domain lines from the cart carry their registrant (lib/provisioning/products). */
  registrant?: unknown;
  /** Domain lines only: registration term in years (R-031). */
  years?: number | null;
}

/**
 * A domain REGISTRATION line (not a product that merely names its domain): the provisioning
 * rule (`isDomainPurchaseLine` — registrant, or the line IS the domain), or a name that says
 * domain / registration. The builder's "Register for N yrs" picker uses this same rule.
 */
export function isDomainRegistrationLine(l: SeatLineLike): boolean {
  if (l.bulk) return false;
  return isDomainPurchaseLine(l) || /\b(domain|registration)\b/i.test(l.name ?? "");
}

export function isSeatLine(l: SeatLineLike): boolean {
  if (!l.commitment) return false;
  if (isSupportSkuId(l.item_id)) return false;
  if (isDomainRegistrationLine(l)) return false;
  return !/\bsupport\b/i.test(l.name ?? "");
}

/** Σ qty over licence lines; null when the quote has none (nothing to call "seats"). */
export function quoteSeatCount(lines: readonly SeatLineLike[] | null | undefined): number | null {
  const seats = (lines ?? []).filter(isSeatLine).reduce((s, l) => s + Math.max(0, Number(l.qty) || 0), 0);
  return seats > 0 ? seats : null;
}
