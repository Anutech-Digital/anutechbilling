/**
 * R-2393 — Private Vault: selling a property (tables personal_property_sales /
 * personal_property_sale_receipts, migration 20261103073146_r2393_personal_property_sales.sql).
 *
 * Pardeep (3 Nov): "isme property sell karta hai aur sell karne ki poori process jaise byana
 * ko handle karna kaise record karenge". A Wealth → Real estate holding gets "Sell this
 * property" → a sale deal: agreement, byana (moved from the R-2386 owe/hold entry), instalments,
 * final payment at registry, the buyer's TDS (s.194-IA) and a capital-gains estimate.
 *
 * Money while the deal is open: everything received is OWED to the buyer until the registry
 * (a cancelled deal is refunded), so it joins the R-2386 "I owe / hold for others" total —
 * the same place the byana sat before (openSaleAdvances below). At registry the property
 * leaves net worth (holding.sold_on) and the advance stops being owed; the cash is already
 * in the accounts the receipts went to.
 *
 * ─── TAX FIGURES ARE AN ESTIMATE ──────────────────────────────────────────────
 * The card's needsDecision: a CA confirms the wording and rates before release. Every number
 * from capitalGains() is shown with "Estimate — confirm with your CA". Rules used (Income-tax
 * Act 1961 as amended by Finance (No. 2) Act 2024):
 *   - long term when the property was held for MORE than 24 months (s.2(42A));
 *   - full value of consideration = the agreed price, or the stamp-duty value when that is
 *     more than 110% of the agreed price (s.50C, 10% tolerance since AY 2021-22);
 *   - long-term: 12.5% without indexation (s.112, transfers on/after 23 Jul 2024); for land /
 *     building bought BEFORE 23 Jul 2024 by an individual / HUF, the lower of that and 20% with
 *     indexation (CII, s.48);
 *   - short-term: added to income, taxed at the slab rate (no flat rate);
 *   - 4% health & education cess on the tax; surcharge is not estimated;
 *   - buyer deducts TDS 1% (s.194-IA) when the consideration is ₹50 lakh or more — on the
 *     higher of the price and the stamp-duty value; Form 26QB, shows in the seller's 26AS.
 *   - a forfeited advance of a cancelled deal is "Income from other sources" (s.56(2)(ix)).
 *
 * All amounts are whole rupees.
 */

export type SaleStatus = "agreement" | "registered" | "cancelled";
export type ReceiptKind = "byana" | "instalment" | "final";
export type ReceiptMode = "bank" | "cheque" | "cash";

export const RECEIPT_KIND_LABEL: Record<ReceiptKind, string> = {
  byana: "Byana (advance)",
  instalment: "Instalment",
  final: "Final payment at registry",
};

export const RECEIPT_MODE_LABEL: Record<ReceiptMode, string> = {
  bank: "Bank transfer",
  cheque: "Cheque",
  cash: "Cash",
};

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  agreement: "Agreement signed",
  registered: "Registered (sold)",
  cancelled: "Cancelled",
};

/** s.269SS / 269ST: cash of ₹20,000 or more for a property deal. */
export const CASH_LIMIT = 20_000;
/** s.194-IA: TDS applies when the consideration is ₹50 lakh or more. */
export const TDS_194IA_THRESHOLD = 50_00_000;
export const TDS_194IA_RATE = 0.01;
/** s.50C: stamp value is used only when it is more than 110% of the agreed price. */
export const SEC_50C_TOLERANCE = 1.1;
/** Finance (No. 2) Act 2024: the day the new LTCG rate (12.5%, no indexation) starts. */
export const NEW_LTCG_FROM = "2024-07-23";
export const LTCG_RATE_NEW = 0.125;
export const LTCG_RATE_INDEXED = 0.2;
export const CESS_RATE = 0.04;
/** More than 24 months = long term for land / building. */
export const LONG_TERM_AFTER_MONTHS = 24;

/**
 * Cost Inflation Index (CBDT), keyed by the financial year's starting calendar year
 * (2001 = FY 2001-02). A year missing here (not yet notified) = no indexation figure.
 */
export const CII: Readonly<Record<number, number>> = {
  2001: 100, 2002: 105, 2003: 109, 2004: 113, 2005: 117, 2006: 122, 2007: 129, 2008: 137,
  2009: 148, 2010: 167, 2011: 184, 2012: 200, 2013: 220, 2014: 240, 2015: 254, 2016: 264,
  2017: 272, 2018: 280, 2019: 289, 2020: 301, 2021: 317, 2022: 331, 2023: 348, 2024: 363,
  2025: 376,
};

function rupees(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Financial year start (2024 for any date 1 Apr 2024 – 31 Mar 2025). Dates are YYYY-MM-DD. */
export function fyStart(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

/** "FY 2024-25" */
export function fyLabel(start: number): string {
  return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Whole months from `from` to `to` (a month counts once its day is reached). */
export function monthsHeld(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(months, 0);
}

/** A cash receipt of ₹20,000 or more — s.269SS / 269ST warning. */
export function isCashWarning(mode: ReceiptMode, amount: number): boolean {
  return mode === "cash" && rupees(amount) >= CASH_LIMIT;
}

/** Full value of consideration under s.50C. */
export function saleValue(agreedPrice: number, stampValue: number | null | undefined): {
  value: number;
  usesStampValue: boolean;
} {
  const agreed = rupees(agreedPrice);
  const stamp = rupees(stampValue ?? 0);
  if (stamp > agreed * SEC_50C_TOLERANCE) return { value: stamp, usesStampValue: true };
  return { value: agreed, usesStampValue: false };
}

/** TDS the buyer must deduct (s.194-IA): 1% of the higher of price and stamp value, at ₹50 L+. */
export function tds194IA(agreedPrice: number, stampValue: number | null | undefined): number {
  const base = Math.max(rupees(agreedPrice), rupees(stampValue ?? 0));
  if (base < TDS_194IA_THRESHOLD) return 0;
  return Math.round(base * TDS_194IA_RATE);
}

export interface SaleLike {
  id: string;
  status: SaleStatus;
  agreed_price: number;
  tds_deducted?: number | null;
}

export interface ReceiptLike {
  sale_id: string;
  amount: number;
}

/** Money received on one deal so far. */
export function receivedTotal(saleId: string, receipts: readonly ReceiptLike[]): number {
  let t = 0;
  for (const r of receipts) if (r.sale_id === saleId) t += rupees(r.amount);
  return t;
}

/** Still to come: price − received − TDS the buyer deducted. Never below 0. */
export function balanceDue(sale: SaleLike, receipts: readonly ReceiptLike[]): number {
  return Math.max(rupees(sale.agreed_price) - receivedTotal(sale.id, receipts) - rupees(sale.tds_deducted ?? 0), 0);
}

/**
 * Money received on deals that are still at the agreement stage — owed to the buyer until the
 * registry. Returned in the R-2386 owe/hold shape so net worth subtracts it through the SAME
 * rule (computeNetWorth → openOweHoldTotal); no second "owed" rule.
 */
export function openSaleAdvances(
  sales: readonly SaleLike[],
  receipts: readonly ReceiptLike[],
): { amount: number; status: "open" }[] {
  const out: { amount: number; status: "open" }[] = [];
  for (const s of sales) {
    if (s.status !== "agreement") continue;
    const amt = receivedTotal(s.id, receipts);
    if (amt > 0) out.push({ amount: amt, status: "open" });
  }
  return out;
}

export interface CapitalGainsInput {
  /** YYYY-MM-DD the property was bought. Null = unknown (no term / indexation). */
  acquiredOn: string | null;
  /** YYYY-MM-DD of the transfer (registry date, or today for an estimate). */
  transferOn: string;
  agreedPrice: number;
  stampValue: number | null;
  cost: number;
  improvements: number;
  transferExpenses: number;
}

export interface CapitalGains {
  months: number | null;
  term: "long" | "short" | null;
  fullValue: number;
  usesStampValue: boolean;
  /** fullValue − transfer expenses − cost − improvements. Negative = a loss. */
  gain: number;
  /** Long term, 12.5% without indexation. */
  newRegime: { tax: number; cess: number; total: number } | null;
  /** Long term, 20% with indexation — only when bought before 23 Jul 2024 and both CIIs are known. */
  indexed: { indexedCost: number; gain: number; tax: number; cess: number; total: number; ciiFrom: number; ciiTo: number } | null;
  /** Why the indexation option is not shown, when it is not. */
  indexedMissing: string | null;
  /** The lower of the two long-term options. */
  bestTotal: number | null;
}

function withCess(tax: number) {
  const t = Math.max(Math.round(tax), 0);
  const cess = Math.round(t * CESS_RATE);
  return { tax: t, cess, total: t + cess };
}

export function capitalGains(input: CapitalGainsInput): CapitalGains {
  const { value: fullValue, usesStampValue } = saleValue(input.agreedPrice, input.stampValue);
  const cost = rupees(input.cost);
  const impr = rupees(input.improvements);
  const exp = rupees(input.transferExpenses);
  const gain = fullValue - exp - cost - impr;

  const months = input.acquiredOn ? monthsHeld(input.acquiredOn, input.transferOn) : null;
  const term = months === null ? null : months > LONG_TERM_AFTER_MONTHS ? "long" : "short";

  let newRegime: CapitalGains["newRegime"] = null;
  let indexed: CapitalGains["indexed"] = null;
  let indexedMissing: string | null = null;

  if (term === "long") {
    newRegime = withCess(Math.max(gain, 0) * LTCG_RATE_NEW);
    if (input.acquiredOn && input.acquiredOn < NEW_LTCG_FROM) {
      // Bought before 1 Apr 2001: the cost is the fair market value on 1 Apr 2001 (CII 100).
      const fromYear = Math.max(fyStart(input.acquiredOn), 2001);
      const toYear = fyStart(input.transferOn);
      const ciiFrom = CII[fromYear];
      const ciiTo = CII[toYear];
      if (ciiFrom && ciiTo) {
        const indexedCost = Math.round((cost * ciiTo) / ciiFrom);
        const g = fullValue - exp - indexedCost - impr;
        indexed = { indexedCost, gain: g, ...withCess(Math.max(g, 0) * LTCG_RATE_INDEXED), ciiFrom, ciiTo };
      } else {
        indexedMissing = `Cost Inflation Index for ${fyLabel(ciiTo ? fromYear : toYear)} is not in the app yet.`;
      }
    }
  }

  const bestTotal = newRegime ? Math.min(newRegime.total, indexed ? indexed.total : Infinity) : null;

  return { months, term, fullValue, usesStampValue, gain, newRegime, indexed, indexedMissing, bestTotal };
}

/** Exemptions to mention under a long-term gain (not computed). */
export const CG_EXEMPTION_NOTES: readonly string[] = [
  "s.54 — buy or build one house in India (1 year before / 2 years after; build within 3 years).",
  "s.54EC — up to ₹50 lakh in specified bonds (NHAI, REC…) within 6 months.",
  "s.54F — for a non-house asset, when the whole net sale value goes into a house.",
];
