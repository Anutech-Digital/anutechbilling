/**
 * Public shareable enquiry form — /enquiry
 *
 * A lightweight "tell us your requirement" form that anyone can open or embed
 * (?embed=1). On submit it POSTs to /api/public/enquiry/general which creates a
 * lead (source='enquiry-form') in the reseller's pipeline and emails both sides.
 *
 * This is the page the lead-gen "Public capture form" Share dialog points at.
 * Unlike /buy/workspace (a priced storefront), this is a simple contact/requirement
 * form — the reseller reads the requirement and follows up manually.
 *
 * Server-side we resolve the reseller's real business name from the `tenants`
 * table so the form is branded correctly (no hardcoded company name).
 *
 * R-028 (5 Oct 2026): the page timed out (20 s) in the QA check. Measured: the FIRST request
 * after the service sat idle took 8–11 s on staging and the test service, the next one
 * 0.1–0.8 s — a cold instance plus an uncapped database read on every request. The read is
 * now capped at 3 s (a slow database shows the form with a generic name instead of hanging
 * the page) and kept for 10 minutes per instance, so only the first visitor of an instance
 * pays for it. The cold start itself is the service's min-instances setting, not this page.
 */
import { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { EnquiryClient } from "./enquiry-client";
import { websiteTenantId } from "@/lib/website-tenant";

/* R-1499: tenant read per call (websiteTenantId) — outside production an unset BUY_PAGE_TENANT_ID
   shows nothing (and logs why), never the live tenant's data. */

export const metadata: Metadata = {
  title: "Get in touch · Send us your requirement",
  description: "Tell us what you need — Google Workspace, Microsoft 365, Zoho or something else — and we'll get back to you with a quote.",
};

export const dynamic = "force-dynamic";

type Brand = { name: string; phone: string | null; logoUrl: string | null };
const FALLBACK: Brand = { name: "Us", phone: null, logoUrl: null };
const BRAND_TTL_MS = 10 * 60 * 1000;
const BRAND_TIMEOUT_MS = 3_000;
let brandCache: { brand: Brand; at: number } | null = null;

async function fetchBrand(): Promise<Brand> {
  if (brandCache && Date.now() - brandCache.at < BRAND_TTL_MS) return brandCache.brand;
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) return FALLBACK;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("tenants")
      .select("name, phone, logo_url")
      .eq("id", BUY_PAGE_TENANT_ID)
      .abortSignal(AbortSignal.timeout(BRAND_TIMEOUT_MS))
      .maybeSingle();
    if (error || !data) {
      // Not cached: a failed or timed-out read is retried by the next visitor.
      if (error) console.warn("[enquiry] brand read failed, showing the generic form:", error.message);
      return FALLBACK;
    }
    const brand: Brand = { name: data.name ?? "Us", phone: data.phone ?? null, logoUrl: data.logo_url ?? null };
    brandCache = { brand, at: Date.now() };
    return brand;
  } catch {
    return FALLBACK;
  }
}

export default async function EnquiryPage() {
  const brand = await fetchBrand();
  return <EnquiryClient brandName={brand.name} brandPhone={brand.phone} brandLogoUrl={brand.logoUrl} />;
}
