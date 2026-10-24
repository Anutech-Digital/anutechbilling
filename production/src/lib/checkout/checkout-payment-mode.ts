/**
 * How the website checkout (/checkout — hosting, domains, email) takes payment (R-1502).
 *
 * The server (cart-checkout.ts) has always had three answers, and the Workspace buy page
 * already showed them; the cart checkout did not, so on a laptop with no Razorpay secret
 * every Pay ended in "Online payment isn't set up yet" and no hosting or domain order could
 * be walked to /done.
 *
 *   live       — Razorpay keys are set: the real Razorpay window opens (test or live key).
 *   simulation — no keys, and simulation is allowed (a laptop, never a deployment — R-079):
 *                the order is recorded without Razorpay so the whole pipeline can be checked.
 *   disabled   — no keys on a deployment: there is no way to pay online, so the page offers
 *                a quote instead of a Pay button that can only fail.
 */
export type CheckoutPaymentMode = "live" | "simulation" | "disabled";

export function checkoutPaymentMode(opts: { razorpayConfigured: boolean; simulationAllowed: boolean }): CheckoutPaymentMode {
  if (opts.razorpayConfigured) return "live";
  return opts.simulationAllowed ? "simulation" : "disabled";
}

/** The pay button's words — a test must never read as a real charge. */
export function payButtonLabel(mode: CheckoutPaymentMode, amount: string): string {
  return mode === "simulation" ? `Simulate payment · ${amount}` : `Pay ${amount}`;
}
