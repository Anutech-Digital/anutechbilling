/**
 * The Razorpay API keys the website checkout uses for a tenant: the tenant's own sealed
 * keys in tenant_secrets first, then the RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env pair.
 *
 * One function so the order is CREATED (cart-checkout.ts) and later VERIFIED
 * (verify-payment.server.ts, R-1596) with the same key — a signature made with one secret
 * never checks out against another.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

export interface CheckoutRazorpayKeys {
  keyId: string;
  keySecret: string;
  mode: "test" | "live";
}

export async function loadCheckoutRazorpayKeys(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
): Promise<CheckoutRazorpayKeys | null> {
  const { data: rawSecrets } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  // Sealed at rest (rosv1:…) — decrypt or Razorpay rejects the ciphertext.
  const secrets = decryptTenantSecrets(rawSecrets);
  if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
    return {
      keyId: secrets.razorpay_key_id,
      keySecret: secrets.razorpay_key_secret,
      mode: secrets.razorpay_mode === "live" ? "live" : "test",
    };
  }
  const envKeyId = process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
  const envKeySecret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
  if (envKeyId && envKeySecret) {
    return { keyId: envKeyId, keySecret: envKeySecret, mode: envKeyId.startsWith("rzp_live_") ? "live" : "test" };
  }
  return null;
}
