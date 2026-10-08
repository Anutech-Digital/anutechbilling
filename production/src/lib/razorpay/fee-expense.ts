/**
 * R-045 slice 2 — Razorpay's fee, shown on the payment and BOOKED as an expense.
 *
 * Slice 1 kept the fee on the payment row (payments.gateway_fee = fee incl. GST,
 * gateway_fee_gst = the GST part, whole rupees). Nothing used them: the Payments page still
 * showed only the gross, and the P&L / GST input never heard of the fee.
 *
 * NET. The cash that reaches the settlement is `amount − gateway_fee`. One subtraction of two
 * whole-rupee numbers — no rounding here, so fee + net is always the amount shown.
 *
 * BOOKING. One expense per payment, never two:
 *   - id = `EXP-RZPFEE-<payment uuid>` — the expenses primary key IS the idempotency key, so a
 *     webhook retry, a payment.captured after order.paid, and the backfill button all land on
 *     the same row and the second insert does nothing (insert … on conflict (id) do nothing).
 *   - amount = gateway_fee, gst_paid = gateway_fee_gst. In this app an expense's `amount` is
 *     what was paid INCLUDING GST and `gst_paid` is the GST inside it; the P&L takes the
 *     claimable GST back out (lib/accounting/pnl-assemble: expensesTotal = paid − eligible
 *     ITC), so the cost shown is gateway_fee − gateway_fee_gst and the GST lands in input
 *     credit. Booking amount = fee ex-GST here would drop the GST from the cost twice.
 *   - category "Bank Charges", paid, payment_method "razorpay": Razorpay deducted it from the
 *     settlement, so there is no separate bank line for it.
 *   - GST HEADS from facts, never a guess: Razorpay's own GSTIN (from the tenant's vendor
 *     master, if they added Razorpay as a vendor) against the tenant's state. Same state →
 *     CGST+SGST, other state → IGST. Either side unknown → heads left empty, and the GST
 *     report shows its usual "assumed" flag instead of us inventing a head.
 *   - ITC needs a GSTIN on the vendor (lib/gst/itc.ts). With no Razorpay vendor, the fee is
 *     still booked as a cost and the GST shows under "credit blocked: vendor GSTIN missing"
 *     — the honest state until the owner adds Razorpay (with its GSTIN) as a vendor.
 *
 * Pure: no I/O. fee-expense.server.ts reads the rows and writes the insert this returns.
 */
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";

export const GATEWAY_FEE_CATEGORY = "Bank Charges";
export const GATEWAY_FEE_VENDOR_NAME = "Razorpay";

/** The expense id for a payment's Razorpay fee — the idempotency key (expenses.id is the PK). */
export function feeExpenseId(paymentId: string): string {
  return `EXP-RZPFEE-${paymentId}`;
}

export interface PaymentFeeFields {
  amount: number;
  gateway_fee?: number | null;
  gateway_fee_gst?: number | null;
}

export interface PaymentFeeView {
  /** Whole rupees Razorpay kept, GST included. */
  fee: number;
  /** GST part of `fee`. */
  gst: number;
  /** Whole rupees that reached the settlement: amount − fee. */
  net: number;
}

const wholeNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Fee and net for a payment row, or null when the fee is unknown (manual payment, or a
 * capture before R-045). A zero fee is a real zero and is shown; a fee larger than the
 * amount is bad data and is not.
 */
export function paymentFeeView(p: PaymentFeeFields | null | undefined): PaymentFeeView | null {
  if (!p || !wholeNonNeg(p.gateway_fee) || !Number.isFinite(p.amount)) return null;
  if (p.gateway_fee > p.amount) return null;
  const gst = wholeNonNeg(p.gateway_fee_gst) && p.gateway_fee_gst <= p.gateway_fee ? p.gateway_fee_gst : 0;
  return { fee: p.gateway_fee, gst, net: p.amount - p.gateway_fee };
}

export interface FeeExpensePayment extends PaymentFeeFields {
  id: string;
  tenant_id: string;
  quote_id: string;
  reference: string | null;
  /** timestamptz — the expense date is its IST calendar day. */
  received_at: string;
}

export interface FeeExpenseVendor {
  id: string;
  gstin: string | null;
}

export interface FeeExpenseInsert {
  id: string;
  tenant_id: string;
  category: string;
  vendor_name: string;
  vendor_id: string | null;
  expense_date: string;
  amount: number;
  gst_paid: number;
  igst: number | null;
  cgst: number | null;
  sgst: number | null;
  bill_type: "gst";
  paid: true;
  paid_date: string;
  payment_method: "razorpay";
  description: string;
  notes: string;
}

/** IST calendar day (YYYY-MM-DD) of a timestamp — the business runs on IST. */
export function istDay(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * GST heads for the fee from facts only: Razorpay's GSTIN state vs ours. Null when either is
 * unknown — the GST report then marks the split as assumed, out loud.
 */
export function feeGstHeads(
  gst: number,
  vendorGstin: string | null | undefined,
  ownStateCode: string | null | undefined,
): { igst: number; cgst: number; sgst: number } | null {
  if (gst <= 0) return { igst: 0, cgst: 0, sgst: 0 };
  const vendorState = stateCodeFromGstin(vendorGstin ?? null);
  const own = (ownStateCode ?? "").trim() || null;
  if (!vendorState || !own) return null;
  return splitTaxHeads(gst, vendorState !== own);
}

/**
 * The expense row for a payment's Razorpay fee, or null when there is nothing to book
 * (fee unknown or zero, or a date we cannot read).
 */
export function gatewayFeeExpense(
  payment: FeeExpensePayment,
  vendor: FeeExpenseVendor | null,
  ownStateCode: string | null,
): FeeExpenseInsert | null {
  const view = paymentFeeView(payment);
  if (!view || view.fee <= 0) return null;
  const day = istDay(payment.received_at);
  if (!day) return null;
  const heads = feeGstHeads(view.gst, vendor?.gstin, ownStateCode);
  const ref = payment.reference ?? payment.id;
  return {
    id: feeExpenseId(payment.id),
    tenant_id: payment.tenant_id,
    category: GATEWAY_FEE_CATEGORY,
    vendor_name: GATEWAY_FEE_VENDOR_NAME,
    vendor_id: vendor?.id ?? null,
    expense_date: day,
    amount: view.fee,
    gst_paid: view.gst,
    igst: heads?.igst ?? null,
    cgst: heads?.cgst ?? null,
    sgst: heads?.sgst ?? null,
    bill_type: "gst",
    paid: true,
    paid_date: day,
    payment_method: "razorpay",
    description: `Razorpay fee on ${ref} (quote ${payment.quote_id})`,
    notes:
      `Booked automatically from the payment (R-045): fee ₹${view.fee} incl. GST ₹${view.gst}, ` +
      `deducted by Razorpay from the settlement; ₹${view.net} of ₹${payment.amount} reached the bank. ` +
      `Razorpay's monthly tax invoice is the bill for this GST.`,
  };
}
