/**
 * R-2558 (7 Nov 2026) — the TDS rate + section a bank receipt's "TDS deducted" books, on the
 * Reconcile sheet ("A new sale" and "An open quote / invoice").
 *
 * Before: the sheet had no rate box. It sent rate = TDS ÷ the part's taxable, so ₹3,150 deducted
 * on a half-yearly part (₹78,750 taxable) went as 4% — while the customer had deducted 2% on the
 * whole year's ₹1,57,500 (26AS shows that). The server's R-2538 rule (a rate that does not fit
 * the TDS on the part → gross = TDS × 100 ÷ rate) never ran. It also pre-picked 194J and
 * "Part payment" when nothing said so.
 *
 * Now the rate is ASKED (pre-filled only from evidence, never from TDS ÷ part):
 *   1. the gap is a common TDS rate of the part's taxable (2% of ₹78,750 = ₹1,575), or
 *   2. of the WHOLE sale's taxable (2% of ₹1,57,500 = ₹3,150 — deducted on the full contract), or
 *   3. the customer's saved TDS (customers.tds_default_section / tds_default_rate_pct, R-2370);
 *      when it is one of the fits above it wins (₹1,575 is 2% of the part AND 1% of the year);
 *   4. else empty — the operator types it from the Form 16A.
 * The section: the customer's saved one, else the rate's usual section (1/2% → 194C, 10% → 194J,
 * lib/banking/tds-section), else none — the operator picks it.
 */
import { rupee } from "@/lib/utils";
import { TDS_RATES_PCT } from "@/lib/banking/invoice-credit-match";
import { tdsSectionGuess } from "@/lib/banking/tds-section";

export interface BankTdsCustomer {
  tds_default_section?: string | null;
  tds_default_rate_pct?: number | string | null;
  gstin?: string | null;
}

export interface BankTdsDefault {
  /** Pre-filled rate %; null = the operator types it. */
  ratePct: number | null;
  /** Pre-picked section; null = the operator picks it. */
  section: string | null;
  /** The gap fits a known rate on the part or the whole sale → "TDS deducted" is pre-chosen. */
  likely: boolean;
  /** One line under the boxes: where the rate came from, or what to do. */
  reason: string;
}

/** ±₹1 — the server's own "the rate fits the TDS on the part" test (bank_credit_tds_gross), so the
 *  reason shown and the gross stored never disagree. */
const FIT_TOLERANCE = 1;

function fitRate(tds: number, base: number | null | undefined, rates: readonly number[]): number | null {
  if (!base || base <= 0 || !(tds > 0)) return null;
  for (const r of rates) if (Math.abs(Math.round((base * r) / 100) - tds) <= FIT_TOLERANCE) return r;
  return null;
}

function customerRate(c: BankTdsCustomer | null | undefined): number | null {
  const raw = c?.tds_default_rate_pct;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** The customer's saved TDS section (R-2370), upper-cased; null when none. */
export function customerTdsSection(c: BankTdsCustomer | null | undefined): string | null {
  const s = (c?.tds_default_section ?? "").trim().toUpperCase();
  return s || null;
}

/** The rate's usual section (1/2% → 194C, 10% → 194J); null when the rate does not say. */
export function sectionForRate(ratePct: number | null, gstin: string | null | undefined): { section: string; reason: string } | null {
  if (ratePct !== 1 && ratePct !== 2 && ratePct !== 10) return null;
  return tdsSectionGuess(ratePct, gstin);
}

/**
 * The rate + section to pre-fill for a short bank receipt.
 * `partTaxable` = the taxable value of what is due now (the part); `wholeTaxable` = the whole
 * sale's / document's taxable (null or equal to the part when it is not billed in parts).
 */
export function bankTdsDefault(i: {
  shortBy: number;
  partTaxable: number | null;
  wholeTaxable?: number | null;
  /** The rate the gap already fits on the due amount (AmountCheck.tdsRatePct), if any. */
  partRatePct?: number | null;
  customer?: BankTdsCustomer | null;
}): BankTdsDefault {
  const tds = Math.round(i.shortBy);
  const cRate = customerRate(i.customer);
  const cSection = customerTdsSection(i.customer);
  const rates: readonly number[] = TDS_RATES_PCT;
  const part = i.partTaxable && i.partTaxable > 0 ? i.partTaxable : null;
  const whole = i.wholeTaxable && i.wholeTaxable > 0 && (part === null || i.wholeTaxable > part) ? i.wholeTaxable : null;
  /* Fits, in order: the customer's own rate on the part, then on the whole sale; a common rate on
     the part (or the rate the due amount already showed), then on the whole sale. */
  type Fit = { rate: number; base: number; on: "part" | "whole" };
  const cOnPart = cRate !== null && fitRate(tds, part, [cRate]) !== null ? cRate : null;
  const cOnWhole = cRate !== null && fitRate(tds, whole, [cRate]) !== null ? cRate : null;
  /* the due amount's own rate (GST-inclusive guess) only when no taxable is known */
  const partFit = part !== null ? fitRate(tds, part, rates) : (i.partRatePct ?? null);
  const wholeFit = fitRate(tds, whole, rates);
  const pick: Fit | null =
    cOnPart !== null ? { rate: cOnPart, base: part ?? 0, on: "part" }
    : cOnWhole !== null ? { rate: cOnWhole, base: whole ?? 0, on: "whole" }
    : partFit !== null ? { rate: partFit, base: part ?? 0, on: "part" }
    : wholeFit !== null ? { rate: wholeFit, base: whole ?? 0, on: "whole" }
    : null;

  const sectionFor = (rate: number | null): { section: string | null; why: string | null } => {
    if (cSection && (cRate === null || cRate === rate)) return { section: cSection, why: "this customer's saved TDS section" };
    const g = sectionForRate(rate, i.customer?.gstin);
    return g ? { section: g.section, why: g.reason } : { section: null, why: null };
  };

  if (pick) {
    const s = sectionFor(pick.rate);
    const basis = pick.base > 0
      ? pick.on === "whole"
        ? `${rupee(tds)} is ${pick.rate}% of the whole sale's taxable ${rupee(pick.base)} — the customer deducted on the full contract, not only this part.`
        : `${rupee(tds)} is ${pick.rate}% of the taxable value ${rupee(pick.base)}.`
      : `${rupee(tds)} looks like ${pick.rate}% TDS.`;
    return { ratePct: pick.rate, section: s.section, likely: true, reason: [basis, s.why && s.section ? `Section ${s.section}: ${s.why}` : null].filter(Boolean).join(" ") };
  }
  if (cRate !== null) {
    const s = sectionFor(cRate);
    return {
      ratePct: cRate, section: s.section, likely: false,
      reason: `This customer's usual TDS is ${cSection ? `${cSection} @ ` : ""}${cRate}% — check it against the Form 16A.`,
    };
  }
  return {
    ratePct: null, section: null, likely: false,
    reason: "The amount does not show the rate — enter the rate and section from the customer's Form 16A / 26AS.",
  };
}

/** The typed rate box → a rate %, or null when empty / not a % in (0, 100]. Two decimals. */
export function parseTdsRate(text: string | null | undefined): number | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** Why "TDS deducted" cannot be saved yet, or null. */
export function bankTdsProblem(rateText: string | null | undefined, section: string | null | undefined): string | null {
  if (parseTdsRate(rateText) === null) {
    return (rateText ?? "").trim() ? "TDS rate is a % between 0 and 100." : "Enter the TDS rate (%) the customer deducted at.";
  }
  if (!(section ?? "").trim()) return "Choose the TDS section the customer deducted under.";
  return null;
}


/** The highest TDS rate a customer may deduct (no PAN → 20%, s.206AA). A bigger gap is never TDS. */
export const MAX_TDS_RATE_PCT = 20;

/**
 * R-2558: the answer to "why less came in" to pre-choose — only what the amounts prove:
 * the gap IS TDS at a known rate → "tds"; the gap is more than any TDS could be (over 20% of the
 * due) → "part"; anything else → null, the owner picks (it used to default to Part payment).
 */
export function shortChoiceDefault(shortBy: number, due: number, tdsLikely: boolean): "tds" | "part" | null {
  if (tdsLikely) return "tds";
  if (due > 0 && shortBy > (due * MAX_TDS_RATE_PCT) / 100) return "part";
  return null;
}
