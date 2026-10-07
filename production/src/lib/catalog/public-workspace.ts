/**
 * Shape a catalogue row for PUBLIC consumption — the company website reads this.
 *
 * ─── THE ONE RULE ───────────────────────────────────────────────────────────
 * `wholesale` and `margin_pct` must never leave this function. They are the business's
 * buy price and its margin — on a public endpoint they would hand every customer the
 * negotiation floor, and every competitor the cost structure. That is why this is a
 * FUNCTION with a test, not a `select` list someone widens in a hurry: the test feeds a
 * row that CONTAINS wholesale figures and asserts the output carries none of them, and
 * it walks the output recursively so a nested `prices.annual.wholesale` cannot slip
 * through either.
 *
 * What the website needs, and all it gets:
 *   name              "Google Workspace Business Starter"
 *   annualPerSeatMo   ₹/seat/month on the annual commitment  (items.msrp — see §13:
 *                     money is whole rupees, and msrp is per seat per MONTH)
 *   monthlyPerSeatMo  ₹/seat/month on the flexible tier      (prices.monthly.msrp)
 *
 * The flex figure can be null — a product priced only for annual commitment simply has
 * no monthly tier, and the website must show "annual only" rather than invent a number.
 */

import { floorWorkspaceRow } from "./workspace-floor";

/** R-076: the website reads Microsoft 365 and Zoho from the same endpoint as Google Workspace. */
export type PublicSuiteVendor = "google" | "microsoft" | "zoho";
const SUITE_VENDORS: readonly PublicSuiteVendor[] = ["google", "microsoft", "zoho"];

export interface PublicWorkspaceItem {
  name: string;
  annualPerSeatMo: number;
  monthlyPerSeatMo: number | null;
  /** Present when the row carried a suite vendor — the website matches editions by it. */
  vendor?: PublicSuiteVendor;
}

/* R-076 (7 Oct 2026): only the suite products themselves reach the website — a Google row
   must be "Google Workspace …", a Microsoft row "Microsoft 365 …", a Zoho row "Zoho …" —
   so an add-on or another item under the same vendor never lands on a pricing page. */
const SUITE_PREFIX: Readonly<Record<PublicSuiteVendor, RegExp>> = {
  google: /^google workspace\b/i,
  microsoft: /^microsoft 365\b/i,
  zoho: /^zoho\b/i,
};

export function suiteRows<T extends { name: string | null; vendor: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => {
    const v = SUITE_VENDORS.find((x) => x === r.vendor);
    return !!v && SUITE_PREFIX[v].test((r.name ?? "").trim());
  });
}

interface CatalogRowLike {
  name: string | null;
  msrp: number | null;
  prices: unknown;
  vendor?: string | null;
}

function monthlyMsrp(prices: unknown): number | null {
  if (!prices || typeof prices !== "object") return null;
  const monthly = (prices as Record<string, unknown>).monthly;
  if (!monthly || typeof monthly !== "object") return null;
  const msrp = (monthly as Record<string, unknown>).msrp;
  return typeof msrp === "number" && Number.isFinite(msrp) && msrp > 0 ? msrp : null;
}

export function publicWorkspaceCatalog(rows: readonly CatalogRowLike[]): PublicWorkspaceItem[] {
  const out: PublicWorkspaceItem[] = [];
  for (const raw of rows) {
    /* R-205: a GW Starter/Standard/Plus row priced under the list price is stale (the old
       ₹136 seed) — lifted to the list price before it reaches the website. */
    const r = floorWorkspaceRow(raw);
    /* A row with no name or no positive customer price is not publishable — skipped, not
       nulled, so the website never renders a card it cannot price. */
    if (!r.name?.trim()) continue;
    if (typeof r.msrp !== "number" || !Number.isFinite(r.msrp) || r.msrp <= 0) continue;
    /* A flexible price at or below the annual one is a stale row too (R-205: Starter flex
       ₹170 against ₹270 annual) — "annual only" rather than a wrong flexible price. */
    const flex = monthlyMsrp(r.prices);
    const vendor = SUITE_VENDORS.find((v) => v === raw.vendor);
    out.push({
      name: r.name.trim(),
      annualPerSeatMo: r.msrp,
      monthlyPerSeatMo: flex != null && flex > r.msrp ? flex : null,
      ...(vendor ? { vendor } : {}),
    });
  }
  return out;
}
