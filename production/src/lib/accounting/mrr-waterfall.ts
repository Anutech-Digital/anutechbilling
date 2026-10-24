/**
 * MRR waterfall — Starting → New → Expansion → Contraction → Churn → Ending.
 *
 * ─── READ THIS BEFORE TRUSTING THE NUMBERS ───────────────────────────────────
 *
 * The textbook waterfall is a LEDGER: every time a subscription's MRR changes you
 * write a row saying what it went from, what it went to, and why. This database
 * does not have that ledger. `subscriptions` holds one current `mrr` per row and
 * nothing about its history — `activity_log` (0222) records THAT a subscription
 * changed, never what it changed from.
 *
 * So this module does the only honest thing available: it reconstructs what it
 * genuinely can, and refuses to invent the rest.
 *
 *   COMPUTABLE from created/cancelled dates alone:
 *     New   — subscriptions that started inside the window
 *     Churn — subscriptions that ended inside the window
 *
 *   NOT COMPUTABLE without a ledger:
 *     Expansion   — an existing customer paying more (upgrade, seats added)
 *     Contraction — an existing customer paying less (downgrade, seats removed)
 *
 * Reporting Expansion as ₹0 would read as "nobody upgraded this month". The truth
 * is "we did not record it". Those are completely different facts to run a
 * business on, so `expansion` and `contraction` are `null`, and the UI renders
 * them as `—`, not as zero.
 *
 * ─── THE RESIDUAL IS THE POINT ───────────────────────────────────────────────
 *
 * Because expansion and contraction are missing, the identity
 *
 *     Starting + New − Churn  =  Ending
 *
 * will NOT hold whenever anybody changed a plan or a seat count. Rather than hide
 * that, `unexplained` carries the gap: Ending − (Starting + New − Churn). It is
 * the net of the expansion and contraction we failed to record, and its SIZE tells
 * the owner how blind this report currently is. A large residual is not a bug in
 * the arithmetic — it is the missing ledger, showing itself.
 *
 * One more caveat that cannot be engineered away here: `startingMrr` is built from
 * subscriptions that existed at the window's start using their CURRENT mrr, since
 * no other value exists. If a subscription was upgraded mid-window, that increase
 * is silently absorbed into Starting instead of appearing as Expansion. That makes
 * the residual an UNDER-estimate of true movement. `basis` reports which mode
 * produced the figures so a caller never has to guess.
 *
 * When migration 0236 (mrr_movements) is applied and has accumulated history,
 * `fromLedger()` computes all five components exactly and the residual goes to
 * zero. Both paths are tested.
 */

import { rupee } from "@/lib/utils";

/** A subscription as this module needs it — deliberately narrow. */
export interface MrrSubscription {
  id: string;
  /** Current monthly recurring revenue, whole ₹. */
  mrr: number;
  /** When the subscription began. */
  startDate: string | null;
  /** When it ended, if it has. */
  endDate?: string | null;
  status: string;
}

/** One recorded MRR movement, once migration 0236 is live. */
export interface MrrMovement {
  subscriptionId: string;
  at: string;
  fromMrr: number;
  toMrr: number;
  reason: "new" | "expansion" | "contraction" | "churn" | "reactivation";
}

export type WaterfallBasis =
  /** Rebuilt from start/end dates. Expansion and contraction unknown. */
  | "reconstructed"
  /** Computed from the movements ledger. All components real. */
  | "ledger";

export interface MrrWaterfall {
  startingMrr: number;
  newMrr: number;
  /** `null` means NOT TRACKED — never render this as ₹0. */
  expansion: number | null;
  /** `null` means NOT TRACKED — never render this as ₹0. */
  contraction: number | null;
  churnedMrr: number;
  endingMrr: number;
  /**
   * Ending − (Starting + New − Churn ± tracked movements).
   * Zero on the ledger path. On the reconstructed path this is the unrecorded
   * expansion/contraction, and it is meant to be shown, not swallowed.
   */
  unexplained: number;
  basis: WaterfallBasis;
  /** Plain-language notes for the UI. Never a single string — two problems must
   *  both be visible (a lesson from channel-economics). */
  notes: string[];
}

/** Statuses that mean the subscription is no longer producing revenue. */
const DEAD = new Set(["cancelled", "canceled", "expired", "churned", "terminated"]);

function ms(d: string | null | undefined): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
}

function round(n: number): number {
  // Money stays integer ₹ across this app; a float creeping in would show up as
  // ₹4,499.999999 in a board report.
  return Math.round(n);
}

/**
 * Reconstruct the waterfall from subscription dates alone.
 *
 * @param subs   every subscription for the tenant, alive or dead
 * @param from   window start (inclusive)
 * @param to     window end (exclusive)
 */
export function reconstructWaterfall(
  subs: MrrSubscription[],
  from: string,
  to: string,
): MrrWaterfall {
  const t0 = ms(from);
  const t1 = ms(to);
  const notes: string[] = [];

  if (t0 === null || t1 === null || t1 <= t0) {
    return {
      startingMrr: 0, newMrr: 0, expansion: null, contraction: null,
      churnedMrr: 0, endingMrr: 0, unexplained: 0, basis: "reconstructed",
      notes: ["Invalid date range — no figures computed."],
    };
  }

  let startingMrr = 0;
  let newMrr = 0;
  let churnedMrr = 0;
  let endingMrr = 0;
  let undated = 0;

  for (const s of subs) {
    const mrr = Number.isFinite(s.mrr) ? s.mrr : 0;
    const started = ms(s.startDate);
    const ended = ms(s.endDate);
    const dead = DEAD.has(s.status.toLowerCase());

    if (started === null) {
      // No start date means this row cannot be placed in time at all. Counting it
      // in Ending but not Starting would manufacture fake New MRR.
      undated += 1;
      continue;
    }

    // Alive at the window's start?
    const aliveAtStart = started < t0 && (ended === null || ended >= t0);
    if (aliveAtStart) startingMrr += mrr;

    // Began inside the window?
    if (started >= t0 && started < t1) newMrr += mrr;

    // Ended inside the window?
    const churnedInWindow = ended !== null && ended >= t0 && ended < t1;
    if (churnedInWindow) churnedMrr += mrr;

    // Alive at the window's end?
    const aliveAtEnd =
      started < t1 && (ended === null || ended >= t1) && !(dead && ended === null);
    if (aliveAtEnd) endingMrr += mrr;
  }

  startingMrr = round(startingMrr);
  newMrr = round(newMrr);
  churnedMrr = round(churnedMrr);
  endingMrr = round(endingMrr);

  const unexplained = endingMrr - (startingMrr + newMrr - churnedMrr);

  notes.push(
    "Expansion and contraction are not tracked — this database keeps no MRR history, "
    + "so upgrades and downgrades cannot be separated out.",
  );
  if (unexplained !== 0) {
    notes.push(
      `${rupee(Math.abs(unexplained))} of movement is unexplained. `
      + "That is the net of upgrades and downgrades nobody recorded, and it is an "
      + "under-estimate — mid-window increases are absorbed into the starting balance.",
    );
  }
  if (undated > 0) {
    notes.push(
      `${undated} subscription${undated === 1 ? "" : "s"} ha${undated === 1 ? "s" : "ve"} `
      + "no start date and could not be placed in time. Excluded from every column.",
    );
  }

  return {
    startingMrr, newMrr,
    expansion: null, contraction: null,
    churnedMrr, endingMrr, unexplained,
    basis: "reconstructed", notes,
  };
}

/**
 * Compute the waterfall from a real movements ledger. All five components are
 * exact and the identity closes, so `unexplained` should be 0 — it is still
 * computed rather than hard-coded, because a non-zero value would mean the ledger
 * itself has drifted and that must be visible rather than assumed away.
 */
export function fromLedger(
  startingMrr: number,
  movements: MrrMovement[],
): MrrWaterfall {
  let newMrr = 0, expansion = 0, contraction = 0, churnedMrr = 0;

  for (const m of movements) {
    const delta = m.toMrr - m.fromMrr;
    switch (m.reason) {
      case "new":
      case "reactivation":
        newMrr += delta;
        break;
      case "expansion":
        expansion += delta;
        break;
      case "contraction":
        // Stored as a negative delta; reported as a positive magnitude because
        // the waterfall SUBTRACTS it. Two negatives here would add revenue.
        contraction += Math.abs(delta);
        break;
      case "churn":
        churnedMrr += Math.abs(delta);
        break;
    }
  }

  const start = round(startingMrr);
  newMrr = round(newMrr);
  expansion = round(expansion);
  contraction = round(contraction);
  churnedMrr = round(churnedMrr);

  const endingMrr = start + newMrr + expansion - contraction - churnedMrr;

  return {
    startingMrr: start, newMrr, expansion, contraction, churnedMrr, endingMrr,
    unexplained: 0,
    basis: "ledger",
    notes: [],
  };
}

/**
 * Net new MRR — the single number an owner actually asks for.
 * Returns `null` when it cannot be stated honestly, rather than a partial figure
 * that looks complete.
 */
export function netNewMrr(w: MrrWaterfall): number | null {
  if (w.basis === "ledger") {
    return w.newMrr + (w.expansion ?? 0) - (w.contraction ?? 0) - w.churnedMrr;
  }
  // Reconstructed: New − Churn is real, but it is not the whole story whenever
  // there is unrecorded movement. Saying "net new = X" then would be wrong.
  return w.unexplained === 0 ? w.newMrr - w.churnedMrr : null;
}
