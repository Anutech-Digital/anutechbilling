/**
 * R-1613 — what a customer owes on a QUOTE right now. ONE answer for every place that asks
 * for that money: the Razorpay order (lib/checkout/quote-order.ts), the public accept page's
 * "Pay now" button and its UPI QR, and the scan-to-pay QR printed on the quote PDF (download,
 * email attachment, WhatsApp).
 *
 * Before this, R-1569 taught the Razorpay order to charge only the remainder (quote total −
 * money received) while the page and the QRs kept their own arithmetic: a ₹708 quote with
 * ₹400 recorded showed "Pay online now · ₹708" while Razorpay charged ₹308, and a quarterly
 * quote's PDF QR asked for the whole ₹28,320 term while the order took instalment 1 (₹7,080).
 *
 * Rules (the order's, unchanged — R-1569 / R-234 / R-377):
 *  - invoiced (invoice_id, or payment_status 'invoiced')  → "invoiced": the invoice owns the ask.
 *  - payment_status 'received', or received ≥ total        → "paid": show Paid, no QR, no button.
 *  - split billing (monthly/quarterly/half-yearly on an annual commitment) → instalment 1;
 *    once anything is paid ('partial') → "instalment-paid": the rest comes from instalment
 *    invoices, never from the quote.
 *  - otherwise → total − received. `received` is the payments ledger (status 'received',
 *    TDS included, refunds out) — `quoteAmountReceived` in quote-order.ts.
 *  - a foreign quote (USD…) gets its figure in THAT currency, from the same display-currency
 *    maths the PDF prints (lib/quotes/per-period-figures, R-1570) — never a ₹ instalment with
 *    a "$" in front. `inr: false` → Razorpay and UPI both refuse it (they settle rupees only).
 */
import { quoteInstalments } from "@/lib/billing/instalments";
import { cycleFromLegacyCommitment } from "@/lib/quotes/billing";
import { quotePerPeriodFigures } from "@/lib/quotes/per-period-figures";
import { isForeignCurrency } from "@/lib/currency";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface QuoteDueNowFields {
  amount: number | null;
  subtotal: number | null;
  discount_pct: number | null;
  tax_rate: number | null;
  billing_cycle?: BillingCycle | null;
  currency?: string | null;
  exchange_rate?: number | null;
  payment_status?: string | null;
  invoice_id?: string | null;
  /** Raw quote lines — the first line's commitment and, on a foreign quote, qty × rate. */
  line_items?: unknown;
}

export type QuoteDueNow =
  | {
      state: "due";
      /** What is collected today, in `currency` (whole ₹, or 2dp for a foreign quote). */
      amount: number;
      currency: string;
      /** ₹ quote — the only kind Razorpay and UPI can take. */
      inr: boolean;
      /** Split-billed: instalment 1 of `count`. Null for a single payment. */
      instalment: { count: number; cycle: BillingCycle; termGross: number } | null;
      /** Quote total in `currency`, and what was received already (same currency). */
      quoteTotal: number;
      alreadyPaid: number;
    }
  | { state: "paid" }
  | { state: "invoiced" }
  | { state: "instalment-paid" }
  | { state: "nothing" };

interface RawLine { qty?: unknown; rate?: unknown; commitment?: unknown }

function lines(raw: unknown): RawLine[] {
  return Array.isArray(raw) ? (raw as RawLine[]) : [];
}

export function quoteFirstCommitment(lineItems: unknown): string | null {
  const c = lines(lineItems)[0]?.commitment;
  return typeof c === "string" ? c : null;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * @param received ₹ already received on the quote (payments ledger). Pass 0 when unknown —
 *   the Razorpay order re-reads the ledger and is the one that charges.
 */
export function quoteDueNow(q: QuoteDueNowFields, received: number): QuoteDueNow {
  if (q.invoice_id) return { state: "invoiced" };
  const status = (q.payment_status ?? "none").toLowerCase();
  if (status === "invoiced") return { state: "invoiced" };
  if (status === "received") return { state: "paid" };

  const firstCommitment = quoteFirstCommitment(q.line_items);
  const cycle: BillingCycle = q.billing_cycle ?? cycleFromLegacyCommitment(firstCommitment);
  const taxRate = q.tax_rate ?? 18;
  const subtotal = q.subtotal ?? 0;
  const discountPct = q.discount_pct ?? 0;
  const totalInr = q.amount ?? 0;
  const paidInr = Math.max(0, n(received));

  const split = quoteInstalments({
    cycle,
    termTaxable: subtotal - Math.round(subtotal * discountPct / 100),
    termGross: totalInr,
    taxRate,
    lineCommitment: firstCommitment,
  });

  // Fully paid on the ledger (R-1569's 409) — a split quote never gets here paid in full.
  if (!split && paidInr > 0 && paidInr >= totalInr) return { state: "paid" };
  if (split && (status === "partial" || paidInr > 0)) return { state: "instalment-paid" };

  if (!isForeignCurrency(q.currency)) {
    const amount = split ? split.firstGross : totalInr - paidInr;
    if (!(amount > 0)) return { state: "nothing" };
    return {
      state: "due", amount, currency: "INR", inr: true,
      instalment: split ? { count: split.count, cycle: split.cycle, termGross: split.instalmentsGross } : null,
      quoteTotal: totalInr, alreadyPaid: paidInr,
    };
  }

  /* Foreign: the display-currency figures exactly as the PDF builds them (QuotePDF —
     per-unit ₹ ÷ rate at 2dp, lines summed, then discount and tax), then one invoice of
     them from per-period-figures. */
  const fx = q.exchange_rate && q.exchange_rate > 0 ? q.exchange_rate : 1;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const dSubtotal = r2(lines(q.line_items).reduce((s, l) => s + r2(n(l.qty) * r2(n(l.rate) / fx)), 0));
  const dDiscount = r2(dSubtotal * (discountPct / 100));
  const dTaxable = r2(dSubtotal - dDiscount);
  const dTax = r2(dTaxable * (taxRate / 100));
  const dTotal = r2(dTaxable + dTax);
  const pp = quotePerPeriodFigures({
    cycle, lineCommitment: firstCommitment,
    subtotal: dSubtotal, discount: dDiscount, taxable: dTaxable, tax: dTax, total: dTotal,
    taxRate, foreign: true,
  });
  const splitForeign = pp.perInvoice && !pp.flex;
  const dPaid = r2(paidInr / fx);
  if (splitForeign && dPaid > 0) return { state: "instalment-paid" };
  const amount = splitForeign ? pp.gross : r2(dTotal - dPaid);
  if (!(amount > 0)) return { state: "nothing" };
  return {
    state: "due", amount, currency: (q.currency ?? "").trim().toUpperCase(), inr: false,
    instalment: splitForeign ? { count: pp.invoicesPerYear, cycle, termGross: pp.yearTotal } : null,
    quoteTotal: dTotal, alreadyPaid: dPaid,
  };
}

/** ₹ for a scan-to-pay UPI QR. 0 = print no QR (not a ₹ quote, or nothing due now). */
export function quoteDueNowUpiAmount(due: QuoteDueNow): number {
  return due.state === "due" && due.inr ? due.amount : 0;
}
