/**
 * How the website checkout (/checkout — hosting, domains, email) takes payment (R-1502).
 *
 * The server (cart-checkout.ts) has always had three answers, and the Workspace buy page
 * already showed them; the cart checkout did not, so on a laptop with no Razorpay secret
 * every Pay ended in "Online payment isn't set up yet" and no hosting or domain order could
 * be walked to /done.
 *
 *   live       — Razorpay keys are set where simulation is not allowed (a deployment, or a live
 *                key): the real Razorpay window opens.
 *   simulation — simulation is allowed (since R-1769 also when TEST keys are set) (a laptop, never a deployment — R-079):
 *                the order is recorded without Razorpay so the whole pipeline can be checked.
 *   disabled   — no keys on a deployment: there is no way to pay online, so the page offers
 *                a quote instead of a Pay button that can only fail.
 */
export type CheckoutPaymentMode = "live" | "simulation" | "disabled";

export function checkoutPaymentMode(opts: { razorpayConfigured: boolean; simulationAllowed: boolean }): CheckoutPaymentMode {
  /* R-1769 (24 Oct 2026): simulation first. On a laptop with an rzp_test_ key (the pair in
     .env.local, or keys saved in local Settings) the page used to go "live" and hide Simulate
     payment — Pawan's walk stopped at Razorpay "Authentication failed". simulationAllowed is
     false on every deployment and with a live key (R-079), so a deployment is unchanged. */
  if (opts.simulationAllowed) return "simulation";
  return opts.razorpayConfigured ? "live" : "disabled";
}

/**
 * R-1769: on a laptop that ALSO has Razorpay test keys, the real Razorpay test window stays
 * available as a second, smaller choice — never on a deployment (there the mode is "live").
 */
export function razorpayTestOffered(opts: { razorpayConfigured: boolean; simulationAllowed: boolean }): boolean {
  return opts.razorpayConfigured && opts.simulationAllowed;
}

/** The pay button's words — a test must never read as a real charge. */
export function payButtonLabel(mode: CheckoutPaymentMode, amount: string): string {
  return mode === "simulation" ? `Simulate payment · ${amount}` : `Pay ${amount}`;
}
