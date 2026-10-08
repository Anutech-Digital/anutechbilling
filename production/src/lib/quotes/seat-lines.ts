/**
 * R-389 (F7) — how many SEATS a quote is for.
 *
 * `quotes.seats` was saved as the sum of EVERY line's qty, so Q-FBB9-27-0013 (25 Google
 * Workspace seats + Standard Support ×1 + Data migration ×1) showed "Seats 27" on the
 * Activate-on-credit dialog. A seat is a licence: a recurring line (it has a commitment)
 * that is not a support plan. One-time services (no commitment — what record_payment
 * treats as one-off and never turns into a subscription) and support lines are not seats.
 */
import { isSupportSkuId } from "@/lib/support/tiers";

export interface SeatLineLike {
  qty?: number | null;
  commitment?: string | null;
  item_id?: string | null;
  name?: string | null;
}

export function isSeatLine(l: SeatLineLike): boolean {
  if (!l.commitment) return false;
  if (isSupportSkuId(l.item_id)) return false;
  return !/\bsupport\b/i.test(l.name ?? "");
}

/** Σ qty over licence lines; null when the quote has none (nothing to call "seats"). */
export function quoteSeatCount(lines: readonly SeatLineLike[] | null | undefined): number | null {
  const seats = (lines ?? []).filter(isSeatLine).reduce((s, l) => s + Math.max(0, Number(l.qty) || 0), 0);
  return seats > 0 ? seats : null;
}
