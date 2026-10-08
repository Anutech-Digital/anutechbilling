/**
 * A catalogue row → a ₹ quote line, the one way every adder prices it (2 Oct 2026).
 *
 * The Add-item dialog, the lead's one-tap product chips and the "+ Support" toggle all add
 * catalogue items; three copies of this arithmetic is how the yearly support plan came to be
 * a ₹0 line in one of them. Storage is ₹/seat/YEAR (QuoteLineItem.rate), commitment annual.
 *
 *  - prices.annual_total → a whole-year total, used verbatim (yearly-discount plans)
 *  - else the annual tier, then the monthly tier, then msrp — all ₹/month — × 12
 *
 * Foreign-currency pricing stays in the dialog; this is the ₹ path.
 */
import { catalogDefaultQty } from "@/lib/quotes/line-items";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

type PriceTier = { msrp?: number; wholesale?: number } | undefined;

/**
 * R-387 (7 Oct 2026): the Add-item dialog passed the RAW row here while the quote chips passed a
 * floored one, so GW Standard was ₹736 by one path and ₹1,080 by the other. The floor now lives
 * here, the one place every adder prices through — a row whose name is a GW tier and whose price
 * is under the list price (lib/catalog/workspace-floor) is lifted; anything else is untouched.
 */
export function catalogYearlyPrice(
  raw: Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null },
): { rate: number; cost: number } {
  const it = raw.name ? floorWorkspaceRow({ ...raw, name: raw.name }) : raw;
  const prices = (it.prices ?? null) as { annual_total?: PriceTier; annual?: PriceTier; monthly?: PriceTier } | null;
  const total = prices?.annual_total;
  if (total && typeof total.msrp === "number" && total.msrp > 0 && !(it.msrp > 0)) {
    return { rate: total.msrp, cost: total.wholesale ?? 0 };
  }
  const msrpPerMo      = prices?.annual?.msrp      ?? prices?.monthly?.msrp      ?? it.msrp;
  const wholesalePerMo = prices?.annual?.wholesale ?? prices?.monthly?.wholesale ?? it.wholesale;
  return { rate: msrpPerMo * 12, cost: (wholesalePerMo ?? 0) * 12 };
}

export function lineFromCatalog(
  it: Pick<Item, "id" | "name" | "vendor" | "msrp" | "wholesale" | "prices">,
  opts: { qty?: number } = {},
): QuoteLineItem {
  const { rate, cost } = catalogYearlyPrice(it);
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `line-${Date.now()}`,
    item_id: it.id,
    name: it.name,
    qty: opts.qty && opts.qty > 0 ? opts.qty : catalogDefaultQty(it.vendor),
    rate,
    cost,
    commitment: "annual_yearly",
  };
}
