/**
 * R-2857 — "plan · seats" on the Renewals drawer header and cards, said ONCE.
 * Staging showed "Google Workspace Business Starter (1 seats) · 1 seats": an imported plan name
 * already carries the seat count, and the count was added again (and "1 seats").
 *
 *   the plan name carries a seat count ("… (1 seats)", "… 25 Seats pack")  → the plan, as it is
 *   otherwise                                                             → "<plan> · 1 seat" / "· 20 seats"
 *   no seats on the subscription                                          → the plan alone
 * The same rule as the table row's (row-cells.tsx, R-2854), so a row and its drawer never differ.
 * Display only: the plan name and the seats are not changed anywhere.
 */

/** "1 seat", "20 seats". */
export function seatCountWords(seats: number): string {
  return `${seats} ${seats === 1 ? "seat" : "seats"}`;
}

/** True when the plan name already carries a seat count ("(1 seats)", "5 Seats", "25 seat pack"). */
export function planNamesSeats(plan: string | null | undefined): boolean {
  return !!plan && /\b\d+\s*seats?\b/i.test(plan);
}

/** The seat part to print next to the plan; null = print nothing (no seats, or the plan already says it). */
export function seatsAfterPlan(plan: string | null | undefined, seats: number | null | undefined): string | null {
  if (seats == null) return null;
  return planNamesSeats(plan) ? null : seatCountWords(seats);
}

/** "<plan> · 20 seats" — or the plan alone when it already carries the count. */
export function planSeatsWords(plan: string | null | undefined, seats: number | null | undefined): string {
  return [plan?.trim() || null, seatsAfterPlan(plan, seats)].filter(Boolean).join(" · ");
}
