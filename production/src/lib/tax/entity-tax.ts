/**
 * R-1844 — income-tax rates for a proprietor (slabs) and a firm / LLP (flat 30%), one place.
 *
 * A company's rates live in itr.ts (25% / 115BAA 22%). This file holds the other two, per FY,
 * with where each number came from. Every rate here is "CA / Hitesh to confirm" — the ITR page
 * prints the tax as an ESTIMATE, never as the assessed figure.
 *
 * Sources (read 24 Oct 2026):
 *  • Individual slabs, 87A rebate, surcharge, cess — AY 2026-27 (FY 2025-26), Income Tax
 *    Department e-filing portal, official:
 *    https://www.incometax.gov.in/iec/foportal/help/individual-business-profession
 *  • FY 2026-27 — Budget 2026 left the slabs and the ₹12 lakh rebate unchanged (press / bank
 *    guides, secondary; Finance Act 2026 text not read):
 *    https://storyboard18.com/special-coverage/budget-2026-no-change-in-tax-rates-in-budget-2026-rebate-continues-for-income-up-to-%e2%82%b912-lakh-88610.htm
 *  • FY 2024-25 — Finance (No. 2) Act 2024 slabs (new regime 3/7/10/12/15 lakh, rebate ₹25,000
 *    up to ₹7 lakh). From memory of the Act, NOT re-read on an official page — estimate.
 *  • Firm / LLP: 30%, surcharge 12% above ₹1 crore (marginal relief), cess 4% — CA referencer,
 *    secondary (official rate page refused the fetch):
 *    https://caalley.com/cas-referencer/income-tax-rates-ay-2026-27-and-2025-26
 *
 * Not counted (said on the page): marginal relief on surcharge and on the 87A rebate, the
 * senior-citizen slabs, special-rate income (capital gains), Chapter VI-A deductions (old regime).
 * Money: whole rupees.
 */

export interface Slab { upTo: number | null; ratePct: number }

export interface SlabRegime {
  slabs: Slab[];
  /** 87A: tax up to `max` is rebated when total income ≤ `incomeUpTo`. Residents only. */
  rebate: { incomeUpTo: number; max: number };
  /** Surcharge on tax, by total income: [threshold, %], highest first. */
  surcharge: [number, number][];
}

export interface IndividualRates {
  newRegime: SlabRegime;
  oldRegime: SlabRegime;
  /** Where these numbers come from and how sure we are — printed under the estimate. */
  source: string;
  confirmed: "official" | "secondary";
}

const OLD_REGIME: SlabRegime = {
  slabs: [{ upTo: 250_000, ratePct: 0 }, { upTo: 500_000, ratePct: 5 }, { upTo: 1_000_000, ratePct: 20 }, { upTo: null, ratePct: 30 }],
  rebate: { incomeUpTo: 500_000, max: 12_500 },
  surcharge: [[50_000_000, 37], [20_000_000, 25], [10_000_000, 15], [5_000_000, 10]],
};

/** Budget 2025 (Finance Act 2025) new regime — AY 2026-27 on the e-filing portal. */
const NEW_REGIME_2025: SlabRegime = {
  slabs: [
    { upTo: 400_000, ratePct: 0 }, { upTo: 800_000, ratePct: 5 }, { upTo: 1_200_000, ratePct: 10 },
    { upTo: 1_600_000, ratePct: 15 }, { upTo: 2_000_000, ratePct: 20 }, { upTo: 2_400_000, ratePct: 25 },
    { upTo: null, ratePct: 30 },
  ],
  rebate: { incomeUpTo: 1_200_000, max: 60_000 },
  surcharge: [[20_000_000, 25], [10_000_000, 15], [5_000_000, 10]],
};

const NEW_REGIME_2024: SlabRegime = {
  slabs: [
    { upTo: 300_000, ratePct: 0 }, { upTo: 700_000, ratePct: 5 }, { upTo: 1_000_000, ratePct: 10 },
    { upTo: 1_200_000, ratePct: 15 }, { upTo: 1_500_000, ratePct: 20 }, { upTo: null, ratePct: 30 },
  ],
  rebate: { incomeUpTo: 700_000, max: 25_000 },
  surcharge: [[20_000_000, 25], [10_000_000, 15], [5_000_000, 10]],
};

const PORTAL = "Income Tax Department e-filing portal, AY 2026-27 (incometax.gov.in)";

/** By the FY's start year. */
const INDIVIDUAL: Record<number, IndividualRates> = {
  2024: { newRegime: NEW_REGIME_2024, oldRegime: OLD_REGIME, confirmed: "secondary",
    source: "Finance (No. 2) Act 2024 slabs — not re-checked on an official page" },
  2025: { newRegime: NEW_REGIME_2025, oldRegime: OLD_REGIME, confirmed: "official", source: PORTAL },
  2026: { newRegime: NEW_REGIME_2025, oldRegime: OLD_REGIME, confirmed: "secondary",
    source: "Budget 2026: slabs reported unchanged from FY 2025-26 (press, not the Finance Act text)" },
};

/** The rates for a FY; a year not in the table uses the nearest one and says so. */
export function individualRates(fyStartYear: number): IndividualRates & { exactYear: boolean } {
  if (INDIVIDUAL[fyStartYear]) return { ...INDIVIDUAL[fyStartYear], exactYear: true };
  const years = Object.keys(INDIVIDUAL).map(Number).sort((a, b) => a - b);
  const near = fyStartYear < years[0] ? years[0] : years[years.length - 1];
  return { ...INDIVIDUAL[near], exactYear: false, confirmed: "secondary",
    source: `Rates for this year are not loaded — shown with FY ${near}-${String((near + 1) % 100).padStart(2, "0")} slabs` };
}

export const FIRM_RATES = {
  ratePct: 30,
  surcharge: { above: 10_000_000, pct: 12 },
  source: "Firm / LLP: 30%, 12% surcharge above ₹1 crore — CA referencer (secondary)",
} as const;

const r0 = (n: number) => Math.round(n);

/** Tax on `income` by the slabs, before rebate / surcharge / cess. */
export function slabTax(income: number, slabs: readonly Slab[]): number {
  let tax = 0, from = 0;
  for (const s of slabs) {
    const top = s.upTo ?? Infinity;
    if (income > from) tax += ((Math.min(income, top) - from) * s.ratePct) / 100;
    from = top;
  }
  return r0(tax);
}

export function surchargePct(income: number, table: readonly [number, number][]): number {
  for (const [above, pct] of table) if (income > above) return pct;
  return 0;
}

export interface SlabBreakdown { baseTax: number; rebate: number; surcharge: number; cess: number; total: number }

export function slabRegimeTax(income: number, regime: SlabRegime): SlabBreakdown {
  const baseTax = slabTax(income, regime.slabs);
  const rebate = income <= regime.rebate.incomeUpTo ? Math.min(baseTax, regime.rebate.max) : 0;
  const afterRebate = baseTax - rebate;
  const surcharge = r0((afterRebate * surchargePct(income, regime.surcharge)) / 100);
  const cess = r0(((afterRebate + surcharge) * 4) / 100);
  return { baseTax, rebate, surcharge, cess, total: afterRebate + surcharge + cess };
}

export function firmTax(income: number): SlabBreakdown {
  const baseTax = r0((income * FIRM_RATES.ratePct) / 100);
  const surcharge = income > FIRM_RATES.surcharge.above ? r0((baseTax * FIRM_RATES.surcharge.pct) / 100) : 0;
  const cess = r0(((baseTax + surcharge) * 4) / 100);
  return { baseTax, rebate: 0, surcharge, cess, total: baseTax + surcharge + cess };
}
