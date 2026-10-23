/**
 * R-1111 (23 Oct 2026) — which /done screen a visitor sees.
 *
 * "Payment received · order placed" used to be the page's last fallback, so a bookmark, a
 * reload in a fresh tab or a stray link told anyone that they had paid. It is now shown only
 * when this browser session holds proof for THIS order:
 *   - a Razorpay payment our server confirmed as paid (R-1596, `anutech.payment`), or
 *   - a laptop-only simulated order the server recorded (R-1502) — the checkout leaves
 *     `anutech.simulated` = that order's number.
 * Anything else is the neutral "looking for your order?" screen.
 */
import type { VerifyState } from "@/lib/checkout/confirm-payment";

/** sessionStorage key the checkout sets after a simulated (no Razorpay keys) order. */
export const SIMULATED_KEY = "anutech.simulated";

export type DoneView = "trial-unsent" | "trial" | "payment-pending" | "paid" | "none";

export interface DoneFacts {
  trialEmail: string | null;
  trialSent: boolean;
  /** A Razorpay payment is in sessionStorage. */
  hasPayment: boolean;
  /** The server's last answer for that payment. */
  verdict: VerifyState | null;
  /** `anutech.order` (null when missing or empty). */
  orderNo: string | null;
  /** `anutech.simulated` (null when missing). */
  simulatedFor: string | null;
}

export function doneView(f: DoneFacts): DoneView {
  if (f.trialEmail) return f.trialSent ? "trial" : "trial-unsent";
  if (f.hasPayment) return f.verdict === "paid" ? "paid" : "payment-pending";
  if (f.simulatedFor !== null && f.simulatedFor === (f.orderNo ?? "")) return "paid";
  return "none";
}
