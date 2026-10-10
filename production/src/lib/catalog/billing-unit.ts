/**
 * R-526 (9 Oct 2026) — every catalogue row has ONE billing unit, and the quote prices by it.
 *
 * Found by the AI tester (Q-FBB9-27-0019): the quote treated every catalogue price as
 * "₹ per seat per month" and multiplied by 12. A domain registration (DOM-IN, ₹999) became
 * ₹11,988 a year, a one-time email migration (M365-EM, ₹199) became a ₹2,388 line with an
 * Annual commitment, and every item — domain, support, migration — started at 10 seats.
 *
 * The four units:
 *   seat_month  ₹ per seat per month   → line = price × 12 a year, qty = seats      (Workspace, M365, Zoho)
 *   unit_month  ₹ per unit per month   → line = price × 12 a year, qty = 1          (hosting, monthly support)
 *   unit_year   ₹ per unit per year    → line = price × 1 a year,  qty = 1          (domain registration, yearly support)
 *   one_time    ₹ once                 → line = price × 1, no commitment, qty = 1   (migration, setup)
 *
 * WHERE IT LIVES: `items.prices.billing_unit` — set by the owner in the item form. A row
 * without it (every row before R-526) gets the unit its old behaviour implied, so nothing
 * already quoted re-prices by itself: one_time item_type → one_time, a yearly-total support
 * plan → unit_year, hosting / support → unit_month, everything else → seat_month.
 *
 * WHAT THIS FILE NEVER DOES: change a price. A row whose name says "domain" or "migration"
 * but whose unit is still per-seat-per-month is REPORTED (`catalogUnitWarnings`, shown on
 * /items as "Check these catalog items") — the owner decides the unit and the number.
 */

export type BillingUnit = "seat_month" | "unit_month" | "unit_year" | "one_time";

export const BILLING_UNITS: ReadonlyArray<{ value: BillingUnit; label: string; hint: string }> = [
  { value: "seat_month", label: "Per seat / month", hint: "Licences — Workspace, M365, Zoho. Quote: price × 12 × seats." },
  { value: "unit_month", label: "Per unit / month", hint: "One account a month — hosting, monthly support. Quote: price × 12." },
  { value: "unit_year",  label: "Per unit / year",  hint: "One per year — domain registration, yearly support. Quote: price × 1 a year." },
  { value: "one_time",   label: "One-time",         hint: "Charged once — migration, setup. Quote: price × 1, no renewal." },
];

const UNIT_SET = new Set<string>(BILLING_UNITS.map((u) => u.value));

export function isBillingUnit(v: unknown): v is BillingUnit {
  return typeof v === "string" && UNIT_SET.has(v);
}

export interface BillingUnitRow {
  name?: string | null;
  vendor?: string | null;
  item_type?: string | null;
  msrp?: number | null;
  prices?: unknown;
}

/** The unit the owner SET on the row, or null when the row predates R-526. */
export function explicitBillingUnit(it: BillingUnitRow): BillingUnit | null {
  const v = (it.prices as { billing_unit?: unknown } | null | undefined)?.billing_unit;
  return isBillingUnit(v) ? v : null;
}

function isYearlyTotal(it: BillingUnitRow): boolean {
  const total = (it.prices as { annual_total?: { msrp?: number } } | null | undefined)?.annual_total?.msrp;
  return typeof total === "number" && total > 0 && !((it.msrp ?? 0) > 0);
}

/** The unit a row bills in — the owner's choice, else what the row's old behaviour implied. */
export function billingUnitOf(it: BillingUnitRow): BillingUnit {
  const set = explicitBillingUnit(it);
  if (set) return set;
  if (it.item_type === "one_time") return "one_time";
  if (isYearlyTotal(it)) return "unit_year";
  if (it.vendor === "hosting" || it.vendor === "support") return "unit_month";
  return "seat_month";
}

/** How many times the stored price is charged in a year (one_time: once, ever). */
export function unitYearMultiplier(unit: BillingUnit): number {
  return unit === "seat_month" || unit === "unit_month" ? 12 : 1;
}

/** Is the quantity a SEAT count (and so starts at the deal's seats)? Everything else is 1. */
export function isPerSeat(unit: BillingUnit): boolean {
  return unit === "seat_month";
}

/** First qty when the item is added to a quote: seats for per-seat items, 1 otherwise. */
export function defaultQtyForUnit(unit: BillingUnit, seats?: number | null): number {
  if (!isPerSeat(unit)) return 1;
  return seats && seats > 0 ? Math.round(seats) : 10;
}

/** Suffix for the price as STORED on the row ("/seat/mo", "/mo", "/yr", " one-time"). */
export function storedPriceSuffix(unit: BillingUnit): string {
  switch (unit) {
    case "seat_month": return "/seat/mo";
    case "unit_month": return "/mo";
    case "unit_year":  return "/yr";
    default:           return " one-time";
  }
}

/** Suffix for the price as it lands on a QUOTE LINE (the year, or once). */
export function lineRateSuffix(unit: BillingUnit): string {
  switch (unit) {
    case "seat_month": return "/seat/yr";
    case "unit_month":
    case "unit_year":  return "/yr";
    default:           return " one-time";
  }
}

export interface CatalogUnitWarning {
  id: string;
  name: string;
  /** What the row bills in now (set or implied). */
  unit: BillingUnit;
  /** What its name says it should be. */
  suggested: BillingUnit;
  /** One plain sentence for the owner, with the quote number it produces today. */
  reason: string;
}

const DOMAIN_RE    = /\bdomain\b.*\b(registration|renewal|transfer)\b|\b(registration|renewal)\b.*\bdomain\b/i;
const ONE_TIME_RE  = /\b(one[- ]?time|migration|setup|set-up|onboarding|installation|implementation)\b/i;

/** What a row's NAME says its unit is — null when the name says nothing either way. */
export function unitSuggestedByName(name: string | null | undefined): BillingUnit | null {
  const n = name ?? "";
  if (DOMAIN_RE.test(n)) return "unit_year";
  if (ONE_TIME_RE.test(n)) return "one_time";
  return null;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Catalogue rows whose unit and name disagree — e.g. "Domain registration" still billed per
 * seat per month. Only active rows with a price; the owner fixes each one (unit AND price).
 */
export function catalogUnitWarnings(
  items: ReadonlyArray<BillingUnitRow & { id: string; name: string; is_active?: boolean | null }>,
): CatalogUnitWarning[] {
  const out: CatalogUnitWarning[] = [];
  for (const it of items) {
    if (it.is_active === false) continue;
    const suggested = unitSuggestedByName(it.name);
    if (!suggested) continue;
    const unit = billingUnitOf(it);
    if (unit === suggested) continue;
    // A per-month unit on a yearly/one-time product is the ×12 bug; a yearly unit on a
    // one-time product (or the reverse) is a wrong renewal. Both are worth the owner's look.
    const price = it.msrp ?? 0;
    const quoted = price * unitYearMultiplier(unit);
    const what = suggested === "unit_year" ? "a domain is billed once a year per domain" : "this is charged once";
    const now = price > 0
      ? ` Today a quote adds it as ${inr(price)}${storedPriceSuffix(unit)} → ${inr(quoted)}${lineRateSuffix(unit)}${isPerSeat(unit) ? ", starting at 10 seats" : ""}.`
      : "";
    out.push({
      id: it.id,
      name: it.name,
      unit,
      suggested,
      reason: `Set to "${unitLabel(unit)}", but ${what}.${now} Set the unit to "${unitLabel(suggested)}" and check the price.`,
    });
  }
  return out;
}

export function unitLabel(unit: BillingUnit): string {
  return BILLING_UNITS.find((u) => u.value === unit)?.label ?? unit;
}
