/**
 * R-387 (7 Oct 2026) — a lead's "Interested plan" is priced from the tenant's catalogue, the
 * same row and the same arithmetic a quote uses.
 *
 * Found in the Kapoor money test: Add lead prefilled Google Workspace Standard at ₹1,080/seat/mo
 * from a hard-coded map, while Quote → Add item → From catalog showed the same product at ₹736
 * (the old seed row). One product, two prices, depending on which screen you started from.
 *
 * Now: catalogue first (via catalogYearlyPrice, which applies the R-205 list-price floor), so the
 * lead and the quote cannot disagree. The add-lead form's own map is a FALLBACK only, for plans
 * this tenant has no catalogue row for — and the answer says so (`source: "list"`), so the form
 * can label it instead of passing it off as the catalogue price.
 */
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import { workspaceTierOf } from "@/lib/catalog/workspace-floor";
import type { Item } from "@/lib/supabase/database.types";

export type PlanPriceSource = "catalog" | "list";

export interface PlanPrice {
  /** ₹ per seat per month (whole rupees), annual commitment. */
  perSeatPm: number;
  source:    PlanPriceSource;
  /** The catalogue row it came from (source "catalog" only). */
  itemId?:   string;
}

type CatalogRow = Pick<Item, "id" | "name" | "msrp" | "wholesale" | "prices"> & {
  item_type?: string | null;
  is_active?: boolean | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The catalogue row a plan name means: the exact name first, then — for Google Workspace only —
 * the same tier under the catalogue's own wording ("Google Workspace Starter" vs "… Business
 * Starter"). Support plans, one-time products and inactive rows never stand in for a licence.
 */
export function catalogRowForPlan<T extends CatalogRow>(plan: string, items: readonly T[] | null | undefined): T | undefined {
  const rows = (items ?? []).filter(
    (r) => r.item_type !== "one_time" && r.is_active !== false && !/support/i.test(r.name ?? ""),
  );
  const want = norm(plan);
  if (!want) return undefined;
  const exact = rows.find((r) => norm(r.name) === want);
  if (exact) return exact;
  const tier = workspaceTierOf(plan);
  if (!tier) return undefined;
  return rows.find((r) => workspaceTierOf(r.name) === tier);
}

/**
 * ₹/seat/month for a plan: the catalogue price when the tenant sells it, else the fallback list
 * price (labelled), else undefined (Custom / Mixed, or a plan nobody priced). Never invents one.
 */
export function planPricePerSeat(
  plan: string,
  items: readonly CatalogRow[] | null | undefined,
  fallback: Readonly<Record<string, number>>,
): PlanPrice | undefined {
  const row = catalogRowForPlan(plan, items);
  if (row) {
    const perSeatPm = Math.round(catalogYearlyPrice(row).rate / 12);
    if (perSeatPm > 0) return { perSeatPm, source: "catalog", itemId: row.id };
  }
  const list = fallback[plan];
  return typeof list === "number" && list > 0 ? { perSeatPm: list, source: "list" } : undefined;
}
