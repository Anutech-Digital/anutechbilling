/**
 * R-248 — what the operator is told after Record payment, as ONE toast.
 *
 * The sheet used to fire 2–4 toasts on staggered setTimeouts (600/700/800/900/1200 ms),
 * so a single payment produced a stack that people read half of. "Invoice can now be
 * generated" also had no button, and amounts went through toLocaleString, which prints
 * ₹246.9 for a fraction. This builds one message — a headline, the extra facts as lines
 * underneath, and at most two buttons — and the dialog only renders it.
 *
 * Pure: no toast, no router, no Supabase. Tested in record-payment-toast.test.ts.
 */
import { rupee } from "@/lib/utils";

export type PaymentToastActionKind = "generate-invoice" | "view-invoice" | "send-receipt";

export interface PaymentToastAction {
  kind: PaymentToastActionKind;
  label: string;
}

export interface PaymentToastInput {
  /* From the record_payment RPC result. */
  outstanding: number;
  isFullyPaid: boolean;
  convertedNow: boolean;
  subscriptionCreated: boolean;
  invoicePaid: boolean;
  hasExistingInvoice: boolean;
  isRenewalQuote: boolean;
  renewalRolledForward: boolean;
  overpaidCredit: number;
  tdsRecorded: boolean;
  tdsAttempted: boolean;
  tdsAmount: number;
  paymentId: string | null;
  /** Set only when record_payment allocated a receipt voucher (pre-invoice payments). */
  receiptVoucherNo: string | null;
  /* From the dialog. */
  customerName: string;
  /** The invoice this quote already has, when the caller knows it. */
  invoiceId: string | null;
  /** Why no subscription appeared — null when that question does not arise. */
  subscriptionNote: { kind: "one-off" | "missing"; item: string } | null;
  receiptUploadFailed: boolean;
}

export interface PaymentToast {
  tone: "success" | "warning";
  title: string;
  /** Extra facts, one per line. Empty when the headline says it all. */
  lines: string[];
  primary: PaymentToastAction | null;
  secondary: PaymentToastAction | null;
}

function headline(r: PaymentToastInput): string {
  if (r.renewalRolledForward) return "Renewal payment received · subscription rolled forward 1 year";
  if (r.isRenewalQuote && !r.isFullyPaid) {
    return `Partial renewal payment recorded · ${rupee(r.outstanding)} still due to renew`;
  }
  if (r.convertedNow) {
    const sub = r.subscriptionCreated ? " + subscription activated" : "";
    return r.isFullyPaid ? `Paid in full · Customer created${sub}` : `Advance received · Customer created${sub}`;
  }
  if (r.invoicePaid) return "Balance received · invoice marked paid";
  if (r.hasExistingInvoice) return `Payment recorded against invoice · ${rupee(r.outstanding)} still pending`;
  if (r.isFullyPaid) return "Paid in full · GST invoice can be generated now";
  return `Payment recorded · ${rupee(r.outstanding)} still pending`;
}

export function paymentToast(r: PaymentToastInput): PaymentToast {
  const lines: string[] = [];
  let warn = false;

  if (r.renewalRolledForward) lines.push("Reminders restart from the new renewal date (T-15).");
  if (r.convertedNow && !r.isFullyPaid) lines.push(`${rupee(r.outstanding)} outstanding — balance pending.`);

  if (r.subscriptionNote?.kind === "one-off") {
    lines.push(`${r.subscriptionNote.item} is a one-time purchase — there is no subscription to renew.`);
  } else if (r.subscriptionNote?.kind === "missing") {
    warn = true;
    lines.push("No subscription was created for this plan. That should not happen — open the quote and add it, so the renewal is not missed.");
  }

  if (r.overpaidCredit > 0) {
    lines.push(`${rupee(r.overpaidCredit)} received in excess — saved as advance credit for ${r.customerName}.`);
  }
  if (r.tdsRecorded && r.tdsAmount > 0) {
    lines.push(`TDS receivable ${rupee(r.tdsAmount)} logged · chase Form 16A from ${r.customerName}.`);
  } else if (r.tdsAttempted) {
    warn = true;
    lines.push(`The TDS receivable row failed — add it manually so you don't lose the ${rupee(r.tdsAmount)} credit.`);
  }
  if (r.receiptUploadFailed) {
    warn = true;
    lines.push("The receipt file didn't attach — add it later from the payment.");
  }

  const canSendReceipt = Boolean(r.paymentId && r.receiptVoucherNo);
  const sendReceipt: PaymentToastAction | null = canSendReceipt ? { kind: "send-receipt", label: "Send receipt" } : null;

  let primary: PaymentToastAction | null = null;
  let secondary: PaymentToastAction | null = null;
  if (r.invoiceId && (r.hasExistingInvoice || r.invoicePaid)) {
    primary = { kind: "view-invoice", label: "View invoice" };
  } else if (r.isFullyPaid && !r.hasExistingInvoice && !r.invoiceId) {
    /* Same button the quote page shows once money is in (quoteMoneyActions); the
       generate_invoice RPC itself refuses a quote that is already invoiced. */
    primary = { kind: "generate-invoice", label: "Generate invoice" };
    secondary = sendReceipt;
  } else {
    primary = sendReceipt;
  }

  return { tone: warn ? "warning" : "success", title: headline(r), lines, primary, secondary };
}

/**
 * The reference saved for a cash payment left blank.
 *
 * NOT the bare word "Cash": record_payment treats a second payment on the same quote with
 * the same reference as an idempotent replay and records nothing. Two cash instalments
 * both saved as "Cash" would silently drop the second one. Date + IST time keeps it
 * readable and unique per submit, while an RQ retry of the same submit reuses it.
 */
export function cashReference(receivedDate: string, now: Date = new Date()): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return `Cash ${receivedDate} ${time}`.trim();
}
