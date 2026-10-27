import "server-only";
/**
 * R-1502: the checkout's payment mode, read on the server with the SAME key lookup the order
 * route uses (loadCheckoutRazorpayKeys) and the same simulation gate (R-079), so the page can
 * never offer a mode the server would refuse.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { loadCheckoutRazorpayKeys } from "./razorpay-keys.server";
import { buyPageTenantIdOrEmpty, simulatedPaymentAllowed } from "./live-guards";
import { checkoutPaymentMode, razorpayTestOffered, type CheckoutPaymentMode } from "./checkout-payment-mode";

export interface CheckoutPaymentSetup {
  mode: CheckoutPaymentMode;
  /** R-1769: a laptop with Razorpay TEST keys — the real test window is a second choice. */
  razorpayTest: boolean;
}

export async function loadCheckoutPaymentSetup(): Promise<CheckoutPaymentSetup> {
  let keyId = "";
  let configured = false;
  try {
    const tenantId = buyPageTenantIdOrEmpty();
    const keys = tenantId ? await loadCheckoutRazorpayKeys(createAdminClient(), tenantId) : null;
    keyId = keys?.keyId ?? "";
    configured = Boolean(keys?.keyId && keys.keySecret);
  } catch {
    /* A failed read must not hide the Pay button: "live" lets the order route give its own
       answer, exactly as before this card. */
    return { mode: "live", razorpayTest: false };
  }
  const opts = { razorpayConfigured: configured, simulationAllowed: simulatedPaymentAllowed({ razorpayKeyId: keyId }) };
  return { mode: checkoutPaymentMode(opts), razorpayTest: razorpayTestOffered(opts) };
}

export async function loadCheckoutPaymentMode(): Promise<CheckoutPaymentMode> {
  return (await loadCheckoutPaymentSetup()).mode;
}
