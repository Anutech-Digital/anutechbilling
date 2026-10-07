/**
 * R-364 — the catalogue row for a support plan, built in one place so the quote
 * builder's "Add to catalog" writes exactly what the seed migration writes
 * (supabase/migrations/20260817160000_support_tier_skus.sql + 20260817190000).
 *
 * ─── WHY THE ID CARRIES THE TENANT ──────────────────────────────────────────
 * `findSupportSku` looks rows up by prefix (`SUP-STANDARD-YR-…`). A tenant created
 * after the seed ran never got the rows, so the quote builder said "Not in your
 * catalogue yet" with no way forward. Building the same id here means the row the
 * button creates is found by the same lookup, and clicking twice cannot duplicate it
 * (the primary key refuses the second insert).
 *
 * ─── THE PRICE IS PASSED IN, NEVER INVENTED ─────────────────────────────────
 * The dialog prefills it from SUPPORT_TIERS — the one definition the seed used — and
 * the operator may change it. Whatever they save is what the quote line uses
 * (`supportLineRate`), so the card, the catalogue and the quote say one number.
 */
import type { Database, Item } from "@/lib/supabase/database.types";
import { canOpenRoute } from "@/lib/nav";
import { supportPrice, supportSkuId, type SupportTier } from "./tiers";

type ItemInsert = Database["public"]["Tables"]["items"]["Insert"];
type Cycle = "monthly" | "yearly";

/** Catalogue id for this tenant's row: `SUP-STANDARD-YR-<tenant uuid without dashes>`. */
export function supportCatalogId(tier: SupportTier, cycle: Cycle, tenantId: string): string {
  return `${supportSkuId(tier.id, cycle)}-${tenantId.replace(/-/g, "")}`;
}

/**
 * Who sees "Add to catalog": the roles that can open Products (/items —
 * owner and manager), so the button never offers a write the catalogue page itself
 * does not. Unlike canWriteMoney, an unknown role (still loading) is NO: a button
 * that appears and then vanishes is worse than one that appears a moment late.
 */
export function canEditSupportCatalog(role: string | null | undefined): boolean {
  return !!role && canOpenRoute(role, "/items");
}

/** The name the seed migration gives the row — branded with the reseller's own name. */
export function supportCatalogName(tier: SupportTier, cycle: Cycle, tenantName: string | null | undefined): string {
  const brand = (tenantName ?? "").trim();
  const base = brand ? `${brand} ${tier.label} Support` : `Support ${tier.label}`;
  return cycle === "yearly" ? `${base} (Yearly)` : brand ? base : `${base} (Monthly)`;
}

/** The price the app already knows for this plan (SUPPORT_TIERS) — the dialog's prefill. */
export function knownSupportPrice(tier: SupportTier, cycle: Cycle): number | null {
  const p = supportPrice(tier, cycle);
  return Number.isInteger(p) && p > 0 ? p : null;
}

/** A price the dialog may save: a whole rupee above zero. Anything else blocks Save. */
export function isValidSupportPrice(raw: string): boolean {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * The insert for the row — WITHOUT tenant_id: `useCreateItem` stamps the caller's own
 * tenant, and RLS (items_insert: tenant_id = current_tenant_id()) refuses any other.
 *
 * Monthly stores the price in `msrp`; yearly stores a whole-year TOTAL in
 * `prices.annual_total`, exactly like the seed (see tiers.ts on why a discounted year
 * is not a monthly rate).
 */
export function supportCatalogRow(args: {
  tier: SupportTier;
  cycle: Cycle;
  tenantId: string;
  name: string;
  price: number;
}): Omit<ItemInsert, "tenant_id"> {
  const { tier, cycle, tenantId, name, price } = args;
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new Error("A support plan needs a price in whole rupees above zero.");
  }
  if (tier.id === "free") throw new Error("The free plan is not sold on a quote.");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A support plan needs a name.");
  return {
    id:              supportCatalogId(tier, cycle, tenantId),
    name:            trimmed,
    vendor:          "support",
    hsn:             "998313",
    msrp:            cycle === "monthly" ? price : 0,
    wholesale:       0,
    is_active:       true,
    item_type:       "subscription",
    kind:            "main",
    covered_product: "all",
    prices:          cycle === "yearly" ? { annual_total: { msrp: price, wholesale: 0 } } : {},
  } as Omit<ItemInsert, "tenant_id">;
}

/** The price a catalogue row holds for one term on this cycle, or null when it holds none. */
export function supportRowPrice(row: Pick<Item, "msrp" | "prices">, cycle: Cycle): number | null {
  const p = cycle === "yearly"
    ? (row.prices as { annual_total?: { msrp?: number } } | null)?.annual_total?.msrp
    : row.msrp;
  return typeof p === "number" && Number.isInteger(p) && p > 0 ? p : null;
}

/**
 * The rate a quote line carries for this plan, in the unit its commitment implies
 * (R-369, lib/quotes/line-rate-unit.ts): a yearly plan is an `annual_yearly` line, so
 * its rate is the YEAR; a monthly plan is a `monthly` (flex) line, so its rate is one
 * MONTH — the unit the PDF, e-mail, accept page and record_payment MRR all read. This
 * used to return `term * 12`, which billed a ₹999/month plan as ₹11,988 "each month".
 * The catalogue row's own price wins, so a price typed in "Add to catalog" is the price
 * quoted; a row with no price falls back to the tier definition.
 */
export function supportLineRate(
  row: Pick<Item, "msrp" | "prices"> | null,
  tier: SupportTier,
  cycle: Cycle,
): number {
  const own = row ? supportRowPrice(row, cycle) : null;
  return own ?? supportPrice(tier, cycle);
}
