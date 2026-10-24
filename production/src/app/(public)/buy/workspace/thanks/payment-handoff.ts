/**
 * R-1625 (24 Oct 2026) — the Workspace buy page hands Razorpay's answer to the thanks page.
 *
 * Until this card Razorpay's success handler only redirected, and the order was completed by
 * the webhook alone. Wherever the webhook is late or missing the quote was still 'awaiting',
 * fetchOrder found nothing, and a buyer who had just paid read "Order not found".
 *
 * Now the handler keeps {orderId, paymentId, signature} for THIS quote in sessionStorage, and
 * the thanks page asks our server to confirm it (POST /api/public/checkout/verify — the R-1596
 * path: signature with the key the order was made with, Razorpay's own record of the payment,
 * amount from the quote, then the webhook's own settleCapturedPayment, idempotent per payment
 * id — so the page and the webhook can never record it twice).
 *
 * Its own key, not the cart checkout's "anutech.payment": /done must never pick up a Workspace
 * payment, and this page must never pick up a cart one. Nothing in here is trusted — the
 * server re-checks every field.
 */
import type { ReturnedPayment, VerifyState } from "@/lib/checkout/confirm-payment";

export const WORKSPACE_PAYMENT_KEY = "anutech.payment.workspace";

export interface WorkspacePayment extends ReturnedPayment {
  /** The quote this payment was made for — the thanks page uses it only for that order. */
  quoteId: string;
}

export function saveWorkspacePayment(quoteId: string | undefined, p: ReturnedPayment | null): void {
  try {
    if (p && quoteId) window.sessionStorage.setItem(WORKSPACE_PAYMENT_KEY, JSON.stringify({ ...p, quoteId }));
  } catch { /* storage blocked: the thanks page falls back to the email/support wording */ }
}

/** The stored payment for this quote, or null (none, another quote's, or unreadable). */
export function readWorkspacePayment(quoteId: string): WorkspacePayment | null {
  try {
    const p = JSON.parse(window.sessionStorage.getItem(WORKSPACE_PAYMENT_KEY) || "null") as WorkspacePayment | null;
    return p && p.quoteId === quoteId && p.orderId && p.paymentId && p.signature ? p : null;
  } catch {
    return null;
  }
}

export function forgetWorkspacePayment(): void {
  try { window.sessionStorage.removeItem(WORKSPACE_PAYMENT_KEY); } catch { /* nothing to undo */ }
}

/** Reload once the server says "paid" (the server then finds the order). An object so tests can stub it. */
export const pageReload = { run: () => window.location.reload() };

/** How often and how many times the page asks while Razorpay is still completing it. */
export const CONFIRM_EVERY_MS = 4000;
export const CONFIRM_TRIES = 5;

/** What the page shows for the server's latest answer. */
export type ConfirmView = "checking" | "paid" | "failed" | "refused" | "still-confirming";

export function confirmView(answer: VerifyState | null, polling: boolean, answeredQuoteId: string | undefined, quoteId: string): ConfirmView {
  if (answer === null || polling) return "checking";
  // A "paid" for some other quote is not this order's confirmation.
  if (answer === "paid") return answeredQuoteId && answeredQuoteId !== quoteId ? "refused" : "paid";
  if (answer === "failed") return "failed";
  if (answer === "refused") return "refused";
  return "still-confirming";
}
