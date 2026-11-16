/**
 * R-2736 — a renewal quote line's COST comes from the catalogue, always (owner decision 13 Nov 2026,
 * "prices to catalogue se hi lene hai"; recorded on the card).
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Localhost 14 Nov: renewal quote Q-F588-27-0156 (Google Workspace Business Standard, 20 seats) opened
 * with cost ₹0 / "Margin unknown" and went to the owner for approval (R-388), while the editor offered
 * "Use cost ₹7,440" from the catalogue right under the line. The renewal helper found the catalogue row
 * only by the subscription's item_id or by the EXACT plan name; that subscription had no item_id and its
 * catalogue row is called "E2E Google Workspace Business Standard". A domain renewal line was always
 * cost 0 ("our cost is not known here"), so every domain renewal needed approval too.
 *
 * ─── THE RULE ────────────────────────────────────────────────────────────────
 * PRICE is not touched here: the subscription's own term amount / MRR is the customer's agreed renewal
 * rate (money rule N4 — the MRR comes from the sold line's renewal rate), and a domain keeps ResellerClub's
 * live renewal price (owner, 25 Sep 2026). COST is the catalogue's:
 *   1. the subscription's item_id;
 *   2. else the one active row whose name IS the plan name (case and spaces ignored);
 *   3. else the one confident match — the same pick the editor's "Use cost ₹X" offers first
 *      (matchCatalogItemForPlan, and only if suggestCatalogMatches keeps it: never another tier).
 * The cost is the row's per-seat-month cost for the renewal's commitment — the volume slab for these
 * seats on the annual tier, the monthly tier for a one-month (Flexible) term, as the quote builder's own
 * cost fill reads it — × the term's months (so × years for 24 / 36), × seats for the line total. A name
 * / match pick stays inside the subscription's vendor. Nothing found, or the row has no ₹ wholesale → cost 0 = unknown
 * (approval-economics reads it as "cost unknown" and the approval stays). Never a guess, never an FX
 * conversion here (a USD-only wholesale stays unknown).
 */
import { catalogPlanName } from "@/lib/subscriptions/plan-match";
import { matchCatalogItemForPlan } from "@/lib/quotes/lead-plan-match";
import { suggestCatalogMatches } from "@/lib/quotes/typed-line-catalog-match";
import { catalogLineListRate, catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import { billingUnitOf, unitYearMultiplier } from "@/lib/catalog/billing-unit";
import { headlinePrice } from "@/lib/catalog/headline-price";
import { slabPricing } from "@/lib/quotes/volume-tiers";
import type { RenewalCost } from "./renewal-cost";

/** The catalogue columns the renewal paths read. */
export const RENEWAL_CATALOG_COLUMNS = "id, name, vendor, msrp, wholesale, prices, item_type, is_active" as const;

export interface RenewalCatalogRow {
  id?: string | null;
  name: string | null;
  vendor?: string | null;
  msrp?: number | null;
  wholesale?: number | null;
  prices?: unknown;
  item_type?: string | null;
  is_active?: boolean | null;
}

export type RenewalCatalogPick<T extends RenewalCatalogRow> = { row: T; how: "item_id" | "name" | "match" };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Words that say WHICH tier of a product (the quote matchers' list). */
const TIER_WORDS = new Set(["enterprise", "plus", "standard", "starter", "basic", "premium", "premier", "professional"]);
/** Words that make a row a different product from the plain licence (rev-r2736 F1). */
const QUALIFIER_WORDS = new Set(["archived", "archive", "flexible", "flex", "voice", "support"]);

function wordSet(s: string | null | undefined, from: ReadonlySet<string>): Set<string> {
  return new Set((s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => from.has(w)).map((w) => (w === "flex" ? "flexible" : w === "archive" ? "archived" : w)));
}
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Which catalogue row a renewal of `plan` is. `rows` = the tenant's items (any order). The item_id row
 * counts even when inactive (the subscription was sold from it); a name / match pick is from active rows
 * only, and only when exactly one row qualifies.
 */
export function pickRenewalCatalogItem<T extends RenewalCatalogRow>(
  rows: readonly T[],
  sub: { itemId?: string | null; plan: string | null | undefined; vendor?: string | null },
): RenewalCatalogPick<T> | null {
  if (sub.itemId) {
    const byId = rows.find((r) => r.id === sub.itemId);
    if (byId) return { row: byId, how: "item_id" };
  }
  /* A name / match pick stays inside the subscription's own vendor when it is known: a Zoho or
     hosting row that shares words with the plan is never a Workspace licence's cost. */
  const vendor = sub.vendor && sub.vendor !== "other" ? sub.vendor : null;
  const active = rows.filter((r) => r.is_active !== false && norm(r.name) !== "" && (!vendor || r.vendor === vendor));
  const plan = catalogPlanName(sub.plan ?? "");
  if (!norm(plan)) return null;

  const named = active.filter((r) => norm(r.name) === norm(plan));
  if (named.length === 1) return { row: named[0], how: "name" };
  if (named.length > 1) return null;   // two rows with one name: which cost is ours is not knowable

  /* rev-r2736 F1: a match is the SAME product line — its tier words (standard, plus, enterprise …) are
     exactly the plan's, and it carries a qualifier (archived, flexible, voice, support …) only when the
     plan says the same. "Business Standard" is never "Enterprise Standard", "Business Starter" never
     "… Starter Archived User", a plan with no tier never a Starter row. A support plan row is never a
     licence's cost (vendor support counts as the "support" qualifier). */
  const planTiers = wordSet(plan, TIER_WORDS);
  const planQualifiers = wordSet(plan, QUALIFIER_WORDS);
  const pool = active.filter((r) => {
    const q = wordSet(r.name, QUALIFIER_WORDS);
    if (r.vendor === "support") q.add("support");
    return sameSet(wordSet(r.name, TIER_WORDS), planTiers) && sameSet(q, planQualifiers);
  });
  const offered = suggestCatalogMatches(pool, plan, 10);
  /* matchCatalogItemForPlan takes the FIRST row containing the plan name; two such rows (a Flexible and
     an Annual copy) → which one's cost is ours is not knowable → no pick. */
  const p = norm(plan);
  if (offered.filter((r) => norm(r.name).includes(p) || p.includes(norm(r.name))).length > 1) return null;
  const confident = matchCatalogItemForPlan(offered, plan);
  return confident ? { row: confident, how: "match" } : null;
}

const unknown = (reason: string): RenewalCost => ({ perSeat: 0, total: 0, known: false, reason });

/**
 * Our cost for a renewal line from its catalogue row: per seat for the WHOLE term (the line's `cost`,
 * like its `rate`) and for the line. `termMonths` from renewalTerm (1 monthly, 12 / 24 / 36 annual).
 */
export function renewalCatalogCost(
  row: RenewalCatalogRow | null | undefined,
  input: { termMonths: number; seats: number },
): RenewalCost {
  const seats = Math.max(0, Math.trunc(input.seats ?? 0));
  const months = Math.max(0, Math.trunc(input.termMonths ?? 0));
  if (!row) return unknown("no catalogue item matches this plan");
  if (months <= 0) return unknown("the renewal term is not known, so the cost cannot be totalled");
  if (seats <= 0) return unknown("the subscription has no seat count");

  const it = pricingRow(row);
  /* renewalTerm's commitment: one month = the monthly (Flexible) tier; anything longer is the annual
     commitment, billed whole or in parts — its annual tier, per month × months. */
  const monthly = months === 1;
  let perSeatMonth: number;
  if (unitYearMultiplier(billingUnitOf(it)) === 12 && headlinePrice(it).unit !== "yr") {
    /* A per-month row: the quote builder's own cost fill (quote-builder.tsx fillUnknownCosts) — the
       volume slab for these seats on the annual tier, the monthly tier on a Flexible line. */
    const prices = it.prices as { monthly?: { wholesale?: number } } | null;
    perSeatMonth = monthly ? (prices?.monthly?.wholesale ?? it.wholesale) : slabPricing(it, seats).wholesalePerSeatMonth;
  } else {
    /* A row priced per year / as a yearly total (support "(Yearly)"): its year, per month. */
    const perYearOrMonth = catalogLineListRate(it, monthly ? "monthly" : "annual_yearly").cost;
    perSeatMonth = monthly ? perYearOrMonth : perYearOrMonth / 12;
  }
  if (!Number.isFinite(perSeatMonth) || perSeatMonth <= 0) return unknown("the catalogue has no wholesale price (₹) for this plan");

  const perSeat = Math.round(perSeatMonth * months);
  return { perSeat, total: perSeat * seats, known: true, reason: null };
}

/** The catalogue row in the shape the pricing helpers read (a null price column = 0 = not set). */
function pricingRow(row: RenewalCatalogRow) {
  return {
    msrp: row.msrp ?? 0, wholesale: row.wholesale ?? 0, prices: (row.prices ?? null) as never,
    name: row.name, vendor: row.vendor, item_type: row.item_type,
  };
}

/**
 * The catalogue row of a DOMAIN renewal: the subscription's item_id, else the ONE active Domain-vendor
 * row named for that extension (a name word equal to ".in" / ".co.in" — ".in" never matches ".co.in").
 */
export function pickDomainCatalogItem<T extends RenewalCatalogRow>(
  rows: readonly T[],
  sub: { itemId?: string | null; tld: string },
): RenewalCatalogPick<T> | null {
  if (sub.itemId) {
    const byId = rows.find((r) => r.id === sub.itemId);
    if (byId) return { row: byId, how: "item_id" };
  }
  if (!sub.tld.replace(/^\.+/, "")) return null;
  const tld = `.${sub.tld.replace(/^\.+/, "").toLowerCase()}`;
  /* rev-r2736 F4: a Transfer row is never a renewal's cost; with several rows for the extension the
     Renewal row wins, then the Registration row; anything still ambiguous → no pick. */
  const hits = rows.filter((r) =>
    r.vendor === "domain" && r.is_active !== false && !/\btransfer/i.test(r.name ?? "") &&
    (norm(r.name).split(" ").includes(tld) || norm(r.name) === tld.slice(1)));
  for (const pick of [/\brenew/i, /\bregist/i]) {
    const preferred = hits.filter((r) => pick.test(r.name ?? ""));
    if (preferred.length === 1) return { row: preferred[0], how: "name" };
    if (preferred.length > 1) return null;
  }
  return hits.length === 1 ? { row: hits[0], how: "name" } : null;
}

/**
 * Our cost for `years` of a domain renewal from its catalogue row — only for a row billed per YEAR
 * (R-526 billing unit); a row priced per month or with no unit set says nothing reliable about a year.
 */
export function domainRenewalCatalogCost(row: RenewalCatalogRow | null | undefined, years = 1): RenewalCost {
  if (!row) return unknown("no catalogue item for this domain extension");
  const it = pricingRow(row);
  if (billingUnitOf(it) !== "unit_year") return unknown("the domain's catalogue item is not priced per year");
  const perYear = catalogYearlyPrice(it).cost;
  if (!Number.isFinite(perYear) || perYear <= 0) return unknown("the domain's catalogue item has no wholesale price (₹)");
  const perSeat = Math.round(perYear * Math.max(1, Math.trunc(years)));
  return { perSeat, total: perSeat, known: true, reason: null };
}
