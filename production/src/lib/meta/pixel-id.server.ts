/**
 * R-1979: the website tenant's Meta Pixel id for the public pages (server only), or null.
 * One read per request (React cache). A failed read means "no pixel" — the page never breaks.
 * The id is not secret (it is in the page's script); the CAPI token is never read here.
 */
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { cleanPixelId } from "./pixel-ids";

type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- column newer than the generated types

export const websitePixelId = cache(async (): Promise<string | null> => {
  const tenantId = websiteTenantId();
  if (!tenantId) return null;
  try {
    const { data } = await (createAdminClient() as unknown as Loose)
      .from("tenant_secrets")
      .select("meta_pixel_id")
      .eq("tenant_id", tenantId)
      .abortSignal(AbortSignal.timeout(2_000))
      .maybeSingle();
    return cleanPixelId((data as { meta_pixel_id?: string | null } | null)?.meta_pixel_id);
  } catch {
    return null;
  }
});
