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
 * R-027 (5 Oct 2026): the QA check timed out (20 s) on the test service. Measured: 8–10 s on
 * a freshly started instance (staging right after a push, the idle test service), 0.2–0.8 s
 * once warm. The page then ran its two database reads ONE AFTER THE OTHER with no limit, so a
 * cold connection paid twice. They now run together, each capped at 3 s: a slow read shows
 * the "contact us" grid or quote-only checkout instead of hanging the page.
 */
import { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { parseBuyParams } from "@/lib/checkout/buy-link";
import { isPublicPriceHidden } from "@/lib/catalog/public-price-policy";
import { simulatedPaymentAllowed } from "@/lib/checkout/live-guards";
import { checkoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { PARTNER_LINE } from "@/site/lib/config";
import { websiteTenantId } from "@/lib/website-tenant";
import { fetchBuyBrand } from "./_parts/fetch-brand";

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

async function fetchGoogleWorkspaceItems(): Promise<CatalogItem[]> {
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) {
    console.error("[buy/workspace] BUY_PAGE_TENANT_ID is not set — set it in .env.local to your local workspace id (R-1499).");
    return [];
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("items")
    .select("id, name, msrp, wholesale, margin_pct, prices, is_active")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("vendor", "google")
    .eq("kind",   "main")
    .eq("is_active", true)
    .ilike("name", "Google Workspace%")
    .order("msrp", { ascending: true })
    .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));

  if (error) {
    console.error("[buy/workspace] catalog fetch failed:", error);
    return [];
  }
  return ((data ?? []) as CatalogItem[]).map(publicBuyRow);
}

/**
 * What of a catalogue row may reach the visitor's browser (these props are serialised into the
 * page). R-328: Business Plus keeps its card but carries NO price ("Contact us for pricing").
 * Wholesale and margin are our cost — the client never reads them, so they never leave.
 */
function publicBuyRow(row: CatalogItem): CatalogItem {
  const hidden = isPublicPriceHidden(row.name);
  const strip = (t?: { msrp: number; wholesale: number }) => (t ? { msrp: hidden ? 0 : t.msrp, wholesale: 0 } : undefined);
  return {
    ...row,
    msrp: hidden ? 0 : row.msrp,
    wholesale: 0,
    margin_pct: null,
    prices: hidden ? {} : { ...(row.prices?.annual ? { annual: strip(row.prices.annual) } : {}), ...(row.prices?.monthly ? { monthly: strip(row.prices.monthly) } : {}) },
  };
}

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
  const pick = parseBuyParams(await props.searchParams);
  // Both reads at once (R-027) — each is capped, so the page waits at most ~3 s, not the sum.
  const [catalogItems, { configured, keyId }, brand] = await Promise.all([fetchGoogleWorkspaceItems(), isRazorpayConfigured(), fetchBuyBrand()]);
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
  return (
    <BuyWorkspaceClient
      catalogItems={catalogItems}
      paymentMode={paymentMode}
      initialTierId={pick.tier ?? undefined}
      initialSeats={pick.seats ?? undefined}
      openBuy={pick.openBuy}
      initialCoupon={pick.coupon ?? undefined}
      brand={brand}
    />
  );
}
