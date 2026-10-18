/**
 * R-1596 — the browser half of confirming a website payment.
 *
 * Razorpay's checkout hands the page {razorpay_order_id, razorpay_payment_id,
 * razorpay_signature} when the buyer pays. The checkout keeps them in sessionStorage and asks
 * POST /api/public/checkout/verify to confirm the payment; /done asks again on load (a reload,
 * or a confirmation still in progress). The server decides everything — this file only carries
 * the three ids and the answer.
 */

/** What the server says about the payment (lib/checkout/verify-payment.server.ts). */
export type VerifyState = "paid" | "confirming" | "failed" | "refused";

export interface VerifyBody {
  state: VerifyState;
  /** Plain words for the buyer: what happened and what to do next. */
  message: string;
  quoteId?: string;
  invoiceId?: string | null;
}

export interface ReturnedPayment {
  orderId: string;
  paymentId: string;
  signature: string;
  /** The last answer from the server, if it has answered. */
  state?: VerifyState;
}

export const PAYMENT_KEY = "anutech.payment";

/** Razorpay's success-handler argument, read defensively — a missing field means "ask support". */
export function fromRazorpayHandler(resp: unknown): ReturnedPayment | null {
  const r = (resp ?? {}) as Record<string, unknown>;
  const orderId = typeof r.razorpay_order_id === "string" ? r.razorpay_order_id : "";
  const paymentId = typeof r.razorpay_payment_id === "string" ? r.razorpay_payment_id : "";
  const signature = typeof r.razorpay_signature === "string" ? r.razorpay_signature : "";
  return orderId && paymentId && signature ? { orderId, paymentId, signature } : null;
}

export function savePayment(p: ReturnedPayment | null): void {
  try {
    if (p) window.sessionStorage.setItem(PAYMENT_KEY, JSON.stringify(p));
    else window.sessionStorage.removeItem(PAYMENT_KEY);
  } catch { /* storage blocked: /done shows the generic "check your email" wording */ }
}

export function readPayment(): ReturnedPayment | null {
  try {
    const p = JSON.parse(window.sessionStorage.getItem(PAYMENT_KEY) || "null") as ReturnedPayment | null;
    return p && p.orderId && p.paymentId && p.signature ? p : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server to confirm. Never throws: a network failure is "confirming" — the payment
 * may well be fine, and the page says so and asks again rather than claiming either way.
 */
export async function confirmPayment(p: ReturnedPayment): Promise<VerifyBody> {
  try {
    const res = await fetch("/api/public/checkout/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: p.orderId, paymentId: p.paymentId, signature: p.signature }),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as Partial<VerifyBody> | null;
    const state = json?.state;
    if (state === "paid" || state === "confirming" || state === "failed" || state === "refused") {
      return { state, message: json?.message ?? "", quoteId: json?.quoteId, invoiceId: json?.invoiceId ?? null };
    }
    return { state: "confirming", message: "We're still confirming your payment." };
  } catch {
    return { state: "confirming", message: "We couldn't reach our server to confirm your payment." };
  }
}
