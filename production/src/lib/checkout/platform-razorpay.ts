/**
 * R-1923 (G-ONBOARD OB-2, 26 Oct 2026) — whose Razorpay account a quote may be charged through.
 *
 * The RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env pair is the PLATFORM's own Razorpay account
 * (Anutech's — the one the buy page sells under). The public quote page and its pay route used
 * to fall back to it for ANY company that had not connected its own keys, so a new reseller's
 * customer pressed "Pay online" and the money landed in Anutech's account.
 *
 * Now:
 *   - a company's own keys (tenant_secrets) are used when it has them;
 *   - the env pair is used ONLY for the platform tenant — `websiteTenantId()` (BUY_PAGE_TENANT_ID,
 *     or the live Anutech tenant on a production build, lib/website-tenant.ts);
 *   - anyone else gets no "Pay online" and the pay route answers 503; the page shows the
 *     company's UPI QR instead (when it has a UPI ID).
 *
 * Env is read at call time so a test or a restarted server sees the current values.
 */
import { websiteTenantId } from "@/lib/website-tenant";

type Env = Record<string, string | undefined>;

export interface RazorpayKeyPair {
  keyId: string;
  keySecret: string;
  mode: "test" | "live";
}

/** The env Razorpay keys — only when `tenantId` is the platform tenant; otherwise null. */
export function platformEnvRazorpayKeys(tenantId: string | null | undefined, env: Env = process.env): RazorpayKeyPair | null {
  const platform = websiteTenantId(env);
  if (!platform || !tenantId || tenantId !== platform) return null;
  const keyId = env.RAZORPAY_KEY_ID?.trim() || env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() || "";
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, mode: keyId.startsWith("rzp_live_") ? "live" : "test" };
}

/**
 * The public accept page's "Pay online": the company has its own Razorpay keys (or is the
 * platform, with the env pair) AND the quote is in ₹ (Razorpay charges INR). The pay route
 * (lib/checkout/quote-order.ts) re-checks with the same key rule.
 */
export function quotePayOnlineOffered(
  q: { tenantId: string; tenantHasOwnKeys: boolean; currency: string | null | undefined },
  env: Env = process.env,
): boolean {
  if (q.currency && q.currency.toUpperCase() !== "INR") return false;
  return q.tenantHasOwnKeys || platformEnvRazorpayKeys(q.tenantId, env) !== null;
}
