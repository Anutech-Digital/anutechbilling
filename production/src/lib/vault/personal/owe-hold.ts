/**
 * R-2386 — "Money I owe / hold for others" (table personal_owe_hold,
 * migration 20261102175034_r2386_personal_owe_hold.sql).
 *
 * Money that sits in one of your accounts (or as cash with someone) but is not yours:
 *   - an advance (byana) received for a sale — owed to the buyer until the sale goes through;
 *   - money held on behalf of someone, e.g. a child.
 * Net worth subtracts every OPEN entry. Loans taken / given are a separate card (R-2388):
 * they join the same "owed" total through `owedTotal` below, so the Overview line stays one.
 *
 * All amounts are whole rupees.
 */

export type OweHoldKind = "advance_received" | "held_for_other";
export type OweHoldStatus = "open" | "settled";
export type OweHoldSettledHow = "refunded" | "handed_over" | "converted_to_sale";

export const OWE_HOLD_KINDS: readonly OweHoldKind[] = ["advance_received", "held_for_other"] as const;

export const OWE_HOLD_KIND_LABEL: Record<OweHoldKind, string> = {
  advance_received: "Advance received for a sale",
  held_for_other: "Held on behalf of someone",
};

/** Short form for a badge in a list row. */
export const OWE_HOLD_KIND_SHORT: Record<OweHoldKind, string> = {
  advance_received: "Advance",
  held_for_other: "Held for someone",
};

/** Who the "party" field is, per kind — the form's label. */
export const OWE_HOLD_PARTY_LABEL: Record<OweHoldKind, string> = {
  advance_received: "Received from (buyer)",
  held_for_other: "Held for (person)",
};

export const OWE_HOLD_SETTLED_LABEL: Record<OweHoldSettledHow, string> = {
  refunded: "Refunded",
  handed_over: "Handed over",
  converted_to_sale: "Became part of the sale",
};

/**
 * The ways an OPEN entry can be closed, in the order the buttons show (first = the usual
 * next step). "Convert into sale" exists only for an advance — the DB refuses it otherwise.
 */
export function settleActions(kind: OweHoldKind): { how: OweHoldSettledHow; label: string }[] {
  return kind === "advance_received"
    ? [
        { how: "converted_to_sale", label: "Convert into sale" },
        { how: "refunded", label: "Refund" },
      ]
    : [{ how: "handed_over", label: "Hand over" }];
}

export interface OweHoldLike {
  amount: number;
  status: OweHoldStatus;
}

function rupees(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Sum of the OPEN entries — what net worth subtracts. A settled entry no longer counts. */
export function openOweHoldTotal(rows: readonly OweHoldLike[]): number {
  let total = 0;
  for (const r of rows) if (r.status === "open") total += rupees(r.amount);
  return total;
}

/**
 * Everything owed, in one place: card dues + open owe/hold entries (+ loans outstanding once
 * R-2388 lands). Net worth = assets − this.
 */
export function owedTotal(parts: { cardDues: number; oweHoldOpen: number; loansOutstanding?: number }): number {
  return rupees(parts.cardDues) + rupees(parts.oweHoldOpen) + rupees(parts.loansOutstanding ?? 0);
}
