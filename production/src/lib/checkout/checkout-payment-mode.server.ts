import "server-only";
/**
 * R-1502: the checkout's payment mode, read on the server with the SAME key lookup the order
 * route uses (loadCheckoutRazorpayKeys) and the same simulation gate (R-079), so the page can
 * never offer a mode the server would refuse.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { loadCheckoutRazorpayKeys } from "./razorpay-keys.server";
import { buyPageTenantIdOrEmpty, simulatedPaymentAllowed } from "./live-guards";
import { checkoutPaymentMode, type CheckoutPaymentMode } from "./checkout-payment-mode";

export async function loadCheckoutPaymentMode(): Promise<CheckoutPaymentMode> {
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
    return "live";
  }
  return checkoutPaymentMode({ razorpayConfigured: configured, simulationAllowed: simulatedPaymentAllowed({ razorpayKeyId: keyId }) });
}
