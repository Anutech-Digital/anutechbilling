/**
 * R-1929 (G-ONBOARD OB-8) — who the AI agents sign as.
 *
 * The sales and support agents wrote every reply as the platform company: the seller name was
 * `process.env.SELLER_LEGAL_NAME || <platform legal name>` and the support desk
 * `process.env.SUPPORT_EMAIL || <platform support address>`, read once per module. A second
 * reseller's customer therefore got mail signed by somebody else's company, and was asked to
 * reply to somebody else's support desk.
 *
 * Now both come from the TENANT ROW the message belongs to (`tenants.name`, `tenants.email`).
 * The env values stay only for the platform tenant (the buy-page / storefront tenant), whose
 * agents keep signing exactly as before; the platform's own constants are the last fallback
 * for that one tenant only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStorefrontTenant, storefrontSupportEmail } from "@/lib/email/storefront-voice";
import { PLATFORM_OPERATOR } from "@/lib/platform";

type Env = Record<string, string | undefined>;

export interface SellerIdentity {
  /** The trading name the agent signs as. */
  sellerName: string;
  /** The support desk a customer is pointed at ("" when the tenant has none). */
  supportEmail: string;
}

export interface SellerTenantRow {
  name?: string | null;
  email?: string | null;
}

/** Used only when a reseller's tenant row cannot be read — never another company's name. */
export const UNKNOWN_SELLER_NAME = "our team";

/** Pure: the identity for one tenant, from its row (and env only for the platform tenant). */
export function pickSellerIdentity(
  tenantId: string | null | undefined,
  row: SellerTenantRow | null | undefined,
  env: Env = process.env,
): SellerIdentity {
  const rowName = row?.name?.trim() || "";
  const rowEmail = row?.email?.trim() || "";
  if (isStorefrontTenant(tenantId, env)) {
    return {
      sellerName: env.SELLER_LEGAL_NAME?.trim() || rowName || PLATFORM_OPERATOR.legalName,
      supportEmail: storefrontSupportEmail(env),
    };
  }
  return { sellerName: rowName || UNKNOWN_SELLER_NAME, supportEmail: rowEmail };
}

/**
 * A per-request lookup: reads `tenants (name, email)` once per tenant id and remembers it, so a
 * cron looping over many leads of one tenant does one read. A failed read falls back as above.
 */
export function sellerIdentityLookup(
  admin: SupabaseClient,
  env: Env = process.env,
): (tenantId: string | null | undefined) => Promise<SellerIdentity> {
  const seen = new Map<string, Promise<SellerIdentity>>();
  return (tenantId) => {
    if (!tenantId) return Promise.resolve(pickSellerIdentity(tenantId, null, env));
    let hit = seen.get(tenantId);
    if (!hit) {
      hit = (async () => {
        try {
          const { data, error } = await admin.from("tenants").select("name, email").eq("id", tenantId).maybeSingle();
          if (error) console.warn(`[seller-identity] tenants read failed for ${tenantId}: ${error.message}`);
          return pickSellerIdentity(tenantId, (data as SellerTenantRow | null) ?? null, env);
        } catch (e) {
          console.warn(`[seller-identity] tenants read threw for ${tenantId}: ${(e as Error).message}`);
          return pickSellerIdentity(tenantId, null, env);
        }
      })();
      seen.set(tenantId, hit);
    }
    return hit;
  };
}

/** One-shot form for a route that handles a single tenant. */
export function loadSellerIdentity(
  admin: SupabaseClient,
  tenantId: string | null | undefined,
  env: Env = process.env,
): Promise<SellerIdentity> {
  return sellerIdentityLookup(admin, env)(tenantId);
}
