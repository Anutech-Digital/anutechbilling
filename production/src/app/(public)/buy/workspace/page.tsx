/**
 * Public buy page — Google Workspace
 * Route: /buy/workspace
 *
 * Server-side: pulls the reseller's ENABLED Google Workspace SKUs from the
 * Item Catalog (`items` table) so the buy page always reflects what Pardeep
 * has actually configured. No hardcoded tiers anymore.
 *
 * Filter:
 *   tenant_id = BUY_PAGE_TENANT_ID  (single-tenant for v1)
 *   vendor    = 'google'
 *   kind      = 'main'
 *   is_active = true
 *   name LIKE 'Google Workspace%'
 *
 * If the catalog has zero matching SKUs (fresh install, accidentally disabled
 * everything), we still render the page with a friendly "contact us" message
 * instead of an empty product grid.
 *
 * R-2027 (27 Oct 2026): the price read is _parts/fetch-catalog.ts — retries with backoff (~6 s),
 * the tenant's last good list (10 min), else null: the page then shows "Loading prices…" with Buy
 * locked and loads the prices itself. No typed fallback prices anywhere on this page.
 *
 * R-027 (5 Oct 2026): the QA check timed out (20 s) on the test service. Measured: 8–10 s on
 * a freshly started instance (staging right after a push, the idle test service), 0.2–0.8 s
 * once warm. The page then ran its two database reads ONE AFTER THE OTHER with no limit, so a
 * cold connection paid twice. They now run together, each capped at 3 s: a slow read shows
 * the "contact us" grid or quote-only checkout instead of hanging the page.
 */
import { Metadata } from "next";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/server";
import { BuyWorkspaceClient } from "./buy-workspace-client";
import { BuyMobileClient } from "./_mobile/buy-mobile-client";
import { buyViewFor } from "./_mobile/device";
import { parseBuyParams } from "@/lib/checkout/buy-link";
import { simulatedPaymentAllowed } from "@/lib/checkout/live-guards";
import { checkoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { PARTNER_LINE } from "@/site/lib/config";
import { websiteTenantId } from "@/lib/website-tenant";
import { fetchBuyBrand } from "./_parts/fetch-brand";
import { fetchBuyCatalog } from "./_parts/fetch-catalog";
import { websitePixelId } from "@/lib/meta/pixel-id.server";

/* R-1499: tenant read per call (websiteTenantId) — outside production an unset BUY_PAGE_TENANT_ID
   shows nothing (and logs why), never the live tenant's data. */

/* R-1970 (DECISIONS 1): the title names the website tenant, read from its row — never typed. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBuyBrand();
  return {
    title: { absolute: brand ? `Buy Google Workspace · ${brand.name}` : "Buy Google Workspace" },
    description: `Google Workspace pricing for India. GST invoice, hand-held migration, Hindi + English support. ${PARTNER_LINE}.`,
  };
}

// Don't cache for the SSR — Pardeep needs price/enablement edits in the
// catalog to reflect on the buy page within seconds.
export const dynamic = "force-dynamic";

const READ_TIMEOUT_MS = 3_000;

/**
 * True only when BOTH Razorpay key id AND secret are configured —
 * either via per-tenant `tenant_secrets` (Settings → Integrations →
 * Razorpay) or via env. Either missing → online checkout silently runs
 * in simulation mode (lead → quote → record_payment pipeline + emails,
 * no Razorpay widget). Lets us ship the buy flow safely before KYC.
 */
async function isRazorpayConfigured(): Promise<{ configured: boolean; keyId: string }> {
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  // Per-tenant first
  if (BUY_PAGE_TENANT_ID) try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret")
      .eq("tenant_id", BUY_PAGE_TENANT_ID)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    /* R-1769: the key id decides live vs test (simulation), so read it unsealed — the same
       way the order route does. */
    const secrets = decryptTenantSecrets(data);
    if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) return { configured: true, keyId: secrets.razorpay_key_id };
  } catch { /* fall through to env */ }

  const keyId =
    process.env.RAZORPAY_KEY_ID?.trim() ||
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() ||
    "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
  return { configured: Boolean(keyId) && Boolean(keySecret), keyId };
}

export default async function BuyWorkspacePage(props: {
  /* R-120: ?tier=&seats=&buy=1 from the home edition card — open on that edition, ready to pay. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await props.searchParams;
  const pick = parseBuyParams(sp);
  /* R-2020 (R-2019 decision 1): a phone gets the one-screen-at-a-time flow, a laptop the v2 page —
     decided here, so only one of the two client trees is sent. ?view=mobile|desktop overrides. */
  const view = buyViewFor(await headers(), typeof sp.view === "string" ? sp.view : null);
  // Both reads at once (R-027) — each is capped, so the page waits for the slowest, not the sum (brand and prices: ~6 s with their retries, R-2024 / R-2027).
  const [catalogItems, { configured, keyId }, brand, metaPixelId] = await Promise.all([fetchBuyCatalog(), isRazorpayConfigured(), fetchBuyBrand(), websitePixelId()]);
  // Live when Razorpay is fully configured. When it isn't:
  //  · non-prod (or ALLOW_SIMULATED_CHECKOUT=1) → "simulation": Buy now stays
  //    visible for Pardeep to walk the full pipeline, clearly TEST-MODE banded.
  //  · production without that flag → "disabled": the online-buy CTA is hidden
  //    so a REAL customer never sees a "Simulate payment" button on a public
  //    storefront before Razorpay go-live. They get "Get a GST quote" instead.
  // R-079: never on a production deployment, whatever ALLOW_SIMULATED_CHECKOUT says — same gate as the route.
  // R-1769: the same rule as the cart checkout — a laptop simulates even with Razorpay TEST keys.
  const paymentMode = checkoutPaymentMode({
    razorpayConfigured: configured,
    simulationAllowed: simulatedPaymentAllowed({ razorpayKeyId: keyId }),
  });
  if (view === "mobile") {
    return (
      <BuyMobileClient catalogItems={catalogItems} paymentMode={paymentMode} brand={brand} metaPixelId={metaPixelId} initialSearch={sp} />
    );
  }
  return (
    <BuyWorkspaceClient
      catalogItems={catalogItems}
      paymentMode={paymentMode}
      initialTierId={pick.tier ?? undefined}
      initialSeats={pick.seats ?? undefined}
      initialBilling={sp.billing === "monthly" ? "monthly" : undefined}
      openBuy={pick.openBuy}
      initialCoupon={pick.coupon ?? undefined}
      metaPixelId={metaPixelId}
      brand={brand}
    />
  );
}
