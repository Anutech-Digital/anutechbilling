/**
 * R-2023 (27 Oct 2026, Pardeep — staging LINKS INFOTECH ₹47,348): a CUSTOMER ADVANCE is its own
 * thing, not a sale.
 *
 * R-1863 books money that arrives before anything is sold (Banking → Reconcile → "Advance —
 * nothing to invoice yet") as a receipt voucher + an open customer credit. A payment needs a
 * quote, so the receipt hangs on a ₹0, line-less "Advance on account" holder quote — status
 * accepted, payment_status received. Read as a quote, that holder said "Accepted · Paid",
 * "Paid in full — Raise the GST invoice", offered "Generate GST Invoice" on ₹0 and was counted
 * in Payments Received's "GST invoice not generated" action. It is none of those: it is the
 * customer's advance, used later through Record payment → "Use advance" (one way, the
 * existing customer-credit path: record_desk_payment → redeem_customer_credits).
 *
 * ONE rule — the same as the database's is_customer_advance_quote() (migration
 * 2026102711*_r2023_customer_advance) and bank_advance_payment(): plan "Advance on account",
 * ₹0, no lines, never invoiced. Existing advances fix themselves through this rule (no data
 * repair).
 */

import { rupee } from "@/lib/utils";

export const ADVANCE_QUOTE_PLAN = "Advance on account";

/** The one word for an advance everywhere (list badge, quote page, payments tag). */
export const CUSTOMER_ADVANCE_LABEL = "Customer advance";

export interface AdvanceQuoteFields {
  plan?: string | null;
  amount?: number | null;
  invoice_id?: string | null;
  line_items?: unknown;
}

/** Is this quote an R-1863 advance holder (and so NOT a sale)? */
export function isCustomerAdvanceQuote(q: AdvanceQuoteFields | null | undefined): boolean {
  if (!q) return false;
  if ((q.plan ?? "").trim() !== ADVANCE_QUOTE_PLAN) return false;
  if ((q.amount ?? 0) !== 0) return false;
  if (q.invoice_id) return false;
  return !Array.isArray(q.line_items) || q.line_items.length === 0;
}

const inr = (n: number) => rupee(Math.round(n));

/** "Customer advance · ₹47,348 available" — or "… · fully used" once it is all spent. */
export function customerAdvanceStatus(available: number): string {
  return available > 0
    ? `${CUSTOMER_ADVANCE_LABEL} · ${inr(available)} available`
    : `${CUSTOMER_ADVANCE_LABEL} · fully used`;
}

/** One open / used customer-credit row, as the screens read it. */
export interface AdvanceCreditRow {
  amount: number;
  status: string;
}

/** What is left of an advance: the open part of its credit rows (used / refunded ones are gone). */
export function advanceAvailable(rows: readonly AdvanceCreditRow[]): number {
  return rows.filter((r) => r.status === "open").reduce((s, r) => s + (r.amount ?? 0), 0);
}

/**
 * How much "Use advance" adjusts on a payment: what the person typed (partial allowed), never
 * more than the advance available nor more than the bill still owes, whole rupees, never < 0.
 * `typed` null = not edited → the most it can cover.
 */
export function advanceToUse(args: { available: number; owed: number; typed: number | null }): number {
  const cap = Math.max(0, Math.min(Math.floor(args.available), Math.floor(args.owed)));
  if (args.typed == null || !Number.isFinite(args.typed)) return cap;
  return Math.max(0, Math.min(cap, Math.floor(args.typed)));
}
