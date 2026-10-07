/**
 * R-374 — a payment whose reference is ALREADY on this quote.
 *
 * `record_payment` (and `record_payment_with_tds`, which wraps it) treats the same
 * (quote, reference) as an idempotent replay: it inserts nothing and returns the EXISTING
 * payment_id with `idempotent_replay: true` / `already_recorded: true`. The Record payment
 * sheet used to carry on as if the payment were new — it PATCHED that existing row's
 * received_at and bank_account_id with the second instalment's values and toasted
 * "Payment recorded · ₹X still pending". A cheque/voucher number reused for a second
 * instalment therefore dropped the second amount silently and rewrote the first payment's
 * date and bank account.
 *
 * The rules live here so they are unit-tested: on a replay there is nothing to tag, and the
 * operator is told plainly that nothing new was saved.
 *
 * Pure: no toast, no Supabase. Tested in record-payment-replay.test.ts.
 */
import { rupee } from "@/lib/utils";
import { formatIstDate } from "@/lib/dates/ist";

/** The RPC result flags that mean "this reference was already recorded, nothing inserted". */
export function isReplayResult(r: { already_recorded?: boolean | null; idempotent_replay?: boolean | null }): boolean {
  return Boolean(r.already_recorded || r.idempotent_replay);
}

export interface PaymentTagPatch {
  received_at?: string;
  bank_account_id?: string;
}

/**
 * The date + bank-account tag written onto the payment row just recorded, or null when
 * nothing should be written. ALWAYS null on a replay: the row belongs to the earlier
 * payment, and its date and bank account are that payment's, not this form's.
 */
export function paymentTagPatch(a: {
  isReplay: boolean;
  receivedDate: string | null | undefined;
  bankAccountId: string | null | undefined;
}): PaymentTagPatch | null {
  if (a.isReplay) return null;
  const patch: PaymentTagPatch = {};
  if (a.receivedDate) patch.received_at = new Date(a.receivedDate).toISOString();
  if (a.bankAccountId) patch.bank_account_id = a.bankAccountId;
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface ReplayToast {
  tone: "warning";
  title: string;
  lines: string[];
}

/** What the operator is told when the reference was already recorded. */
export function replayToast(prior: { amount: number | null | undefined; receivedAt: string | null | undefined } | null): ReplayToast {
  const on = prior?.receivedAt ? ` on ${formatIstDate(prior.receivedAt)}` : "";
  const amt = prior?.amount !== null && prior?.amount !== undefined ? ` for ${rupee(prior.amount)}` : "";
  return {
    tone: "warning",
    title: `This reference is already recorded${on}${amt} — nothing new saved.`,
    lines: ["Use a different reference for a new payment."],
  };
}
