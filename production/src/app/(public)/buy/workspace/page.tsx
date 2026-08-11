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
 */
import { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const metadata: Metadata = {
  title: "Buy Google Workspace · ResellerOS",
  description: "Google Workspace pricing for India. Annual GST invoice, hand-held migration, Hindi + English support. Premier Partner since 2014.",
};

// Don't cache for the SSR — Pardeep needs price/enablement edits in the
// catalog to reflect on the buy page within seconds.
export const dynamic = "force-dynamic";

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
    .order("msrp", { ascending: true });

  if (error) {
    console.error("[buy/workspace] catalog fetch failed:", error);
    return [];
  }
  return (data ?? []) as CatalogItem[];
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

export default async function BuyWorkspacePage() {
  const catalogItems = await fetchGoogleWorkspaceItems();
  // Live when Razorpay is fully configured. When it isn't:
  //  · non-prod (or ALLOW_SIMULATED_CHECKOUT=1) → "simulation": Buy now stays
  //    visible for Pardeep to walk the full pipeline, clearly TEST-MODE banded.
  //  · production without that flag → "disabled": the online-buy CTA is hidden
  //    so a REAL customer never sees a "Simulate payment" button on a public
  //    storefront before Razorpay go-live. They get "Get a GST quote" instead.
  const configured = await isRazorpayConfigured();
  const allowSim =
    process.env.ALLOW_SIMULATED_CHECKOUT === "1" ||
    process.env.NODE_ENV !== "production";
  const paymentMode: "live" | "simulation" | "disabled" = configured
    ? "live"
    : allowSim
      ? "simulation"
      : "disabled";
  return (
    <BuyWorkspaceClient
      catalogItems={catalogItems}
      paymentMode={paymentMode}
    />
  );
}
