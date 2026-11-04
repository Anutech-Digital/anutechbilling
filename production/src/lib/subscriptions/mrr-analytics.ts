/**
 * MRR / ARR and margin by product line, from the subscriptions table as it actually is.
 *
 * Rewritten 2 Oct 2026 (Pardeep: "theek karke push"). The first version read columns the
 * database does not have (subscriptions.quantity, items.category) — the endpoint answered
 * every call with a 500 that printed the Postgres error — and it re-priced each
 * subscription from the catalogue MSRP, treating half-yearly and quarterly as monthly.
 *
 * What it reads now:
 *   · revenue  = subscriptions.mrr — the monthly figure stored on the subscription, the
 *                same number the Customers page totals. Not re-derived from a list price:
 *                a customer's agreed price is not the catalogue's.
 *   · cost     = vendor_cost_per_seat_month × seats, when the vendor sync has filled it.
 *                Nothing else in the database states a per-month cost reliably, so a
 *                subscription without it is counted in `cost_unknown`, and margin is
 *                computed only over subscriptions whose cost IS known — never a guess.
 *   · line     = subscriptions.vendor (google / microsoft / zoho / hosting / domain / …).
 * Whole rupees throughout (AGENTS.md rule 1).
 */

import { isRecurringSub, recurringMrr } from "@/lib/subscriptions/mrr-of";

export type Vendor = "google" | "microsoft" | "zoho" | "hosting" | "domain" | "support" | "other";

export interface SubscriptionRow {
  id: string;
  status: string;
  vendor: string | null;
  seats: number | null;
  /** Stored monthly revenue, whole rupees. */
  mrr: number | null;
  /** From the vendor sync; null = not known. */
  vendor_cost_per_seat_month: number | null;
  /** R-2229: read by mrrOf — a one-time or no-term row is not MRR. */
  plan?: string | null;
  term_months?: number | null;
}

export interface LineAnalytics {
  label: string;
  active_subscriptions: number;
  seats: number;
  mrr_rupees: number;
  /** Subscriptions in this line whose cost is known. */
  costed_subscriptions: number;
  monthly_cost_rupees: number;
  /** Margin over the costed subscriptions only; null when none is costed. */
  margin_percentage: number | null;
}

export interface MrrAnalytics {
  total_active_subscriptions: number;
  total_mrr_rupees: number;
  total_arr_rupees: number;
  /** Active subscriptions with no vendor cost on file — left out of the margin. */
  cost_unknown: number;
  total_monthly_cost_rupees: number;
  overall_margin_percentage: number | null;
  by_line: Record<Vendor, LineAnalytics>;
}

const LABEL: Record<Vendor, string> = {
  google: "Google Workspace",
  microsoft: "Microsoft 365",
  zoho: "Zoho",
  hosting: "Hosting",
  domain: "Domains",
  support: "Support",
  other: "Other",
};

const pct = (profit: number, revenue: number) => (revenue > 0 ? Number(((profit / revenue) * 100).toFixed(2)) : null);

export function computeMrrAnalytics(rows: readonly SubscriptionRow[]): MrrAnalytics {
  const vendors = Object.keys(LABEL) as Vendor[];
  const by_line = Object.fromEntries(vendors.map((v) => [v, {
    label: LABEL[v], active_subscriptions: 0, seats: 0, mrr_rupees: 0,
    costed_subscriptions: 0, monthly_cost_rupees: 0, margin_percentage: null,
  } as LineAnalytics])) as Record<Vendor, LineAnalytics>;
  const costedMrr: Partial<Record<Vendor, number>> = {};

  let active = 0, mrr = 0, cost = 0, costedRevenue = 0, unknown = 0;
  for (const r of rows) {
    /* R-2229: the one MRR rule (lib/subscriptions/mrr-of) — active AND recurring. */
    if (r.status !== "active" || !isRecurringSub(r)) continue;
    const v: Vendor = r.vendor && r.vendor in LABEL ? (r.vendor as Vendor) : "other";
    const line = by_line[v];
    const m = recurringMrr(r);
    const seats = Math.max(0, r.seats ?? 0);
    active++; mrr += m;
    line.active_subscriptions++; line.seats += seats; line.mrr_rupees += m;
    if (r.vendor_cost_per_seat_month == null) { unknown++; continue; }
    const c = Math.round(r.vendor_cost_per_seat_month * seats);
    cost += c; costedRevenue += m;
    line.costed_subscriptions++; line.monthly_cost_rupees += c;
    costedMrr[v] = (costedMrr[v] ?? 0) + m;
  }
  for (const v of vendors) {
    const line = by_line[v];
    const rev = costedMrr[v] ?? 0;
    line.margin_percentage = line.costed_subscriptions > 0 ? pct(rev - line.monthly_cost_rupees, rev) : null;
  }

  return {
    total_active_subscriptions: active,
    total_mrr_rupees: mrr,
    total_arr_rupees: mrr * 12,
    cost_unknown: unknown,
    total_monthly_cost_rupees: cost,
    overall_margin_percentage: pct(costedRevenue - cost, costedRevenue),
    by_line,
  };
}
