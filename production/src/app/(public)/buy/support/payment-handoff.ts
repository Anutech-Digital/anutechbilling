/**
 * R-2083 — Razorpay's answer handed from /buy/support to its thanks page (same pattern as the
 * Workspace page, R-1625): {orderId, paymentId, signature} for THIS quote in sessionStorage,
 * which the thanks page sends to POST /api/public/checkout/verify. Its own key, so the Workspace
 * thanks page and /done never pick up a support payment. Nothing here is trusted — the server
 * checks the signature, Razorpay's record and the amount.
 */
import type { ReturnedPayment } from "@/lib/checkout/confirm-payment";

export const SUPPORT_PAYMENT_KEY = "anutech.payment.support";

export function supportThanksUrl(quoteId: string, token: string, simulated: boolean): string {
  const q = new URLSearchParams({ order: quoteId, t: token });
  if (simulated) q.set("sim", "1");
  return `/buy/support/thanks?${q.toString()}`;
}

export function saveSupportPayment(quoteId: string, p: ReturnedPayment | null): void {
  try {
    if (p) window.sessionStorage.setItem(SUPPORT_PAYMENT_KEY, JSON.stringify({ ...p, quoteId }));
  } catch { /* storage blocked: the thanks page says the email will confirm it */ }
}

export function readSupportPayment(quoteId: string): ReturnedPayment | null {
  try {
    const p = JSON.parse(window.sessionStorage.getItem(SUPPORT_PAYMENT_KEY) || "null") as (ReturnedPayment & { quoteId?: string }) | null;
    return p && p.quoteId === quoteId && p.orderId && p.paymentId && p.signature ? p : null;
  } catch {
    return null;
  }
}
