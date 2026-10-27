/**
 * Single source of truth for Google Workspace storefront pricing.
 *
 * Both the public checkout (`/api/public/checkout/workspace`) and the public
 * enquiry/auto-quote (`/api/public/enquiry/workspace`) MUST price a given
 * (tier, seats) identically — otherwise "Buy now" and "Get a quote" quote the
 * same product at different prices (audit bug #10/#11). They now both call
 * `buildWorkspaceLines()` here.
 *
 * Pricing model (confirmed with Pardeep, 2026-05-30):
 *   - `items.msrp` / `prices.annual.msrp` IS the RETAIL price the customer pays
 *     (₹/user/MONTH on annual commitment). The catalog is the source of truth.
 *   - NO hardcoded tier promos. Discounts go through the coupon / site-promo
 *     system (redeem_coupon / create_site_promo), not baked into pricing.
 *
 * The fallback table is defence-in-depth only (used if the catalog row is
 * missing, e.g. a SKU disabled mid-session) and is kept in sync with the
 * seeded catalog defaults.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type WorkspaceTierId = "starter" | "standard" | "plus" | "enterprise";

/**
 * Last-resort ₹/user/month — used only on catalog-miss. Kept in sync with the
 * live catalogue (annual): Starter 270, Standard 1,080, Plus 1,500 (R-1970, Pardeep 26 Oct; was 1,380). R-157 (5 Oct 2026):
 * Standard was 864 — an old 20%-off promo price that no longer exists, so a catalogue miss
 * would have charged 20% less than every page shows. Enterprise has no list price; online
 * checkout refuses it (quote only) and the enquiry route never auto-quotes it.
 */
export const TIER_FALLBACK_MONTHLY: Record<WorkspaceTierId, number> = {
  starter:    270,
  standard:   1080,
  plus:       1500,
  enterprise: 2400,
};

export const TIER_DISPLAY_NAME: Record<WorkspaceTierId, string> = {
  starter:    "Business Starter",
  standard:   "Business Standard",
  plus:       "Business Plus",
  enterprise: "Enterprise",
};

export interface WorkspaceQuoteLine {
  id:         string;
  name:       string;
  qty:        number;
  rate:       number;            // ₹/seat/YEAR (monthly MSRP × 12)
  cost:       number;            // wholesale ₹/seat/year (0 if unknown from buy page)
  commitment: "annual_yearly";
}

export interface CatalogPriceRow {
  id:        string;
  name:      string;
  msrp:      number;
  wholesale: number | null;
  prices: {
    annual?:  { msrp: number; wholesale: number };
    monthly?: { msrp: number; wholesale: number };
  } | null;
}

export interface WorkspaceLines {
  items:       WorkspaceQuoteLine[];
  subtotal:    number;   // ₹ ex-GST (annual)
  amount:      number;   // ₹ incl 18% GST
  tierName:    string;
  monthlyMsrp: number;   // ₹/user/month (retail)
  monthlyCost: number;   // ₹/user/month (wholesale, 0 if unknown)
}

/**
 * Fetch the catalog row for a tier from a specific tenant's catalog.
 * Substring match on the full SKU name ("Google Workspace Business Standard").
 */
export async function fetchWorkspaceCatalogPrice(
  admin: SupabaseClient<Database>,
  tenantId: string,
  tierId: string,
): Promise<CatalogPriceRow | null> {
  const namePart =
    tierId === "starter"    ? "Starter"    :
    tierId === "standard"   ? "Standard"   :
    tierId === "plus"       ? "Plus"       :
    tierId === "enterprise" ? "Enterprise" : null;
  if (!namePart) return null;

  const { data, error } = await admin
    .from("items")
    .select("id, name, msrp, wholesale, prices")
    .eq("tenant_id", tenantId)
    .eq("vendor",    "google")
    .eq("kind",      "main")
    .eq("is_active", true)
    .ilike("name", `Google Workspace ${namePart}%`)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[pricing/workspace] catalog lookup failed:", error);
    return null;
  }
  return (data as CatalogPriceRow | null) ?? null;
}

/** Resolve ₹/user/month retail MSRP. Source of truth = catalog; fallback as backstop. */
export function resolveMonthlyMsrp(row: CatalogPriceRow | null, tierId: string): number {
  if (row) {
    const annualMonthly = row.prices?.annual?.msrp;
    if (Number.isFinite(annualMonthly) && (annualMonthly ?? 0) > 0) return annualMonthly!;
    if (Number.isFinite(row.msrp) && row.msrp > 0) return row.msrp;
  }
  return TIER_FALLBACK_MONTHLY[tierId as WorkspaceTierId] ?? 0;
}

/** Resolve ₹/user/month wholesale (cost). 0 if unknown. */
export function resolveMonthlyCost(row: CatalogPriceRow | null): number {
  if (row) {
    const annualWholesale = row.prices?.annual?.wholesale;
    if (Number.isFinite(annualWholesale) && (annualWholesale ?? 0) > 0) return annualWholesale!;
    if (Number.isFinite(row.wholesale ?? NaN) && (row.wholesale ?? 0) > 0) return row.wholesale!;
  }
  return 0;
}

/**
 * THE canonical pricing function — compose quote line items + GST-inclusive
 * total for (catalog row, tier, seats). Both checkout and enquiry call this so
 * the same tier+seats always yields the same price.
 */
export function buildWorkspaceLines(
  row: CatalogPriceRow | null,
  tierId: string,
  seats: number,
): WorkspaceLines {
  const monthlyMsrp = resolveMonthlyMsrp(row, tierId);
  const monthlyCost = resolveMonthlyCost(row);
  const rate     = monthlyMsrp * 12;   // ₹/seat/year
  const cost     = monthlyCost * 12;
  const tierName = row?.name?.replace(/^Google Workspace\s*/i, "")
                || TIER_DISPLAY_NAME[tierId as WorkspaceTierId]
                || "Workspace";
  const items: WorkspaceQuoteLine[] = monthlyMsrp > 0 ? [{
    id:         globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
    name:       row?.name ?? `Google Workspace · ${tierName} (annual)`,
    qty:        seats,
    rate,
    cost,
    commitment: "annual_yearly",
  }] : [];
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const amount   = Math.round(subtotal * 1.18);   // 18% GST
  return { items, subtotal, amount, tierName, monthlyMsrp, monthlyCost };
}

/* ── FLEX (pay-as-you-go) — Pardeep ka model, uske apne shabdon me ───────────
   "flex pricing me monthly commitment wala rate aata hai … isme 12 invoices wala koi
   chakkar nahi, ye pay-as-you-go ke hisab se banta hai." (31 Aug 2026)

   To flex ki line PER SEAT PER MONTH hoti hai (prices.monthly.msrp — aaj ₹325), quote ka
   subtotal EK MAHINE ka hai, aur kahin ×12 NAHI hota. Yahi model email-enquiry ka raasta
   pehle se follow karta hai (lib/quotes/quote-from-enquiry.ts ka flex slab); ye function
   wahi cheez buy-page/website ke raaste ko deta hai, taaki dono ek hi tarah ka document
   banayen.

   NULL jab flex daam catalogue me hai hi nahi. Fallback annual se NAHI banta — annual
   rate ko mahine ka keh dena wahi 12×-class ki galti hai jiski keemat ye app de chuka
   hai. Daam nahi to draft rukta hai, gadhta nahi. */

export interface WorkspaceFlexLine {
  id:         string;
  name:       string;
  qty:        number;
  rate:       number;            // ₹/seat/MONTH (prices.monthly.msrp)
  cost:       number;            // wholesale ₹/seat/month (0 if unknown)
  commitment: "monthly";
}

export interface WorkspaceFlexLines {
  items:    WorkspaceFlexLine[];
  subtotal: number;   // ₹ ex-GST, PER MONTH
  amount:   number;   // ₹ incl 18% GST, PER MONTH
  tierName: string;
}

export function buildWorkspaceFlexLines(
  row: CatalogPriceRow | null,
  tierId: string,
  seats: number,
): WorkspaceFlexLines | null {
  const flex = row?.prices?.monthly;
  if (!flex || !Number.isFinite(flex.msrp) || flex.msrp <= 0) return null;

  const tierName = row?.name?.replace(/^Google Workspace\s*/i, "")
                || TIER_DISPLAY_NAME[tierId as WorkspaceTierId]
                || "Workspace";
  const items: WorkspaceFlexLine[] = [{
    id:         globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
    name:       row?.name ?? `Google Workspace · ${tierName} (flexible)`,
    qty:        seats,
    rate:       flex.msrp,
    cost:       Number.isFinite(flex.wholesale) && flex.wholesale > 0 ? flex.wholesale : 0,
    commitment: "monthly",
  }];
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  return { items, subtotal, amount: Math.round(subtotal * 1.18), tierName };
}
