/**
 * R-351 (7 Oct 2026) — one answer to "is this online order paid?".
 *
 * The manager's test run found ORD-MUR2KM5J with a "Paid" badge in the list and the drawer
 * header, while the same drawer's Automation progress said "Payment — Pending". Two sources:
 * the badge read `leads.stage === 'won'`, and the steps were a hard-coded list where every
 * step was "pending" for every order. Neither looked at the money.
 *
 * The money lives on the order's QUOTE. `record_payment` (the only way a payment is recorded,
 * from the Razorpay webhook, the test checkout and the desk) moves `quotes.payment_status` to
 * 'partial' or 'received'; once the GST invoice is issued it is 'received'/'invoiced' with
 * `quotes.invoice_id` set. A lead can be 'won' with no payment at all (marked won by hand,
 * project accepted), so the stage is never proof of money.
 *
 * Everything on the page that says paid / not paid — list badge, drawer badge, Paid tab,
 * KPIs, Payment + GST Invoice steps, Invoice row, next action — reads `orderPaymentView`.
 */
import { invoiceByLead } from "./invoice-links";

export interface QuotePaymentRow {
  lead_id: string | null;
  payment_status: string | null;
  invoice_id: string | null;
  created_at: string | null;
}

export type PaymentState = "paid" | "partial" | "none";

export interface OrderPayment {
  state: PaymentState;
  /** The GST invoice of the order's newest invoiced quote, or null. */
  invoiceId: string | null;
}

/** quote.payment_status values that mean the full amount was recorded. */
const FULLY_PAID = new Set(["received", "invoiced"]);

/**
 * lead id → what was actually recorded against its quotes. A lead with several quotes is paid
 * if ANY of them was fully paid (a re-quote that was paid), part-paid if one has a part
 * payment and none is fully paid. Leads with no quote rows are simply absent.
 */
export function paymentByLead(rows: readonly QuotePaymentRow[]): Map<string, OrderPayment> {
  const invoices = invoiceByLead(rows);
  const out = new Map<string, OrderPayment>();
  for (const r of rows) {
    const leadId = r.lead_id?.trim();
    if (!leadId) continue;
    const status = (r.payment_status ?? "").trim();
    const here: PaymentState = FULLY_PAID.has(status) ? "paid" : status === "partial" ? "partial" : "none";
    const seen = out.get(leadId)?.state ?? "none";
    const state: PaymentState = seen === "paid" || here === "paid" ? "paid" : seen === "partial" || here === "partial" ? "partial" : "none";
    out.set(leadId, { state, invoiceId: invoices.get(leadId) ?? null });
  }
  return out;
}

export type StepState = "done" | "active" | "pending" | "failed";

export interface OrderPaymentView {
  /** The ONE paid flag — badge, Paid tab, KPIs and filters read only this. */
  paid: boolean;
  invoiceNo: string | null;
  /** Automation progress for the two money steps. */
  steps: { payment: StepState; invoice: StepState };
  /** Drawer "Invoice" row text when there is no invoice to link. */
  invoiceText: string;
}

/**
 * Derive every money signal of an order from the recorded payment. `undefined` = no quote
 * row was found (or the lookup failed) — then nothing is shown as paid.
 */
export function orderPaymentView(p: OrderPayment | undefined): OrderPaymentView {
  const state = p?.state ?? "none";
  const invoiceNo = p?.invoiceId ?? null;
  const paid = state === "paid";
  return {
    paid,
    invoiceNo,
    steps: {
      payment: paid ? "done" : state === "partial" ? "active" : "pending",
      /* Paid with no invoice = the automatic invoice was refused (usually no state / place of
         supply on the buyer — the reason is noted on the lead). That needs a person. */
      invoice: invoiceNo ? "done" : paid ? "failed" : "pending",
    },
    invoiceText: paid ? "Not issued yet — see the note on the lead" : state === "partial" ? "After full payment" : "After payment",
  };
}
