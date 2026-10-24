/**
 * R-1727 (owner journey audit, 21 Oct 2026): the company page read "MRR … 1 sub · 0/10
 * seats" and the owner asked "0 kya?". The 0 is `subscriptions.used` — users ASSIGNED in
 * the vendor's admin console — which nothing syncs today (lib/subscriptions/utilisation.ts:
 * every insert writes 0 and nothing updates it). So "0/10" claimed nobody uses the seats
 * when the truth is "we have never looked".
 *
 * Same rule and the same words as the subscription drawer's Seats fact
 * (lib/subscriptions/facts.ts → seatsLabel): only a `used` above zero is a measurement;
 * otherwise show the licensed (billed) count alone, which is true either way.
 */

export interface SeatCountInput {
  seats: number | null | undefined;
  used: number | null | undefined;
}

/** Seats for one subscription or a set of them, in words: "10 seats licensed" or
 *  "6 of 10 seats used". "" when there are no seats at all. "Used" appears only when
 *  EVERY subscription with seats has a real assigned count — mixing measured and
 *  unmeasured rows would understate use. */
export function seatsPhrase(subs: SeatCountInput[]): string {
  const withSeats = subs.filter((s) => (s.seats ?? 0) > 0);
  const licensed = withSeats.reduce((a, s) => a + (s.seats ?? 0), 0);
  if (licensed <= 0) return "";
  const allMeasured = withSeats.every((s) => (s.used ?? 0) > 0);
  if (!allMeasured) return `${licensed} seat${licensed === 1 ? "" : "s"} licensed`;
  const used = withSeats.reduce((a, s) => a + (s.used ?? 0), 0);
  return `${used} of ${licensed} seats used`;
}

/** Where a "Manage seats" link sends the operator: /subscriptions opens the Manage seats
 *  dialog for this subscription straight away (read by manageSeatsIdFromSearch). */
export function manageSeatsHref(subscriptionId: string): string {
  return `/subscriptions?seats=${encodeURIComponent(subscriptionId)}`;
}

/** The subscription id in `?seats=` ("" when absent). */
export function manageSeatsIdFromSearch(search: string): string {
  return new URLSearchParams(search).get("seats")?.trim() ?? "";
}
