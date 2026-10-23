/**
 * R-1120 (23 Oct 2026) — the Online Orders drawer's money rows, from STORED facts only.
 *
 * The drawer used to make money up: GST = round(lead value × 18%), billing always "Annual",
 * "Rate/seat" = lead value ÷ seats ÷ 12 and a Razorpay ID that was always blank. A ₹1,000 plan
 * with a 10% coupon on quarterly billing showed ₹1,180 "Annual" while its quote said ₹1,062
 * quarterly.
 *
 * Now every figure comes from the order's quote (amount, subtotal, discount, tax rate, billing
 * cycle), its GST invoice once issued (taxable value, GST, IGST vs CGST + SGST) and its recorded
 * payments (the Razorpay payment id the webhook stores as the payment reference). A fact that is
 * not stored is `{ value: null, why }` — the drawer prints "—" and the reason, never a guess.
 */
import { isQuoteAmountConsistent, taxableAfterDiscount } from "@/lib/quotes/amounts";
import { quotePaymentState } from "@/lib/payments/won-paid";

export interface OrderQuoteRow {
  id: string;
  lead_id: string | null;
  created_at: string | null;
  amount: number | null;
  subtotal: number | null;
  tax_rate: number | null;
  discount_pct: number | null;
  billing_cycle: string | null;
  payment_status: string | null;
  invoice_id: string | null;
}

export interface OrderInvoiceRow {
  id: string;
  amount: number | null;
  taxable_value: number | null;
  tax_amount: number | null;
  tax_rate: number | null;
  inter_state: boolean | null;
}

export interface OrderPaymentRow {
  quote_id: string | null;
  method: string | null;
  reference: string | null;
  status: string | null;
  received_at: string | null;
}

/** A stored value, or nothing plus the short reason it is unknown. */
export type Fact<T> = { value: T } | { value: null; why: string };

export interface OrderMoney {
  billing: Fact<string>;
  subtotal: Fact<number>;
  /** The quote's coupon / discount %, or null when there is none. */
  discountPct: number | null;
  taxable: Fact<number>;
  gstLabel: string;
  gst: Fact<number>;
  gstSplit: Fact<string>;
  total: Fact<number>;
  razorpayId: Fact<string>;
}

const CYCLE_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-yearly",
  yearly: "Annual",
};

const num = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * The quote that IS the order: the newest invoiced one, else the newest with a payment,
 * else the newest. A lead with several quotes (a re-quote) is one order.
 */
export function pickOrderQuote(rows: readonly OrderQuoteRow[]): OrderQuoteRow | undefined {
  const newestFirst = [...rows].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return (
    newestFirst.find((q) => !!q.invoice_id) ??
    newestFirst.find((q) => quotePaymentState(q.payment_status) !== "none") ??
    newestFirst[0]
  );
}

export function orderMoney(
  quote: OrderQuoteRow | undefined,
  invoice: OrderInvoiceRow | undefined,
  payments: readonly OrderPaymentRow[],
  /** Why there is no quote — "not loaded" when the lookup failed, so it never reads as "none". */
  noQuoteWhy = "No quote for this order yet",
): OrderMoney {
  if (!quote) {
    const none = { value: null, why: noQuoteWhy } as const;
    return {
      billing: none, subtotal: none, discountPct: null, taxable: none, gstLabel: "GST",
      gst: none, gstSplit: none, total: none, razorpayId: none,
    };
  }

  const cycle = quote.billing_cycle ? CYCLE_LABEL[quote.billing_cycle] : undefined;
  const billing: Fact<string> = cycle ? { value: cycle } : { value: null, why: "Not set on the quote" };

  const subtotalN = num(quote.subtotal);
  const subtotal: Fact<number> = subtotalN != null ? { value: subtotalN } : { value: null, why: "Not stored on the quote" };
  const discountPct = num(quote.discount_pct) && Number(quote.discount_pct) > 0 ? Number(quote.discount_pct) : null;

  const rate = num(invoice?.tax_rate) ?? num(quote.tax_rate);
  const gstLabel = rate != null ? `GST (${rate}%)` : "GST";
  const amount = num(quote.amount);

  let taxable: Fact<number>;
  let gst: Fact<number>;
  let total: Fact<number>;
  let gstSplit: Fact<string>;

  if (invoice) {
    const t = num(invoice.taxable_value);
    const g = num(invoice.tax_amount);
    const a = num(invoice.amount);
    taxable = t != null ? { value: t } : { value: null, why: "Not stored on the invoice" };
    gst = g != null ? { value: g } : { value: null, why: "Not stored on the invoice" };
    total = a != null ? { value: a } : { value: null, why: "Not stored on the invoice" };
    gstSplit = invoice.inter_state == null
      ? { value: null, why: "Not stored on the invoice" }
      : { value: invoice.inter_state ? "IGST (other state)" : "CGST + SGST (same state)" };
  } else {
    const t = subtotalN != null ? taxableAfterDiscount(subtotalN, discountPct ?? 0) : null;
    taxable = t != null ? { value: t } : { value: null, why: "Not stored on the quote" };
    total = amount != null ? { value: amount } : { value: null, why: "Quote has no amount" };
    gst =
      t != null && amount != null && rate != null && subtotalN != null &&
      isQuoteAmountConsistent(subtotalN, rate, amount, discountPct ?? 0)
        ? { value: amount - t }
        : { value: null, why: "Quote figures don't add up — open the quote" };
    gstSplit = { value: null, why: "Set on the GST invoice" };
  }

  const rz = payments
    .filter((p) => p.quote_id === quote.id && (p.method === "razorpay" || p.method === "upi") && p.status !== "refunded" && p.reference?.trim())
    .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""))[0];
  const razorpayId: Fact<string> = rz?.reference
    ? { value: rz.reference.trim() }
    : { value: null, why: "No Razorpay payment recorded" };

  return { billing, subtotal, discountPct, taxable, gstLabel, gst, gstSplit, total, razorpayId };
}
