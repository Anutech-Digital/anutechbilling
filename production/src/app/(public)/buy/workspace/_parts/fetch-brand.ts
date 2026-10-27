/**
 * R-1970 / R-1975: the company the buy page and its thanks page sell as — the website tenant's
 * own row (name, logo, GSTIN, address, state, phone). Server only. A failed or slow read shows a
 * neutral header, never another company's name. Moved here from page.tsx so the thanks page
 * reads the same brand (until R-1975 it had a letter "R" and a typed company name).
 */
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { brandFromTenant, type BuyBrand } from "./brand";

const READ_TIMEOUT_MS = 3_000;

/* One read per request (React cache): generateMetadata (the tab title "Buy Google Workspace ·
   <tenant>") and the page share it — two parallel reads on a cold connection could let one time
   out and leave the title without the tenant name while the header had it. */
export const fetchBuyBrand = cache(readBuyBrand);

async function readBuyBrand(): Promise<BuyBrand | null> {
  const tenantId = websiteTenantId();
  if (!tenantId) return null;
  try {
    const { data, error } = await createAdminClient()
      .from("tenants")
      .select("name, logo_url, gstin, address, pin_code, state, state_code, phone, email")
      .eq("id", tenantId)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) { console.warn("[buy/workspace] tenant brand read failed:", error.message); return null; }
    return brandFromTenant(data);
  } catch {
    return null;
  }
}
