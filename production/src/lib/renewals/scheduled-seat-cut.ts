/**
 * R-2583 — a seat cut scheduled "At end of term" (R-2252) is billed at renewal.
 *
 * R-2252 lets the owner schedule a seat cut for the renewal date: one row in
 * subscription_seat_reductions (timing end_of_term, status scheduled, effective_date = the
 * subscription's renewal_date, seats_before → seats_after). Nothing read it, so the renewal quote
 * still billed the old seat count and the customer was over-billed.
 *
 * createOrGetRenewalQuote now asks `renewalSeatCut` which seat count the NEW quote is for:
 *   - a scheduled row dated exactly this term's renewal date, not in the past (R-2584: a stale row
 *     is never applied retroactively), made on the seats the subscription has now → seats_after;
 *   - the seats changed since it was scheduled (Add seats) → NOT applied: the quote keeps the
 *     current seats and its notes say so, so the owner lowers it by hand (we cannot tell whether
 *     the cut was meant as "N fewer" or "down to M");
 *   - anything else → no cut.
 * The per-seat rate is the full subscription's (worked out at the current seats); only qty, the
 * subtotal (rate × qty) and the cost change. Paying the quote is what changes the subscription:
 * record_payment sets seats = the line's qty and mrr = subtotal ÷ months (rule N1).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ScheduledSeatCutRow {
  id: string;
  timing: string;
  status: string;
  seats_before: number;
  seats_after: number;
  effective_date: string;
}

export type RenewalSeatCut =
  | { kind: "none" }
  | { kind: "apply"; row: ScheduledSeatCutRow; seats: number; note: string }
  | { kind: "seats_changed"; row: ScheduledSeatCutRow; note: string };

const day = (d: string | null | undefined) => (d ?? "").slice(0, 10);

/**
 * Which scheduled cut (if any) the renewal quote for the subscription's CURRENT renewal date must
 * bill. Pure. Matched on that date, not on today: a row from an earlier term never matches (paying a
 * renewal moves renewal_date on — R-2584's stale rows), while a renewal still in its grace days
 * (date passed, not yet paid) does keep its cut.
 */
export function renewalSeatCut(
  rows: readonly ScheduledSeatCutRow[],
  sub: { seats: number; renewalDate: string },
): RenewalSeatCut {
  const renewal = day(sub.renewalDate);
  const live = rows.filter(
    (r) => r.status === "scheduled" && r.timing === "end_of_term" && renewal !== "" && day(r.effective_date) === renewal,
  );
  if (live.length === 0) return { kind: "none" };
  const row = live[0];
  if (live.length > 1) {
    return {
      kind: "seats_changed",
      row,
      note: `${live.length} seat cuts are scheduled for this renewal, so none was applied and this quote keeps ${sub.seats} seats. ` +
        "Check Manage seats, remove the extra cut, then lower the seats on this quote if a cut still stands.",
    };
  }
  if (row.seats_after >= sub.seats) {
    return {
      kind: "seats_changed",
      row,
      note: `A seat cut ${row.seats_before} → ${row.seats_after} was scheduled for this renewal, but the subscription already has ` +
        `${sub.seats} seats, so the cut no longer applies and this quote is for ${sub.seats}.`,
    };
  }
  if (row.seats_before !== sub.seats || row.seats_after < 1) {
    return {
      kind: "seats_changed",
      row,
      note: `A seat cut ${row.seats_before} → ${row.seats_after} was scheduled for this renewal, but the subscription now has ` +
        `${sub.seats} seats, so this quote keeps ${sub.seats}. Lower the seats on this quote if the cut still stands.`,
    };
  }
  return {
    kind: "apply",
    row,
    seats: row.seats_after,
    note: `Seats ${row.seats_before} → ${row.seats_after}: the seat cut scheduled for the end of the term.`,
  };
}

/**
 * The subscription's scheduled cuts. `null` = the read failed — the caller makes NO quote then
 * (a quote at the old seats would over-bill; the cron tries again tomorrow).
 */
export async function loadScheduledSeatCuts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  tenantId: string,
  subscriptionId: string,
): Promise<ScheduledSeatCutRow[] | null> {
  const res = (await supabase
    .from("subscription_seat_reductions")
    .select("id, timing, status, seats_before, seats_after, effective_date")
    .eq("tenant_id", tenantId)
    .eq("subscription_id", subscriptionId)
    .eq("status", "scheduled")) as { data?: unknown; error?: { message: string } | null };
  if (res?.error) {
    console.error(`[renewals] subscription ${subscriptionId}: scheduled seat cuts not read — ${res.error.message}`);
    return null;
  }
  return Array.isArray(res?.data) ? (res.data as ScheduledSeatCutRow[]) : [];
}
