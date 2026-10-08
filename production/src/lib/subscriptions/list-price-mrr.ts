/**
 * List-price MRR for a subscription that arrived with no price — R-317 (7 Oct 2026).
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Local DB, 7 Oct: the Anutech tenant had 155 active subscriptions, 146 of them
 * imported (no quote), and 145 of those had mrr = 0. Reports showed MRR ₹3,560 and
 * ₹22 per customer. Two causes:
 *
 *   1. The Google importer built its price map keyed `vendor|planKey` (that is how
 *      buildPlanPriceIndex keys it) and then looked rows up by bare `planKey(sku)`.
 *      The keys never met, so EVERY Google import wrote mrr 0 while the preview's
 *      "MRR (est.)" column showed "—".
 *   2. Rows created with a plan of just "Google Workspace" — no edition, one seat.
 *      Nobody knows what those are billed at.
 *
 * Pardeep's decision (7 Oct): (b) where the edition IS known, MRR = the catalogue's
 * list price × seats; (c) where it is NOT, MRR stays 0 and those rows are COUNTED and
 * shown, so the gap is visible and fixable. Never guess an edition.
 *
 * ─── WHAT COUNTS AS "KNOWN" ─────────────────────────────────────────────────
 * In order, first hit wins:
 *   1. item_id   → that catalogue row.
 *   2. plan text → a catalogue row with the same planKey (same rule as plan-match.ts).
 *   3. Google only: the plan text names exactly ONE Workspace edition
 *      (Starter / Standard / Plus / Enterprise) and nothing else besides filler
 *      ("Google", "Workspace", "Business", "annual"…). "Enterprise Standard" names two
 *      and is refused; "Google Voice Standard" names a different product and is refused;
 *      bare "Google Workspace" names none and is refused.
 * Two catalogue rows that disagree on the price → refused (ambiguous), never averaged.
 *
 * Prices are READ from the catalogue (items), never written here. Unit, per
 * catalog-options.ts: items.msrp and prices.annual.msrp are ₹/seat/MONTH;
 * prices.annual_total.msrp is a YEAR total and is divided by 12.
 */
import { planKey } from "./plan-match";

export interface ListPriceItem {
  id: string;
  name: string;
  vendor: string;
  kind?: string | null;
  msrp: number | null;
  prices?: unknown;
  is_active?: boolean | null;
}

export interface ListPriceSub {
  vendor: string | null | undefined;
  plan: string | null | undefined;
  seats: number | null | undefined;
  item_id?: string | null;
}

export type ListPriceResult =
  | { ok: true; mrr: number; itemId: string; via: "item_id" | "name" | "edition" }
  | { ok: false; reason: "no_seats" | "unknown_edition" | "no_catalog_price" | "ambiguous" };

export const WORKSPACE_EDITIONS = ["starter", "standard", "plus", "enterprise"] as const;
export type WorkspaceEdition = (typeof WORKSPACE_EDITIONS)[number];

/** Words that say nothing about WHICH edition it is. */
const FILLER = new Set([
  "google", "workspace", "gsuite", "g", "suite", "business",
  "annual", "yearly", "monthly", "flexible", "flex", "plan", "commitment", "edition", "subscription",
]);

/**
 * The single Workspace edition a plan text names, or null. Null when it names none,
 * more than one, or anything that is not filler — that is "unknown", not a guess.
 */
export function workspaceEdition(plan: string | null | undefined): WorkspaceEdition | null {
  const words = planKey(plan).split(" ").filter((w) => w && !FILLER.has(w));
  if (words.length !== 1) return null;
  const w = words[0];
  return (WORKSPACE_EDITIONS as readonly string[]).includes(w) ? (w as WorkspaceEdition) : null;
}

/**
 * MRR for `seats` seats of a catalogue row at LIST price, whole rupees, or null when
 * the row carries no usable price.
 */
export function itemListMrr(item: ListPriceItem, seats: number): number | null {
  const p = (item.prices ?? null) as { annual?: { msrp?: unknown }; annual_total?: { msrp?: unknown } } | null;
  const monthly = typeof p?.annual?.msrp === "number" && p.annual.msrp > 0 ? p.annual.msrp
    : typeof item.msrp === "number" && item.msrp > 0 ? item.msrp
    : null;
  if (monthly !== null) return Math.round(monthly * seats);
  const yearTotal = p?.annual_total?.msrp;
  if (typeof yearTotal === "number" && yearTotal > 0) return Math.round((yearTotal * seats) / 12);
  return null;
}

/** One price from candidate rows, or why not. Rows priced alike are a duplicate, not a clash. */
function pick(cands: ListPriceItem[], seats: number, via: "name" | "edition"): ListPriceResult | null {
  if (cands.length === 0) return null;
  const priced = cands
    .map((it) => ({ it, mrr: itemListMrr(it, seats) }))
    .filter((x): x is { it: ListPriceItem; mrr: number } => x.mrr !== null);
  if (priced.length === 0) return { ok: false, reason: "no_catalog_price" };
  if (new Set(priced.map((x) => x.mrr)).size > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, mrr: priced[0].mrr, itemId: priced[0].it.id, via };
}

/** List-price MRR for one subscription, or the reason it is not known. */
export function listPriceMrr(catalog: readonly ListPriceItem[], sub: ListPriceSub): ListPriceResult {
  const seats = Math.round(Number(sub.seats) || 0);
  if (seats <= 0) return { ok: false, reason: "no_seats" };
  const live = catalog.filter((it) => it.is_active !== false);

  if (sub.item_id) {
    const it = live.find((x) => x.id === sub.item_id);
    if (it) {
      const mrr = itemListMrr(it, seats);
      return mrr === null ? { ok: false, reason: "no_catalog_price" } : { ok: true, mrr, itemId: it.id, via: "item_id" };
    }
  }

  const vendor = (sub.vendor ?? "").toLowerCase();
  const key = planKey(sub.plan);
  if (key) {
    const byName = pick(live.filter((it) => it.vendor.toLowerCase() === vendor && planKey(it.name) === key), seats, "name");
    if (byName) return byName;
  }

  if (vendor !== "google") return { ok: false, reason: "unknown_edition" };
  const edition = workspaceEdition(sub.plan);
  if (!edition) return { ok: false, reason: "unknown_edition" };
  const byEdition = pick(
    live.filter((it) => it.vendor.toLowerCase() === "google" && it.kind !== "addon" && workspaceEdition(it.name) === edition),
    seats,
    "edition",
  );
  return byEdition ?? { ok: false, reason: "no_catalog_price" };
}

/**
 * Rows from an importer, with `estMrr` set from the list price wherever it is known
 * and 0 where it is not. Used by the Google importer, whose file carries no price.
 */
export function withListPriceMrr<T extends { plan: string; seats: number; estMrr: number }>(
  rows: readonly T[], catalog: readonly ListPriceItem[], vendor: string,
): T[] {
  return rows.map((r) => {
    const res = listPriceMrr(catalog, { vendor, plan: r.plan, seats: r.seats });
    return { ...r, estMrr: res.ok ? res.mrr : 0 };
  });
}

/** An active subscription with no price on it — MRR is undercounted by it. */
export function hasNoPrice(s: { status: string; mrr: number | null }): boolean {
  return s.status === "active" && !((s.mrr ?? 0) > 0);
}
