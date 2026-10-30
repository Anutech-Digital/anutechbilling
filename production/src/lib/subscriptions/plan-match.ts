/**
 * Matching a subscription's `plan` text to a catalog row, so its cost can be read.
 *
 * ─── WHY THIS FILE EXISTS (measured, not guessed) ────────────────────────────
 * There is no foreign key from `subscriptions` to `items`. The only link is the plan
 * TEXT, and the app writes that text from a hardcoded list in
 * add-subscription-dialog.tsx:34 which does not use the catalog at all. So there are
 * two product vocabularies, and on 14 Aug 2026 only 6 of the dialog's 29 products
 * matched a catalog row by exact name:
 *
 *     dialog writes                            catalog has                    exact?
 *     Google Workspace Business Starter        Google Workspace Business Starter  yes
 *     Google Workspace Business Standard       Google Workspace Standard          NO
 *     Google Workspace Business Plus           Google Workspace Plus              NO
 *     Microsoft 365 Business Basic/Std/Prem    same                               yes
 *     Zoho Workplace Standard / Professional   same                               yes
 *
 * The two that fail are the highest-volume Google plans. A margin detector on exact
 * names would therefore have been silent on exactly the subscriptions worth watching,
 * while looking like it worked.
 *
 * ─── WHAT THIS DOES, AND THE ONE RULE THAT KEEPS IT HONEST ───────────────────
 * `planKey()` normalises a name: lowercase, punctuation out, whitespace collapsed,
 * and the filler word "business" dropped — that single word is the whole difference
 * between "Google Workspace Business Standard" and "Google Workspace Standard".
 *
 * THE RULE: the SAME function is applied to both sides. Nothing here maps one
 * specific product onto another. There is no alias table, because an alias table is
 * a place to quietly assert that two differently-named products cost the same, and
 * that assertion would be invisible in a margin figure someone acts on.
 *
 * ─── WHAT IT DELIBERATELY REFUSES TO MATCH ──────────────────────────────────
 * The dialog offers Enterprise Starter, Enterprise Standard and Enterprise Plus; the
 * catalog has ONE row, "Google Workspace Enterprise" (₹2,050). Mapping three products
 * onto one price would put a made-up cost behind a real margin number, so those stay
 * unmatched and are REPORTED as unmatched. A missing cost is a visible gap; a wrong
 * cost is a number someone trusts.
 *
 * Likewise, if two catalog rows ever normalise to the same key with different costs,
 * the key is marked ambiguous and matches nothing. Picking one would be a coin toss
 * with money attached.
 */

/** Filler words that differ between the two vocabularies without changing the product. */
const FILLER = new Set(["business"]);

/**
 * R-2095 (staging, 30 Oct): the Onboard dialog's paid path named the line — and so the
 * subscription — "<plan> (2 seats)". The plan is the catalogue name; old rows are read without it.
 */
export function catalogPlanName(plan: string | null | undefined): string {
  return String(plan ?? "").replace(/\s*\(\s*\d+\s*seats?\s*\)\s*$/i, "").trim();
}

/**
 * A comparable key for a product name. Applied to BOTH the subscription's plan text
 * and the catalog row's name — never to only one side.
 */
export function planKey(name: string | null | undefined): string {
  if (!name) return "";
  return catalogPlanName(name)   // R-2095: an old "(N seats)" suffix is not part of the product
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")   // punctuation, "(", "&", "-" all become spaces
    .split(" ")
    .filter((w) => w.length > 0 && !FILLER.has(w))
    .join(" ");
}

export interface CatalogRow {
  name:   string;
  vendor: string;
  /** ₹/seat/month wholesale. */
  costPerSeatMonth: number;
}

export interface PlanIndex {
  /** vendor|key -> cost, only for keys that resolve unambiguously. */
  costs: Map<string, number>;
  /** Keys that two catalog rows disagree on. Matched as "unmatched", never guessed. */
  ambiguous: Set<string>;
}

const indexKey = (vendor: string, name: string) => `${vendor.toLowerCase()}|${planKey(name)}`;

/**
 * Build the lookup. Two rows normalising to the same key with the SAME cost is
 * harmless (a duplicate); with different costs it is ambiguous and matches nothing.
 */
export function buildPlanIndex(rows: readonly CatalogRow[]): PlanIndex {
  const costs = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const row of rows) {
    const k = indexKey(row.vendor, row.name);
    if (k.endsWith("|")) continue;               // an unnamed catalog row indexes nothing
    const existing = costs.get(k);
    if (existing !== undefined && existing !== row.costPerSeatMonth) {
      ambiguous.add(k);
      continue;
    }
    costs.set(k, row.costPerSeatMonth);
  }

  for (const k of ambiguous) costs.delete(k);
  return { costs, ambiguous };
}

export type PlanMatch =
  | { matched: true;  costPerSeatMonth: number }
  | { matched: false; reason: "no_such_plan" | "ambiguous" };

/** Look up a subscription's cost. Never returns a cost it had to guess at. */
export function matchPlan(
  index: PlanIndex,
  vendor: string | null | undefined,
  plan: string | null | undefined,
): PlanMatch {
  const k = indexKey(vendor ?? "", plan ?? "");
  if (index.ambiguous.has(k)) return { matched: false, reason: "ambiguous" };
  const cost = index.costs.get(k);
  if (cost === undefined) return { matched: false, reason: "no_such_plan" };
  return { matched: true, costPerSeatMonth: cost };
}

/* ── The same problem, on the RETAIL side ──────────────────────────────────────
   Everything above resolves a plan's COST. The Google importer and the reconcile
   report need its PRICE, and both were doing their own exact-name lookup:

       m.set(it.name.trim().toLowerCase(), it.msrp)
       priceMap.get(sku.trim().toLowerCase())

   Measured 24 Sep 2026, on four real subscriptions. Google's export says
   "Google Workspace Business Starter"; the catalogue row is named
   "Google Workspace Starter". One word apart, exact match fails, price resolves to
   ZERO — so Accesstel, Chandan Trading, FF Impex and Harvestal were all imported at
   ₹0/month. The billing drawer then says "No MRR on this subscription, so there is
   nothing to schedule", which is true and reads as a missing feature.

   The COST lookup had matched them all along, because it goes through `planKey` and
   that drops the filler word "business". So one half of the margin was found and the
   other was not: the subscriptions show a margin of −₹220, meaning the app believes we
   pay the vendor and charge the customer nothing.

   Two lookups for one question, normalising differently, is the whole defect. This is
   the price side of `buildPlanIndex`, deliberately the same shape and the same guard. */

/** Retail price index: vendor|key → ₹/seat/month, only where it is unambiguous. */
export interface PlanPriceIndex {
  prices: Map<string, number>;
  /** Keys two catalogue rows disagree on. Matched as unmatched, never averaged. */
  ambiguous: Set<string>;
}

export interface CatalogPriceRow {
  name: string;
  vendor: string;
  /** ₹/seat/month list price. */
  msrpPerSeatMonth: number | null | undefined;
}

export function buildPlanPriceIndex(rows: readonly CatalogPriceRow[]): PlanPriceIndex {
  const prices = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const row of rows) {
    const k = indexKey(row.vendor, row.name);
    if (k.endsWith("|")) continue;                 // an unnamed row indexes nothing
    /* A row with no price is NOT a ₹0 product — it is a row nobody has priced. Indexing
       it as 0 is the failure this whole file exists to avoid: a confident wrong number
       where a visible gap belongs. */
    if (row.msrpPerSeatMonth == null) continue;
    const existing = prices.get(k);
    if (existing !== undefined && existing !== row.msrpPerSeatMonth) {
      ambiguous.add(k);
      continue;
    }
    prices.set(k, row.msrpPerSeatMonth);
  }

  for (const k of ambiguous) prices.delete(k);
  return { prices, ambiguous };
}

/**
 * ₹/seat/month for a plan name, or null when it cannot be resolved.
 *
 * Null, not 0 — the caller decides how to present "we do not know what this costs",
 * and every one of them must be able to tell that apart from "this is free".
 */
export function matchPlanPrice(
  index: PlanPriceIndex,
  vendor: string | null | undefined,
  plan: string | null | undefined,
): number | null {
  const k = indexKey(vendor ?? "", plan ?? "");
  if (index.ambiguous.has(k)) return null;
  return index.prices.get(k) ?? null;
}
