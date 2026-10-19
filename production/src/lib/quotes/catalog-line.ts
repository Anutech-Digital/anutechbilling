/**
 * A catalogue row → a ₹ quote line, the one way every adder prices it (2 Oct 2026).
 *
 * The Add-item dialog, the lead's one-tap product chips and the "+ Support" toggle all add
 * catalogue items; three copies of this arithmetic is how the yearly support plan came to be
 * a ₹0 line in one of them. Storage is ₹/seat/YEAR (QuoteLineItem.rate), commitment annual.
 *
 *  - prices.annual_total → a whole-year total, used verbatim (yearly-discount plans)
 *  - else the annual tier, then the monthly tier, then msrp — × 12 for a per-month unit
 *
 * R-526 (9 Oct 2026): the ×12 applies only to a PER-MONTH unit (lib/catalog/billing-unit.ts).
 * A per-year row (domain registration) is its price once a year; a one-time row (migration)
 * is its price once, on a line with no commitment — never ×12, never "Annual".
 *
 * Foreign-currency pricing stays in the dialog; this is the ₹ path.
 */
import { billingUnitOf, defaultQtyForUnit, unitYearMultiplier, type BillingUnit } from "@/lib/catalog/billing-unit";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";
import { headlinePrice } from "@/lib/catalog/headline-price";
import { storedLineRate } from "./line-rate-unit";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

type PriceTier = { msrp?: number; wholesale?: number } | undefined;

/**
 * R-387 (7 Oct 2026): the Add-item dialog passed the RAW row here while the quote chips passed a
 * floored one, so GW Standard was ₹736 by one path and ₹1,080 by the other. The floor now lives
 * here, the one place every adder prices through — a row whose name is a GW tier and whose price
 * is under the list price (lib/catalog/workspace-floor) is lifted; anything else is untouched.
 */
export function catalogYearlyPrice(
  raw: Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null; vendor?: string | null; item_type?: string | null },
): { rate: number; cost: number } {
  return catalogPrice(raw, true);
}

/**
 * R-1668: the catalogue price charged ONCE per unit — for a line with no commitment
 * (One-time). The row's stored price as it stands, never × 12; a yearly-total plan is its total.
 */
export function catalogOncePrice(
  raw: Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null; vendor?: string | null; item_type?: string | null },
): { rate: number; cost: number } {
  return catalogPrice(raw, false);
}

function catalogPrice(
  raw: Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null; vendor?: string | null; item_type?: string | null },
  perYear: boolean,
): { rate: number; cost: number } {
  const it = raw.name ? floorWorkspaceRow({ ...raw, name: raw.name }) : raw;
  const prices = (it.prices ?? null) as { annual_total?: PriceTier; annual?: PriceTier; monthly?: PriceTier } | null;
  const total = prices?.annual_total;
  if (total && typeof total.msrp === "number" && total.msrp > 0 && !(it.msrp > 0)) {
    return { rate: total.msrp, cost: total.wholesale ?? 0 };
  }
  const mult = perYear ? unitYearMultiplier(billingUnitOf(raw)) : 1;
  const msrpPerUnit      = prices?.annual?.msrp      ?? prices?.monthly?.msrp      ?? it.msrp;
  const wholesalePerUnit = prices?.annual?.wholesale ?? prices?.monthly?.wholesale ?? it.wholesale;
  return { rate: msrpPerUnit * mult, cost: (wholesalePerUnit ?? 0) * mult };
}

/** The commitment a new line of this unit carries: none (one-time) or the annual tier. */
export function commitmentForUnit(unit: BillingUnit): QuoteLineItem["commitment"] {
  return unit === "one_time" ? undefined : "annual_yearly";
}

/**
 * `opts.qty` is the deal's SEAT count (the quote's seats chip) — it applies to per-seat items
 * only. A domain, a support plan or a migration is one, whatever the seat count (R-526).
 */
export function lineFromCatalog(
  it: Pick<Item, "id" | "name" | "vendor" | "msrp" | "wholesale" | "prices"> & { item_type?: string | null },
  opts: { qty?: number } = {},
): QuoteLineItem {
  const { rate, cost } = catalogYearlyPrice(it);
  const unit = billingUnitOf(it);
  const commitment = commitmentForUnit(unit);
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `line-${Date.now()}`,
    item_id: it.id,
    name: it.name,
    qty: defaultQtyForUnit(unit, opts.qty),
    rate,
    cost,
    /* R-1688: a one-time item carries the explicit marker (never a subscription). */
    ...(commitment ? { commitment } : { one_time: true }),
  };
}

/**
 * The list rate + cost a catalogue-linked line stores for its commitment — what the quote
 * builder re-prices a line to when the catalogue (re)loads or the currency changes.
 * `usd` is the item's real USD tier and the exchange rate, when the quote bills on it.
 */
export function catalogLineListRate(
  it: Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null; vendor?: string | null; item_type?: string | null },
  commitment: QuoteLineItem["commitment"] | null | undefined,
  usd?: { msrp: number; wholesale: number; fx: number } | null,
): { rate: number; cost: number } {
  /* R-1668: no commitment = a ONE-TIME line (R-389 — record_payment files no subscription
     for it). It is charged the catalogue price once per unit. This used to read a missing
     commitment as "annual_yearly", so a migration set to One-time stayed ₹199 × 12 = ₹2,388
     a seat, and every catalogue reload put the ×12 back. */
  if (!commitment) {
    if (usd && usd.msrp > 0) {
      return { rate: Math.round(usd.msrp * usd.fx), cost: Math.round(usd.wholesale * usd.fx) };
    }
    return catalogOncePrice(it);
  }
  const lineCommitment = commitment;
  if (usd && usd.msrp > 0) {
    return {
      rate: storedLineRate(usd.msrp * usd.fx, lineCommitment),
      cost: storedLineRate(usd.wholesale * usd.fx, lineCommitment),
    };
  }
  if (headlinePrice(it).unit === "yr" || unitYearMultiplier(billingUnitOf(it)) !== 12) {
    /* A yearly-total plan (support "(Yearly)", msrp 0). msrp × 12 here re-priced it
       to ₹0 the moment this effect re-ran (2 Oct 2026).
       R-526: and any row priced per YEAR or ONCE (domain registration, migration) —
       the tier branch below would ×12 it again every time the catalogue loads. */
    const p = catalogYearlyPrice(it);
    const perMonthLine = lineCommitment === "monthly";
    return { rate: perMonthLine ? Math.round(p.rate / 12) : p.rate, cost: perMonthLine ? Math.round(p.cost / 12) : p.cost };
  }
  const prices = (it.prices ?? null) as { annual?: PriceTier; monthly?: PriceTier } | null;
  const tier = prices?.[lineCommitment === "monthly" ? "monthly" : "annual"];
  return {
    rate: storedLineRate(tier?.msrp ?? it.msrp, lineCommitment),
    cost: storedLineRate(tier?.wholesale ?? it.wholesale, lineCommitment),
  };
}
