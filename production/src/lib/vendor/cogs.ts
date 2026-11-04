/**
 * What a subscription actually COSTS us, and how sure we are.
 *
 * ─── THIS REPLACES `mrr × 0.83` ─────────────────────────────────────────────
 * The subscriptions list computed cost as `Math.round(s.mrr * 0.83)` under a comment
 * reading "Heuristic: ~17% margin on typical reseller subs". Every subscription in
 * the app therefore showed a 17% margin — not because it earned 17%, but because the
 * number was defined to be 17%. It sorted, it coloured a badge, it fed a KPI tile,
 * and it was a constant wearing a measurement's clothes.
 *
 * That was the fifth copy of that guess found in this codebase. The others were in
 * the quote builder (×0.7), the quotes list (×0.83), the add-subscription dialog
 * (×0.83) and the invoices page (×0.17).
 *
 * ─── THREE SOURCES, IN ORDER OF TRUTH ───────────────────────────────────────
 *   vendor    what the vendor actually billed us (subscriptions.vendor_cost_*).
 *             The only figure that is a fact rather than an expectation.
 *   catalog   items.wholesale via subscriptions.item_id — the agreed price list.
 *             Right almost always; wrong exactly when a promo ends or an account
 *             falls out of a volume band, which is the case worth catching.
 *   unknown   no catalogue row and no vendor bill. Reported as unknown, never as a
 *             number, because a made-up cost produces a made-up margin and a rep
 *             discounts against it.
 */
import type { Item, Subscription } from "@/lib/supabase/database.types";

export type CogsSource = "vendor" | "catalog" | "unknown";

export interface SubscriptionCogs {
  source: CogsSource;
  /** ₹/seat/month we pay. Null when unknown. */
  perSeatMonth: number | null;
  /** ₹/month for the whole subscription. Null when unknown. */
  monthlyCost: number | null;
  /** Gross margin ₹/month. Null when cost is unknown. */
  marginMonthly: number | null;
  /** Basis points — 1750 = 17.50%. Null when unknown or there is no revenue. */
  marginBps: number | null;
  /** Why this figure is what it is, for a tooltip. */
  note: string;
}

type CogsFields = Pick<Subscription,
  "seats" | "mrr" | "item_id" | "vendor_cost_per_seat_month" | "vendor_synced_at">
  & Partial<Pick<Subscription, "term_months">>;

/**
 * Resolve cost and margin.
 *
 * Seats drive the cost, not `used`: we pay the vendor for what is provisioned,
 * whether or not anybody logged in.
 */
export function subscriptionCogs(sub: CogsFields, catalog: readonly Item[]): SubscriptionCogs {
  const seats = Math.max(0, Math.trunc(sub.seats ?? 0));
  const mrr = Math.max(0, Math.round(sub.mrr ?? 0));

  const vendorRate = sub.vendor_cost_per_seat_month;
  if (vendorRate != null && vendorRate >= 0) {
    return build("vendor", vendorRate, seats, mrr,
      sub.vendor_synced_at
        ? `From the vendor's own bill, last confirmed ${sub.vendor_synced_at.slice(0, 10)}.`
        : "From the vendor's own bill.");
  }

  const item = sub.item_id ? catalog.find((c) => c.id === sub.item_id) : undefined;
  /* The annual tier is the reseller's normal buying price; monthly is the fallback,
     and the legacy `wholesale` column the last resort. Zero is treated as absent —
     a ₹0 wholesale is a blank field, not a free product.
     R-2095: a Flexible (monthly) subscription (term_months 1) is bought on the Flexible
     tier, so that tier comes first for it — the same rule as catalogCostPerSeatMonth. */
  const flexible = sub.term_months != null && sub.term_months <= 1;
  const catalogRate = flexible
    ? item?.prices?.monthly?.wholesale || item?.prices?.annual?.wholesale || item?.wholesale || null
    : item?.prices?.annual?.wholesale ||
      item?.prices?.monthly?.wholesale ||
      item?.wholesale ||
      null;

  if (catalogRate) {
    return build("catalog", catalogRate, seats, mrr,
      "From your catalogue price list. Reconcile against a vendor bill to confirm it.");
  }

  return {
    source: "unknown",
    perSeatMonth: null,
    monthlyCost: null,
    marginMonthly: null,
    marginBps: null,
    note: sub.item_id
      ? "This plan's catalogue row has no wholesale price, so margin cannot be worked out."
      : "This plan is not linked to a catalogue row, so what it costs is unknown.",
  };
}

function build(source: CogsSource, perSeatMonth: number, seats: number, mrr: number, note: string): SubscriptionCogs {
  const monthlyCost = perSeatMonth * seats;
  const marginMonthly = mrr - monthlyCost;
  return {
    source,
    perSeatMonth,
    monthlyCost,
    marginMonthly,
    /* Basis points, and null on zero revenue: 0% margin on a ₹0 subscription is a
       statement about nothing and renders identically to a genuine 0% deal. */
    marginBps: mrr > 0 ? Math.round((marginMonthly / mrr) * 10_000) : null,
    note,
  };
}

/** Badge text and tone for a subscription row. */
export function cogsBadge(c: SubscriptionCogs): { label: string; kind: "success" | "warning" | "danger" | "muted"; title: string } {
  if (c.marginBps == null) {
    return { label: "Unknown", kind: "muted", title: c.note };
  }
  const pct = c.marginBps / 100;
  const kind = pct < 0 ? "danger" : pct < 14 ? "danger" : pct < 18 ? "warning" : "success";
  return {
    label: `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`,
    kind,
    /* The source is in the tooltip on purpose. A catalogue figure and a vendor-billed
       figure look identical on screen and are not equally trustworthy. */
    title: c.note,
  };
}

/** Roll up, excluding what cannot be known rather than counting it as zero cost. */
export function cogsTotals(rows: readonly SubscriptionCogs[]): {
  monthlyCost: number;
  marginMonthly: number;
  knownCount: number;
  unknownCount: number;
  /** How many of the known rows are only catalogue estimates, not vendor-confirmed. */
  estimatedCount: number;
} {
  let monthlyCost = 0, marginMonthly = 0, knownCount = 0, unknownCount = 0, estimatedCount = 0;
  for (const r of rows) {
    if (r.source === "unknown" || r.monthlyCost == null) { unknownCount++; continue; }
    knownCount++;
    if (r.source === "catalog") estimatedCount++;
    monthlyCost += r.monthlyCost;
    marginMonthly += r.marginMonthly ?? 0;
  }
  return { monthlyCost, marginMonthly, knownCount, unknownCount, estimatedCount };
}
