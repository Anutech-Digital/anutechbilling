/**
 * R-1676 — one bank credit (UTR / UPI ref) is recorded once per company.
 *
 * The database refuses the second payment (trigger trg_payments_ref_once, migration
 * 20261019125620) with a message that names the existing receipt, and puts the existing
 * payment's ids in the error's `details`:
 *   "duplicate_payment_reference payment_id=<uuid> customer_id=<uuid>"
 * This reads them back so the toast can offer a button to that customer's payments
 * (production/CLAUDE.md §24: reason + next step + a button).
 */
import type { Route } from "next";

export interface DuplicateReference {
  paymentId: string;
  customerId: string | null;
}

const MARK = /duplicate_payment_reference payment_id=([0-9a-f-]{36}) customer_id=([0-9a-f-]{36})?/i;

/** The existing payment behind a "Ye UTR pehle se … par hai" refusal, or null for any other error. */
export function duplicateReferenceOf(err: unknown): DuplicateReference | null {
  if (!err || typeof err !== "object") return null;
  const details = (err as { details?: unknown }).details;
  if (typeof details !== "string") return null;
  const m = MARK.exec(details);
  if (!m) return null;
  return { paymentId: m[1], customerId: m[2] ?? null };
}

/** Where the "Open that payment" button goes: the customer's payments, else all payments. */
export function duplicateReferenceHref(dup: DuplicateReference): Route {
  return (dup.customerId ? `/payments?customer=${encodeURIComponent(dup.customerId)}` : "/payments") as Route;
}
