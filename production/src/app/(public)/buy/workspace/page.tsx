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

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const metadata: Metadata = {
  title: { absolute: "Buy Google Workspace · Anutech Digital" },
  description: "Google Workspace pricing for India. Annual GST invoice, hand-held migration, Hindi + English support. Premier Partner since 2014.",
};

// Don't cache for the SSR — Pardeep needs price/enablement edits in the
// catalog to reflect on the buy page within seconds.
export const dynamic = "force-dynamic";

const READ_TIMEOUT_MS = 3_000;

async function fetchGoogleWorkspaceItems(): Promise<CatalogItem[]> {
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
async function isRazorpayConfigured(): Promise<boolean> {
  // Per-tenant first
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret")
      .eq("tenant_id", BUY_PAGE_TENANT_ID)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (data?.razorpay_key_id && data.razorpay_key_secret) return true;
  } catch { /* fall through to env */ }

  const keyId =
    process.env.RAZORPAY_KEY_ID?.trim() ||
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() ||
    "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
  return Boolean(keyId) && Boolean(keySecret);
}

export default async function BuyWorkspacePage(props: {
  /* R-120: ?tier=&seats=&buy=1 from the home edition card — open on that edition, ready to pay. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pick = parseBuyParams(await props.searchParams);
  // Both reads at once (R-027) — each is capped, so the page waits at most ~3 s, not the sum.
  const [catalogItems, configured] = await Promise.all([fetchGoogleWorkspaceItems(), isRazorpayConfigured()]);
  // Live when Razorpay is fully configured. When it isn't:
  //  · non-prod (or ALLOW_SIMULATED_CHECKOUT=1) → "simulation": Buy now stays
  //    visible for Pardeep to walk the full pipeline, clearly TEST-MODE banded.
  //  · production without that flag → "disabled": the online-buy CTA is hidden
  //    so a REAL customer never sees a "Simulate payment" button on a public
  //    storefront before Razorpay go-live. They get "Get a GST quote" instead.
  // R-079: never on a production deployment, whatever ALLOW_SIMULATED_CHECKOUT says — same gate as the route.
  const allowSim = simulatedPaymentAllowed();
  const paymentMode: "live" | "simulation" | "disabled" = configured
    ? "live"
    : allowSim
      ? "simulation"
      : "disabled";
  return (
    <BuyWorkspaceClient
      catalogItems={catalogItems}
      paymentMode={paymentMode}
      initialTierId={pick.tier ?? undefined}
      initialSeats={pick.seats ?? undefined}
      openBuy={pick.openBuy}
    />
  );
}
