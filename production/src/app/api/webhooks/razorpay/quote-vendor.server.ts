/**
 * Which vendor a paid quote is for, and which of its lines are domains — read by the capture
 * settlement in webhook.server.ts. Moved out of it (max-lines) when R-1596 made that
 * settlement shared with POST /api/public/checkout/verify.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import type { ProvisioningVendor } from "@/lib/provisioning/provisioning";

/**
 * Which vendor's console these seats live in, read off the plan name.
 *
 * By NAME and not by an items lookup, deliberately: `quotes.plan` is the text COPY made at the
 * time of sale, and the catalogue row it came from may have been renamed since — that is the
 * defect `create-renewal-quote.ts` was fixed for on 24 Aug. Here the plan text is the right
 * source precisely because it records what was sold, and `other` is a safe landing: it queues
 * with "activated in the vendor's own console" rather than guessing at an API.
 */
export function vendorFromPlan(plan: string | null | undefined): ProvisioningVendor {
  const p = (plan ?? "").toLowerCase();
  if (p.includes("google") || p.includes("workspace")) return "google";
  if (p.includes("microsoft") || p.includes("365")) return "microsoft";
  if (p.includes("zoho")) return "zoho";
  if (p.includes("hosting") || p.includes("cpanel")) return "hosting";
  if (p.includes("domain")) return "domain";
  return "other";
}

/**
 * The vendor of what was actually sold, read from the CATALOGUE rather than
 * guessed from the plan's wording.
 *
 * `vendorFromPlan` above is a string match, and merge brick #4 made that matter:
 * hosting tiers synced from the engine are named "Starter", "Standard", "Plus"
 * — no word in them says hosting, so a paid Starter order would have been filed
 * as `other` and told the desk to go to a vendor console that does not exist.
 * The item row knows the truth (`items.vendor`, set by sync_hosting_catalog /
 * sync_domain_catalog), so the item is asked first and the wording is only a
 * fallback for hand-typed lines. Same reasoning as record_payment, which resolves
 * vendor by item_id and only name-guesses when there is no item.
 */
export async function vendorForQuote(
  db: ReturnType<typeof createAdminClient>,
  lineItems: unknown,
  plan: string | null | undefined,
): Promise<ProvisioningVendor> {
  const ids = Array.isArray(lineItems)
    ? lineItems
        .map((l) => (l && typeof l === "object" ? (l as { item_id?: unknown }).item_id : null))
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) return vendorFromPlan(plan);

  const { data } = await db.from("items").select("vendor").in("id", ids);
  const vendors = (data ?? [])
    .map((r) => (r as { vendor?: string | null }).vendor)
    .filter((v): v is string => !!v);

  /* An engine vendor anywhere in the quote decides it: a domain or a hosting
     account still has to be provisioned even when a licence rides along, and
     those are the lines that need the engine. */
  if (vendors.includes("domain")) return "domain";
  if (vendors.includes("hosting")) return "hosting";
  const first = vendors[0];
  if (first === "google" || first === "microsoft" || first === "zoho") return first;
  return vendorFromPlan(plan);
}

/**
 * The quote's catalogue items that are domains (3 Oct 2026). A line linked to one of these
 * is a domain sale; a line linked to any other item (a Workspace plan) only NAMES a domain,
 * and must not be registered or given a domain subscription. See isDomainPurchaseLine.
 */
export async function domainItemIdsForQuote(
  db: ReturnType<typeof createAdminClient>,
  lineItems: unknown,
): Promise<Set<string>> {
  const ids = Array.isArray(lineItems)
    ? lineItems
        .map((l) => (l && typeof l === "object" ? (l as { item_id?: unknown }).item_id : null))
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) return new Set();
  const { data } = await db.from("items").select("id, vendor").in("id", ids);
  return new Set(
    (data ?? []).filter((r) => (r as { vendor?: string | null }).vendor === "domain").map((r) => (r as { id: string }).id),
  );
}
