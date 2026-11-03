/**
 * R-2410 — "Small leftovers": dust that should be closed, not chased.
 *
 * Staging 3 Nov: the top rows of Payment Follow-up were ₹55 (172 days late), ₹1 (157 days) and
 * ₹432 ("may be TDS 194J 2%") — chased first only because they were the oldest. A customer whose
 * every open line is the remainder of a PART-PAID invoice (R-2421) — up to ₹500 in all, or exactly
 * the TDS they withheld (each up to ₹5,000, R-2421) — leaves the chase list for a folded "Small
 * leftovers (N · ₹X)" group, where the owner or accountant closes each line:
 *
 *   - Book as TDS            — the line's balance is a common TDS of its pre-GST value (the R-1520
 *                              rule, OwedItem.tdsHint → lib/accounting/tds-match). Opens the
 *                              existing Record payment sheet in TDS mode (record_desk_payment →
 *                              record_payment_with_tds); nothing new on the money side.
 *   - Write off small balance — an invoice line of ₹1–₹500, with a reason
 *                              (write_off_small_invoice_balance, migration 20261103123242 — the
 *                              database enforces the same ₹500 and owner/accountant rule).
 *
 * Pure — tested in small-leftovers.test.ts.
 */
import type { CollectionRow, OwedItem } from "@/lib/queries/collections";

/**
 * Up to this balance (whole rupees) a customer is a small leftover. Default ₹500 — the limit is
 * an open decision on card R-2410 (needsDecision); write_off_small_invoice_balance refuses above
 * the same number, so change both together.
 */
export const SMALL_LEFTOVER_LIMIT = 500;

/**
 * R-2421: a TDS-looking balance folds away only up to this many rupees. Bigger ones (₹1 L left on
 * an ₹11.8 L bill matches 10% TDS) stay in the chase list with their "Looks like TDS" hint —
 * an under-payment or TDS never deposited must still be chased. Default ₹5,000 (needsDecision
 * on card R-2421).
 */
export const TDS_LEFTOVER_LIMIT = 5_000;

type LeftoverItem = Pick<OwedItem, "kind" | "amountDue" | "tdsHint" | "partPaid">;

/**
 * R-2421: a leftover is what is LEFT on an invoice the customer already paid part of
 * (paid_amount ≥ ₹1 — OwedItem.partPaid). A whole unpaid bill, however small (a ₹354 hosting
 * invoice), is real money and stays chased; so does a subscription balance (no invoice payment).
 * write_off_small_invoice_balance refuses an unpaid invoice by the same rule.
 */
function isPartPaidInvoiceLine(i: LeftoverItem): boolean {
  return i.kind === "invoice" && i.amountDue > 0 && i.partPaid === true;
}

/**
 * The line is exactly the customer's TDS (R-1520 match on the invoice's pre-GST value, ±₹1), on a
 * part-paid invoice, and within TDS_LEFTOVER_LIMIT.
 */
export function isTdsLeftoverLine(i: LeftoverItem): boolean {
  return isPartPaidInvoiceLine(i) && !!i.tdsHint && Math.round(i.amountDue) <= TDS_LEFTOVER_LIMIT;
}

/**
 * A customer row is a small leftover when it owes something, has no renewal to chase (moving it
 * would hide the renewal), and every open line is a part-paid invoice's remainder: TDS matches
 * (each up to TDS_LEFTOVER_LIMIT) and other remainders adding up to at most the limit.
 */
export function isSmallLeftover(
  r: Pick<CollectionRow, "amountDue" | "items" | "renewals">,
  limit: number = SMALL_LEFTOVER_LIMIT,
): boolean {
  if (r.amountDue <= 0 || r.renewals.length > 0) return false;
  const open = r.items.filter((i) => i.amountDue > 0);
  if (open.length === 0 || !open.every(isPartPaidInvoiceLine)) return false;
  const smallTotal = open.filter((i) => !isTdsLeftoverLine(i)).reduce((s, i) => s + i.amountDue, 0);
  return Math.round(smallTotal) <= limit;
}

export type LeftoverReason = "tds" | "small";

export interface LeftoverLine {
  row: CollectionRow;
  item: OwedItem;
  reason: LeftoverReason;
  /** "Book as TDS" fits this line. */
  canBookTds: boolean;
  /** "Write off small balance" fits this line (an invoice within the limit). */
  canWriteOff: boolean;
}

/** One line per open owed item of the leftover rows, oldest first. */
export function leftoverLines(rows: readonly CollectionRow[], limit: number = SMALL_LEFTOVER_LIMIT): LeftoverLine[] {
  const out: LeftoverLine[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      if (item.amountDue <= 0) continue;
      const tds = isTdsLeftoverLine(item);
      out.push({
        row,
        item,
        reason: tds ? "tds" : "small",
        canBookTds: tds,
        canWriteOff: isPartPaidInvoiceLine(item) && Math.round(item.amountDue) <= limit,
      });
    }
  }
  return out.sort((a, b) => b.item.daysOverdue - a.item.daysOverdue || a.item.id.localeCompare(b.item.id));
}

/** Split a list into the chase list and the leftovers (same order kept). */
export function splitLeftovers<T extends Pick<CollectionRow, "amountDue" | "items" | "renewals">>(
  rows: readonly T[],
  limit: number = SMALL_LEFTOVER_LIMIT,
): { main: T[]; leftovers: T[] } {
  const main: T[] = [];
  const leftovers: T[] = [];
  for (const r of rows) (isSmallLeftover(r, limit) ? leftovers : main).push(r);
  return { main, leftovers };
}

/** Only the owner or the accountant closes a leftover (card R-2410; the write-off RPC checks it too). */
export function mayCloseLeftovers(role: string | null | undefined): boolean {
  return role === "owner" || role === "accountant";
}
