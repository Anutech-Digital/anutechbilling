/**
 * Turning the `items` catalog into the choices the Add-subscription dialog offers.
 *
 * ─── WHY THE DIALOG'S OWN LIST HAD TO GO ────────────────────────────────────
 * add-subscription-dialog.tsx carried a hardcoded list of 29 products with their own
 * ids ("gw-starter") and their own prices. The ids matched nothing in the catalog
 * ("GW-STR-fbb"), so the dialog could not supply the subscription's item_id, and the
 * PRICES had drifted below the tenant's real vendor cost. Measured 14 Aug 2026,
 * ₹/seat/year:
 *
 *     product                        dialog   catalog     cost   margin at the
 *                                    default   (msrp)             dialog default
 *     GWS Business Starter            2,160    3,240      1,320    38.9%
 *     GWS Business Standard          10,080   10,368      7,440    26.2%
 *     GWS Business Plus              15,120   16,560     13,800     8.7%
 *     M365 Business Basic             1,800    2,400      1,980   −10.0%  LOSS
 *     M365 Business Standard          7,920   11,880      9,840   −24.2%  LOSS
 *     M365 Business Premium          18,000   22,800     19,440    −8.0%  LOSS
 *     Zoho Workplace Standard         1,188    1,440      1,140     4.0%
 *     Zoho Workplace Professional     2,388    3,360      2,640   −10.6%  LOSS
 *
 * Four of the eight overlapping products pre-filled a price BELOW what the vendor
 * charges. An operator who accepted the suggestion on M365 Business Standard lost
 * ₹1,920 per seat per year, and nothing on the screen said so. That is not a stale
 * default — it is a loss-making price offered by the app before a sale is even made.
 *
 * ─── THE UNIT, ESTABLISHED FROM THE DATA ────────────────────────────────────
 *     items.msrp                  ₹/seat/MONTH  — equals prices.annual.msrp on every
 *                                 row that has prices, and is the ONLY price on
 *                                 hosting/support rows, where prices is null
 *     items.prices.annual.wholesale  ₹/seat/MONTH cost
 * The dialog charges ₹/seat/YEAR, so both are × 12 here — once, in one place.
 */
import type { Item } from "@/lib/supabase/database.types";

export interface CatalogProduct {
  /** items.id — what gets stored in subscriptions.item_id. */
  id:     string;
  name:   string;
  vendor: Item["vendor"];
  /** ₹/seat/year the catalog says to charge. */
  annualSellPerSeat: number;
  /** ₹/seat/year the vendor charges. Null when no cost is recorded. */
  annualCostPerSeat: number | null;
  /** ₹/seat/MONTH under ANNUAL commitment — the rate a monthly-billed annual deal
   *  charges each month. Same price tier as `annualSellPerSeat`, different unit. */
  annualMonthlySellPerSeat: number;
  annualMonthlyCostPerSeat: number | null;
  /** ₹/seat/MONTH with NO commitment (`prices.monthly`) — the flex tier, which is a
   *  genuinely HIGHER rate, not annual ÷ 12. Null when the row has no flex price. */
  flexMonthlySellPerSeat: number | null;
  flexMonthlyCostPerSeat: number | null;
}

/** ₹/seat/month sell. msrp is the annual-commitment monthly rate; prices.annual.msrp
 *  agrees with it wherever both exist, and hosting/support only have msrp. */
function monthlySell(it: Item): number {
  const p = (it.prices as { annual?: { msrp?: number } } | null)?.annual?.msrp;
  if (typeof p === "number" && p > 0) return p;
  return typeof it.msrp === "number" && it.msrp > 0 ? it.msrp : 0;
}

/** ₹/seat/month cost, or null. Zero is only meaningful with the vendor — see margin.ts. */
function monthlyCost(it: Item): number | null {
  const p = (it.prices as { annual?: { wholesale?: number } } | null)?.annual?.wholesale;
  if (typeof p === "number" && p > 0) return p;
  if (typeof it.wholesale === "number" && it.wholesale > 0) return it.wholesale;
  /* wholesale 0 is a real ₹0 for the reseller's own services and "not entered" for a
     resold vendor. Reporting null here rather than 0 keeps the dialog from showing a
     confident 100% margin on a row nobody has priced. */
  return it.wholesale === 0 ? 0 : null;
}

/**
 * ₹/seat/year sell.
 *
 * ─── SOME PLANS ARE PRICED AS A YEAR, NOT AS A MONTHLY RATE ─────────────────
 * Almost everything here is a monthly rate and the year is monthly × 12. Support
 * plans are not: Standard is ₹999/mo or ₹9,990/yr, a real discount, and ₹9,990 ÷ 12
 * is ₹832.50 — not a whole rupee (AGENTS.md §1). Forcing it through a monthly rate
 * rounds to ₹833 and bills ₹9,996, so the customer is quoted one number and charged
 * another.
 *
 * `prices.annual_total.msrp` therefore holds a TOTAL FOR THE YEAR and is used
 * verbatim. It is a separate key from `prices.annual` on purpose: that one is a
 * monthly rate under annual commitment, and overloading it would leave two meanings
 * behind one name.
 */
function annualSell(it: Item): number {
  const total = (it.prices as { annual_total?: { msrp?: number } } | null)?.annual_total?.msrp;
  if (typeof total === "number" && total > 0) return total;
  return monthlySell(it) * 12;
}

/**
 * ₹/seat/month on the FLEX tier — `prices.monthly`, no commitment.
 *
 * A separate, genuinely higher price, not annual ÷ 12: the item type documents it as
 * "no commitment, monthly bill (highest rate, max flexibility)". Nothing in this
 * module read it until the billing-period dropdown was added (9 Sep 2026), because
 * the dialog only ever sold annual-commit-billed-yearly.
 *
 * Returns **null** when the row has no flex price, and the caller must say so rather
 * than substitute the annual rate. Quietly falling back would sell a
 * cancel-any-time subscription at the committed price — giving away the flexibility
 * premium on every such deal, invisibly. The dialog shows the annual rate as a
 * starting point but labels it as not-a-flex-price so the operator can raise it.
 */
function flexMonthlySell(it: Item): number | null {
  const p = (it.prices as { monthly?: { msrp?: number } } | null)?.monthly?.msrp;
  return typeof p === "number" && p > 0 ? p : null;
}

/** ₹/seat/month flex cost, or null. Same rule as flexMonthlySell. */
function flexMonthlyCost(it: Item): number | null {
  const p = (it.prices as { monthly?: { wholesale?: number } } | null)?.monthly?.wholesale;
  return typeof p === "number" && p > 0 ? p : null;
}

/** ₹/seat/year cost, or null. Same rule as annualSell. */
function annualCost(it: Item): number | null {
  const total = (it.prices as { annual_total?: { wholesale?: number } } | null)?.annual_total?.wholesale;
  if (typeof total === "number" && total > 0) return total;
  const monthly = monthlyCost(it);
  return monthly === null ? null : monthly * 12;
}

/**
 * Subscription products from the catalog, grouped by vendor, cheapest first.
 *
 * One-time items are excluded: they are not something a subscription renews. Inactive
 * items are the caller's business — useItems() already filters them.
 */
export function subscriptionProducts(items: readonly Item[]): CatalogProduct[] {
  return items
    .filter((it) => it.item_type !== "one_time")
    .map((it) => ({
      id:     it.id,
      name:   it.name,
      vendor: it.vendor,
      annualSellPerSeat: annualSell(it),
      annualCostPerSeat: annualCost(it),
      annualMonthlySellPerSeat: monthlySell(it),
      annualMonthlyCostPerSeat: monthlyCost(it),
      flexMonthlySellPerSeat: flexMonthlySell(it),
      flexMonthlyCostPerSeat: flexMonthlyCost(it),
    }))
    .sort((a, b) =>
      a.vendor === b.vendor
        ? a.annualSellPerSeat - b.annualSellPerSeat
        : a.vendor.localeCompare(b.vendor));
}

/**
 * The vendors this tenant actually sells, in the catalog's order.
 *
 * Derived from the catalog rather than hardcoded, because the hardcoded list was four
 * values while the DB enum has seven — so `hosting` and `support` products, 7 of this
 * tenant's 17 subscription items, were unreachable from the dialog entirely.
 */
export function catalogVendors(products: readonly CatalogProduct[]): Item["vendor"][] {
  const seen: Item["vendor"][] = [];
  for (const p of products) if (!seen.includes(p.vendor)) seen.push(p.vendor);
  return seen;
}

/**
 * The vendor dropdown's options: what the tenant sells, plus `other`.
 *
 * `other` is always offered because it is the home for a custom plan — a tenant with
 * an empty catalogue still has to be able to add a subscription.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT TWO LINES OF JSX ────────────────────────
 * It was two lines of JSX: a fallback that substituted `["other"]` when the catalogue
 * came back empty, and a separate guard that appended `other` whenever the catalogue
 * did not already list it. Either alone is correct. Together, on an empty catalogue,
 * BOTH fire and the dropdown shows "Other Cloud Vendor" twice — which is what a
 * reseller reported from the live app.
 *
 * Two half-rules that have to agree are one rule written twice. This is that rule.
 */
export function vendorSelectOptions(products: readonly CatalogProduct[]): Item["vendor"][] {
  const vendors = catalogVendors(products);
  return vendors.includes("other") ? vendors : [...vendors, "other" as Item["vendor"]];
}

export function productsForVendor(
  products: readonly CatalogProduct[], vendor: Item["vendor"],
): CatalogProduct[] {
  return products.filter((p) => p.vendor === vendor);
}

export function findProduct(
  products: readonly CatalogProduct[], id: string,
): CatalogProduct | undefined {
  return products.find((p) => p.id === id);
}

/* ─── BILLING PERIOD ────────────────────────────────────────────────────────────
 *
 * The dialog used to sell exactly one shape: annual commitment, one invoice for the
 * year. `subscriptions.billing_cycle` and `term_months` existed all along and it
 * never wrote either, so all five rows in the database are the DB defaults.
 *
 * There are two independent facts, and calling both of them "monthly" is what
 * produced the 12× under-charge of 1 Sep 2026:
 *
 *   PRICE TIER  (line.commitment) — flex vs annual commit. DIFFERENT RATES.
 *   FREQUENCY   (quote.billing_cycle) — how often an invoice is raised.
 *
 * An annual commitment billed monthly is the ANNUAL rate, twelve times. It is not
 * the flex rate, and the flex rate is not annual ÷ 12.
 *
 * ─── THE STORED-AMOUNT RULE, WHICH IS NOT NEGOTIABLE ────────────────────────
 * `quoteInstalments` (lib/billing/instalments.ts) keys off the line's commitment:
 *   • commitment 'monthly' → the stored figures ALREADY ARE one month; it returns null
 *   • commitment 'annual_*' → the stored figures are the WHOLE TERM; it splits them
 * So a monthly-billed ANNUAL deal must store the YEAR. Storing one month there would
 * have instalments divide an already-monthly number by 12 — the same 12× defect as
 * B9, in the opposite direction. `periods` below is that rule, in one number.
 */
export type BillingChoice =
  | "monthly_flex" | "annual_monthly" | "annual_quarterly" | "annual_yearly";

export interface BillingChoiceMeta {
  value: BillingChoice;
  label: string;
  /** One line for the operator, in the dropdown. */
  hint: string;
}

export const BILLING_CHOICES: readonly BillingChoiceMeta[] = [
  { value: "annual_yearly",  label: "Yearly — 1 invoice for the year",
    hint: "Annual commitment, paid upfront. The default." },
  { value: "annual_monthly", label: "Monthly — annual commitment",
    hint: "Same annual rate, invoiced every month. Customer is committed for 12 months." },
  { value: "annual_quarterly", label: "Quarterly — annual commitment",
    hint: "Same annual rate, priced per month, invoiced every 3 months (4 invoices). Committed for 12 months." },
  { value: "monthly_flex",   label: "Monthly — no commitment (flex)",
    hint: "Cancel any time. Higher rate — this is its own price, not the annual one ÷ 12." },
] as const;

export interface BillingTerms {
  /** What a number typed into the price field MEANS for this choice. */
  unit: "per_seat_month" | "per_seat_year";
  /** Suffix for the price field's label — "₹/mo" or "₹/yr". */
  unitLabel: string;
  /** The catalog's suggested ₹/seat in `unit`. 0 when the catalog cannot say. */
  suggestedSellPerSeat: number;
  /** The vendor's ₹/seat in `unit`, or null when no cost is recorded. */
  costPerSeat: number | null;
  /** True when this is the flex tier but the row has no flex price, so
   *  `suggestedSellPerSeat` is the ANNUAL rate standing in — say so on screen. */
  flexPriceMissing: boolean;
  /** Multiply a per-`unit` figure by this to get what the QUOTE stores. See the
   *  stored-amount rule above: 12 for a monthly-billed annual commitment, 1 otherwise. */
  periods: number;
  /** Invoices raised over the term: 12 monthly, 4 quarterly, 1 yearly or flex.
   *  Display only — the schedule itself is lib/billing/schedule.ts. */
  invoicesPerTerm: number;
  /** What goes on the quote line. Only two values are written for new quotes. */
  commitment: "monthly" | "annual_yearly";
  /** quotes.billing_cycle and subscriptions.billing_cycle. */
  billingCycle: "monthly" | "quarterly" | "yearly";
  /** subscriptions.term_months — 1 for flex, 12 for a commitment. */
  termMonths: number;
}

/**
 * Everything money-shaped that a billing choice decides, in one place.
 *
 * `product` may be undefined for a custom plan with no catalog row — then there is no
 * suggestion and no cost, and the operator types the price. That is the same shape the
 * dialog already handled; it just has a unit now.
 */
export function billingTerms(
  choice: BillingChoice, product?: CatalogProduct,
): BillingTerms {
  if (choice === "annual_yearly") {
    return {
      unit: "per_seat_year", unitLabel: "₹/yr",
      suggestedSellPerSeat: product?.annualSellPerSeat ?? 0,
      costPerSeat: product?.annualCostPerSeat ?? null,
      flexPriceMissing: false,
      periods: 1, invoicesPerTerm: 1,
      commitment: "annual_yearly", billingCycle: "yearly", termMonths: 12,
    };
  }
  if (choice === "annual_quarterly") {
    /* R-826. Priced PER MONTH at the annual rate (the same unit as annual_monthly) and
       stored as the YEAR (periods 12), so quoteInstalments and the billing cron split
       it into four 3-month invoices on billing_cycle 'quarterly'.
       Why per month, not per quarter or per year: the cron derives the term from
       subscriptions.mrr × term_months (subscription-schedule.ts). With a per-month
       price mrr is exact, so the cron's year equals the quote's year to the rupee. A
       per-year price (₹9,990) would store mrr ₹833 and the cron would bill ₹9,996. */
    return {
      unit: "per_seat_month", unitLabel: "₹/mo",
      suggestedSellPerSeat: product?.annualMonthlySellPerSeat ?? 0,
      costPerSeat: product?.annualMonthlyCostPerSeat ?? null,
      flexPriceMissing: false,
      periods: 12, invoicesPerTerm: 4,
      commitment: "annual_yearly", billingCycle: "quarterly", termMonths: 12,
    };
  }
  if (choice === "annual_monthly") {
    return {
      unit: "per_seat_month", unitLabel: "₹/mo",
      suggestedSellPerSeat: product?.annualMonthlySellPerSeat ?? 0,
      costPerSeat: product?.annualMonthlyCostPerSeat ?? null,
      flexPriceMissing: false,
      /* 12 — the quote stores the YEAR so quoteInstalments can split it. */
      periods: 12, invoicesPerTerm: 12,
      commitment: "annual_yearly", billingCycle: "monthly", termMonths: 12,
    };
  }
  /* monthly_flex. `periods: 1` — the stored figures ARE one month, which is the
     invariant quoteInstalments and record_payment both rely on for commitment
     'monthly'. Never 12 here. */
  const flexSell = product?.flexMonthlySellPerSeat ?? null;
  const missing  = product !== undefined && flexSell === null;
  return {
    unit: "per_seat_month", unitLabel: "₹/mo",
    suggestedSellPerSeat: flexSell ?? product?.annualMonthlySellPerSeat ?? 0,
    costPerSeat: product?.flexMonthlyCostPerSeat ?? product?.annualMonthlyCostPerSeat ?? null,
    flexPriceMissing: missing,
    periods: 1, invoicesPerTerm: 1,
    commitment: "monthly", billingCycle: "monthly", termMonths: 1,
  };
}

/**
 * What the FIRST invoice charges, ex-GST, given what the quote stores.
 *
 * Same split as buildBillingSchedule: whole rupees, floor per invoice, remainder on the
 * LAST one — so the dialog never promises a first invoice the cron will not raise.
 */
export function firstInvoiceTaxable(
  storedTaxable: number, terms: Pick<BillingTerms, "invoicesPerTerm">,
): number {
  const total = Math.max(0, Math.round(storedTaxable));
  return Math.floor(total / Math.max(1, terms.invoicesPerTerm));
}

/** Annualise a per-`unit` figure, for the margin verdict — which reports "per seat per
 *  YEAR" and would lie if fed a monthly number. Flex is × 12 for comparison only; it
 *  does not mean the customer is committed for a year. */
export function annualise(perSeat: number, unit: BillingTerms["unit"]): number {
  return unit === "per_seat_month" ? perSeat * 12 : perSeat;
}

export type PriceVerdict =
  | { kind: "loss";    shortfallPerSeatYear: number }
  | { kind: "thin";    marginPct: number }
  | { kind: "ok";      marginPct: number }
  | { kind: "unknown" };

/**
 * Is the price the operator has typed actually profitable?
 *
 * Shown live, next to the field, because every loss-making default above was visible
 * on screen for months with nothing to mark it. A margin figure that only appears in a
 * report arrives after the quote has gone out.
 *
 * `thinBelowPct` is 10 to match THIN_MARGIN_BPS, and is just as much a placeholder.
 */
export function judgePrice(
  annualSellPerSeat: number,
  annualCostPerSeat: number | null,
  thinBelowPct = 10,
): PriceVerdict {
  if (annualCostPerSeat === null || annualSellPerSeat <= 0) return { kind: "unknown" };
  if (annualSellPerSeat < annualCostPerSeat) {
    return { kind: "loss", shortfallPerSeatYear: annualCostPerSeat - annualSellPerSeat };
  }
  const marginPct = ((annualSellPerSeat - annualCostPerSeat) / annualSellPerSeat) * 100;
  return marginPct < thinBelowPct ? { kind: "thin", marginPct } : { kind: "ok", marginPct };
}
