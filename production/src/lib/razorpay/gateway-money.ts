/**
 * R-045 — what Razorpay KEPT on a payment, and what a refund event asks a human to do.
 *
 * Pure functions, no I/O: the webhook (api/webhooks/razorpay) reads the event, these decide
 * the numbers and the words.
 *
 * FEES. A captured payment entity carries `fee` (Razorpay's fee INCLUDING GST on it) and
 * `tax` (the GST part), both in paise. The bank receives `amount - fee`. Until R-045 both
 * fields were dropped, so a ₹1,180 payment was booked as ₹1,180 while about ₹1,152 reached
 * the bank — the bank line could never match, and the fee was booked nowhere.
 *
 * Whole rupees (CLAUDE.md money rule). Each figure is rounded once from paise and the
 * ex-GST part is the DIFFERENCE of the rounded figures, so base + GST always equals the fee
 * shown and net + fee always equals the amount recorded — no rupee appears or vanishes in
 * rounding.
 *
 * REFUNDS. `refund.processed` means the money has ALREADY gone back to the buyer at
 * Razorpay. The app must not quietly flip the books: if a GST tax invoice was issued, the
 * correct entry is a credit note (CGST §34) before the refund is booked — refund_payment
 * refuses otherwise. Issuing a credit note is a human decision (full or partial, which
 * lines), so this module only writes the instruction; nothing is issued by machine.
 */

export interface RazorpayFeeFields {
  amount?: number | null;
  fee?: number | null;
  tax?: number | null;
}

export interface GatewayFee {
  /** Whole rupees Razorpay kept, GST included. */
  fee: number;
  /** Whole rupees of `fee` that is GST on the fee. */
  gst: number;
  /** `fee - gst`: the fee itself (MDR), whole rupees. */
  feeExGst: number;
  /** Whole rupees that reach the settlement: recorded amount − fee. */
  net: number;
}

const isPaise = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The fee on a captured payment, or null when Razorpay did not send one we can trust
 * (missing, negative, GST larger than the fee, fee larger than the amount). Null means
 * "unknown" and is stored as NULL — never guessed as zero.
 */
export function gatewayFeeFromPayment(p: RazorpayFeeFields | null | undefined): GatewayFee | null {
  if (!p || !isPaise(p.amount) || !isPaise(p.fee)) return null;
  const taxPaise = p.tax == null ? 0 : p.tax;
  if (!isPaise(taxPaise) || taxPaise > p.fee || p.fee > p.amount) return null;
  const amount = Math.round(p.amount / 100);
  const fee = Math.round(p.fee / 100);
  const gst = Math.round(taxPaise / 100);
  return { fee, gst, feeExGst: fee - gst, net: amount - fee };
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  /** paise */
  amount: number;
  status?: string;
  speed_processed?: string | null;
}

/** A refund entity we can act on, or null (missing ids, bad amount). */
export function parseRefund(r: unknown): RazorpayRefundEntity | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.startsWith("rfnd_")) return null;
  if (typeof o.payment_id !== "string" || !o.payment_id.trim()) return null;
  if (!isPaise(o.amount) || o.amount <= 0) return null;
  return {
    id: o.id,
    payment_id: o.payment_id,
    amount: o.amount,
    status: typeof o.status === "string" ? o.status : undefined,
    speed_processed: typeof o.speed_processed === "string" ? o.speed_processed : null,
  };
}

export interface RefundContext {
  quoteId: string;
  /** Whole rupees recorded on the payment row. */
  paymentAmount: number;
  /** payments.status in the app. */
  paymentStatus: string;
  /** Number of the issued GST invoice, if any. */
  invoiceNumber: string | null;
}

export interface RefundAdvice {
  /** Whole rupees refunded by Razorpay. */
  amount: number;
  partial: boolean;
  /** What the desk must do next, in plain English. */
  nextStep: string;
  /** The full note for the lead / notification body. */
  note: string;
}

/** The instruction a refund.processed event leaves for the desk. Never acts by itself. */
export function refundAdvice(refund: RazorpayRefundEntity, ctx: RefundContext): RefundAdvice {
  const amount = Math.round(refund.amount / 100);
  const partial = amount < ctx.paymentAmount;
  const rs = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  let nextStep: string;
  if (ctx.paymentStatus === "refunded") {
    nextStep = "The payment is already marked refunded in the app — nothing more to book.";
  } else if (ctx.invoiceNumber) {
    nextStep =
      `Invoice ${ctx.invoiceNumber} was issued, so first raise a credit note for ${rs(amount)} from that invoice's page, ` +
      `then use Refund on that payment (Payments page). Nothing has been issued automatically.`;
  } else if (partial) {
    nextStep =
      `This is a partial refund (${rs(amount)} of ${rs(ctx.paymentAmount)}). The app's Refund books the whole payment, ` +
      `so record this one by hand on the quote. Nothing has been changed automatically.`;
  } else {
    nextStep = "Use Refund on that payment (Payments page) to book it — it issues the refund voucher. Nothing has been changed automatically.";
  }

  const note =
    `Razorpay refunded ${rs(amount)}${partial ? ` (partial, of ${rs(ctx.paymentAmount)})` : ""} on quote ${ctx.quoteId} ` +
    `(refund ${refund.id}, payment ${refund.payment_id}). The money has already left Razorpay. ${nextStep}`;
  return { amount, partial, nextStep, note };
}
