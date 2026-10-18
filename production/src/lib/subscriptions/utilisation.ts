// Not wired yet — R-1608 (built, kept for later)
/**
 * Seat utilisation and the churn risk it implies.
 *
 * ─── `used` IS ZERO ON EVERY ROW IN THIS DATABASE ───────────────────────────
 * Every insert path writes `used: 0` — add-subscription, both importers — and
 * NOTHING ever updates it. Verified against production: 1 subscription, 10 seats,
 * 0 used.
 *
 * So the brief's rule taken literally — "flag subs with <60% seat usage as High Churn
 * Risk" — flags 100% of subscriptions. A red badge on everything is a badge people
 * stop seeing within a day, and it would be asserting that customers are not using
 * licences they are almost certainly using.
 *
 * lib/subscriptions/exceptions.ts already reached this conclusion and gates its own
 * idle-seat warning on `used > 0` for the same reason. This module follows the same
 * rule and makes the distinction explicit rather than implicit: `used = 0` with no
 * recorded sync is UNKNOWN, not 0%.
 *
 * ─── WHICH MEANS THE USEFUL OUTPUT IS THE GAP ITSELF ────────────────────────
 * Until something populates `used`, the honest churn-risk report is "we cannot see
 * utilisation on N subscriptions", with what would fix it. That is a real finding —
 * a reseller who believes they are watching utilisation and is not, is worse off than
 * one who knows they are blind.
 *
 * The seat count comes from Google Admin (assigned users), which is a DIFFERENT
 * export from the reseller console's "Purchased licenses" that feeds
 * `vendor_seats` — those are what we PAY for. Conflating them is the mistake
 * lib/vendor/leakage.ts exists to prevent.
 */

/** Below this, a subscription is over-bought enough to be a renewal risk. */
export const LOW_UTILISATION_PCT = 60;

export type UtilisationLevel = "unknown" | "healthy" | "low" | "idle";

export interface UtilisationInput {
  seats: number;
  /** Assigned users. 0 with no sync means unknown — see the header. */
  used: number | null | undefined;
  /** When assigned-user data was last confirmed. Null = never. */
  usedSyncedAt?: string | null;
}

export interface UtilisationResult {
  level: UtilisationLevel;
  /** Percent of seats assigned. Null when unknown. */
  pct: number | null;
  idleSeats: number | null;
  /** True when this should be treated as a churn risk at renewal. */
  churnRisk: boolean;
  message: string;
}

/**
 * Assess one subscription.
 *
 * `used = 0` counts as real ONLY when a sync has recorded it. Without that, zero is
 * the default the column was created with and says nothing about the customer.
 */
export function assessUtilisation(input: UtilisationInput): UtilisationResult {
  const seats = Math.max(0, Math.trunc(input.seats ?? 0));
  const used = input.used == null ? null : Math.max(0, Math.trunc(input.used));
  const everSynced = Boolean(input.usedSyncedAt);

  if (seats <= 0) {
    return { level: "unknown", pct: null, idleSeats: null, churnRisk: false, message: "No seats on this subscription." };
  }

  /* The rule that stops every subscription turning red. */
  if (used == null || (used === 0 && !everSynced)) {
    return {
      level: "unknown",
      pct: null,
      idleSeats: null,
      churnRisk: false,
      message: "Assigned users have never been synced, so we cannot tell how much of this is being used.",
    };
  }

  const pct = Math.round((used / seats) * 100);
  const idleSeats = Math.max(0, seats - used);

  if (used === 0) {
    return {
      level: "idle",
      pct: 0,
      idleSeats,
      churnRisk: true,
      message: `All ${seats} seats are paid for and nobody is on them. This will not survive renewal.`,
    };
  }
  if (pct < LOW_UTILISATION_PCT) {
    return {
      level: "low",
      pct,
      idleSeats,
      churnRisk: true,
      message: `Only ${used} of ${seats} seats are in use (${pct}%). Expect a cut at renewal — talk to them before they ask.`,
    };
  }
  return {
    level: "healthy",
    pct,
    idleSeats,
    churnRisk: false,
    message: `${used} of ${seats} seats in use (${pct}%).`,
  };
}

/**
 * Roll up.
 *
 * `unknownCount` is reported first because with no sync source it is the ONLY true
 * number here, and a dashboard showing "0 at risk" over a fleet nobody can see would
 * be the most misleading thing on the page.
 */
export function utilisationTotals(rows: readonly UtilisationResult[]): {
  atRiskCount: number;
  idleCount: number;
  unknownCount: number;
  knownCount: number;
  /** Seats paid for and unassigned, across rows where that is actually known. */
  idleSeats: number;
} {
  let atRiskCount = 0, idleCount = 0, unknownCount = 0, knownCount = 0, idleSeats = 0;
  for (const r of rows) {
    if (r.level === "unknown") { unknownCount++; continue; }
    knownCount++;
    if (r.churnRisk) atRiskCount++;
    if (r.level === "idle") idleCount++;
    idleSeats += r.idleSeats ?? 0;
  }
  return { atRiskCount, idleCount, unknownCount, knownCount, idleSeats };
}

/** Badge for a subscription row. */
export function utilisationBadge(r: UtilisationResult): { label: string; kind: "danger" | "warning" | "success" | "muted" } {
  switch (r.level) {
    case "idle":    return { label: "Nobody using it", kind: "danger" };
    case "low":     return { label: `${r.pct}% used`, kind: "warning" };
    case "healthy": return { label: `${r.pct}% used`, kind: "success" };
    default:        return { label: "Usage not tracked", kind: "muted" };
  }
}
