/**
 * R-2322 — a money-out bank line booked as a CUSTOMER REFUND (Banking → Reconcile → Customer refund).
 *
 * What can be refunded comes from the server (customer_refundable_items, migration
 * 20261101013533_r2322_bank_customer_refund.sql) — the same rules as the existing Payments → Refund:
 *   · credit_note — the open credit a credit note left on a paid invoice (refund_credit_note_credit):
 *     any amount up to that credit;
 *   · advance — an unused advance (refund_payment): back whole only.
 * The bank line IS the amount. These helpers only decide what the screen offers for this line and
 * what it says; reconcile_bank_debit_as_customer_refund checks everything again on Save.
 */
import { formatDate, rupee } from "@/lib/utils";

export interface RefundableItem {
  payment_id: string;
  kind: "credit_note" | "advance";
  refundable: number;
  whole_only: boolean;
  invoice_id: string | null;
  credit_notes: string | null;
  voucher_no: string | null;
  received_on: string | null;
}

/** One line per refundable item, in the words on the documents. */
export function refundItemLabel(i: RefundableItem): string {
  if (i.kind === "credit_note") {
    const notes = i.credit_notes ? `Credit note ${i.credit_notes}` : "Credit-note credit";
    return `${notes} on ${i.invoice_id ?? "the invoice"} · up to ${rupee(i.refundable)}`;
  }
  const when = i.received_on ? ` (${formatDate(i.received_on)})` : "";
  return `Unused advance${i.voucher_no ? ` ${i.voucher_no}` : ""}${when} · ${rupee(i.refundable)}`;
}

/** Why this item cannot take this bank line, or null when it can. */
export function refundItemProblem(i: RefundableItem, lineAmount: number): string | null {
  if (i.whole_only || i.kind === "advance") {
    return lineAmount === i.refundable
      ? null
      : `This advance is ${rupee(i.refundable)} — an advance is refunded whole, so the line must be ${rupee(i.refundable)}.`;
  }
  return lineAmount <= i.refundable
    ? null
    : `Only ${rupee(i.refundable)} can be refunded here — issue a credit note for the rest first.`;
}

/** The item picked for the operator: the exact amount first, else the first that fits. */
export function pickDefaultRefundItem(items: readonly RefundableItem[], lineAmount: number): string | null {
  const exact = items.find((i) => i.refundable === lineAmount && !refundItemProblem(i, lineAmount));
  if (exact) return exact.payment_id;
  return items.find((i) => !refundItemProblem(i, lineAmount))?.payment_id ?? null;
}

/** The reason is printed on the refund voucher (the server wants 5+ characters). */
export function refundReasonProblem(reason: string): string | null {
  return reason.trim().length < 5 ? "Write why the money went back (at least 5 characters)." : null;
}

/* Words too common in a company name to say who it is. */
const COMMON = new Set([
  "india", "indian", "private", "limited", "technologies", "technology", "tech", "solutions", "services",
  "systems", "software", "digital", "global", "infotech", "enterprises", "group", "company", "neft", "imps",
  "rtgs", "refund", "transfer", "payment",
]);

/** The customer whose name's first telling word is in the narration — only when exactly one is. */
export function guessRefundCustomer(
  narration: string | null | undefined,
  customers: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (!narration) return null;
  const words = new Set(narration.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const hits = new Set<string>();
  for (const c of customers) {
    const key = c.name.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 4 && !COMMON.has(w));
    if (key && words.has(key)) hits.add(c.id);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** A reason the operator can keep or edit (smart default; printed on the refund voucher). */
export function defaultRefundReason(i: RefundableItem): string {
  return i.kind === "credit_note"
    ? `Refund of ${i.credit_notes ? `credit note ${i.credit_notes}` : "credit-note credit"} on ${i.invoice_id ?? "the invoice"}`
    : `Refund of unused advance${i.voucher_no ? ` ${i.voucher_no}` : ""}`;
}
