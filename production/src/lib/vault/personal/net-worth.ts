/**
 * Personal net worth — what the owner is actually worth, from hand-entered figures.
 *
 * ─── EVERY NUMBER HERE IS SOMETHING A PERSON TYPED ──────────────────────────
 * Nothing in this feature talks to a market feed, an AMC, or a bank. A portfolio total
 * is therefore only as true as the last time somebody updated it, and a big confident
 * figure computed from a value typed six months ago is worse than no figure — it gets
 * used to make a decision. So every total comes back with how stale its inputs are, and
 * the UI is expected to show that, not bury it.
 *
 * ─── SIGNS LIVE IN ONE PLACE ────────────────────────────────────────────────
 * A credit card balance is stored POSITIVE and is subtracted here. The alternative —
 * storing card debt negative — means the sign convention has to be remembered by every
 * form, every import and every report, and the first place that forgets turns a ₹80,000
 * debt into ₹80,000 of assets, a ₹1.6L swing in the wrong direction.
 *
 * All amounts are whole rupees.
 */

import { openOweHoldTotal, owedTotal, type OweHoldLike } from "./owe-hold";

export type AccountKind = "savings" | "current" | "credit_card" | "fd" | "rd" | "ppf" | "cash" | "wallet";

export type AssetClass =
  | "mutual_fund" | "stock" | "real_estate" | "gold" | "sgb"
  | "lic" | "ppf" | "epf" | "nps" | "fd" | "bond" | "crypto" | "other";

export const ACCOUNT_KINDS: readonly AccountKind[] = [
  "savings", "current", "credit_card", "fd", "rd", "ppf", "cash", "wallet",
] as const;

export const ASSET_CLASSES: readonly AssetClass[] = [
  "mutual_fund", "stock", "real_estate", "gold", "sgb",
  "lic", "ppf", "epf", "nps", "fd", "bond", "crypto", "other",
] as const;

/** Kinds that are money you OWE rather than money you HAVE. */
const LIABILITY_KINDS: readonly AccountKind[] = ["credit_card"] as const;

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  savings: "Savings",
  current: "Current",
  credit_card: "Credit card",
  fd: "Fixed deposit",
  rd: "Recurring deposit",
  ppf: "PPF",
  cash: "Cash",
  wallet: "Wallet / UPI",
};

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  mutual_fund: "Mutual funds",
  stock: "Stocks",
  real_estate: "Real estate",
  gold: "Gold",
  sgb: "Sovereign Gold Bonds",
  lic: "LIC / insurance",
  ppf: "PPF",
  epf: "EPF",
  nps: "NPS",
  fd: "Fixed deposits",
  bond: "Bonds",
  crypto: "Crypto",
  other: "Other",
};

export interface PersonalAccountLike {
  kind: AccountKind;
  balance: number;
  is_active?: boolean;
}

export interface PersonalHoldingLike {
  asset_class: AssetClass;
  invested: number;
  current_value: number;
  valued_on?: string | null;
}

export interface ClassRollup {
  assetClass: AssetClass;
  label: string;
  invested: number;
  currentValue: number;
  gain: number;
  /** Null when nothing was invested — a percentage against zero is not a number. */
  gainPct: number | null;
  /** Share of the total portfolio, 0–100. Null when the portfolio is worth nothing. */
  sharePct: number | null;
  count: number;
}

export interface NetWorth {
  /** Bank + deposits + cash + wallets, excluding anything owed. */
  liquidAssets: number;
  /** Market value of the investment portfolio. */
  investments: number;
  /** Credit-card debt (what is owed on cards). Positive number. */
  liabilities: number;
  /** R-2386: open "Money I owe / hold for others" — advances received, money held for someone. */
  oweHoldOpen: number;
  /** Everything owed: liabilities (cards) + oweHoldOpen (+ loans, R-2388). */
  owedTotal: number;
  /** liquidAssets + investments - owedTotal. Can legitimately be negative. */
  net: number;

  investedTotal: number;
  portfolioGain: number;
  portfolioGainPct: number | null;

  byClass: ClassRollup[];

  /** Holdings with no `valued_on` at all. */
  neverValuedCount: number;
  /** Holdings whose `valued_on` is older than STALE_AFTER_DAYS. */
  staleCount: number;
  /** How much of `investments` sits behind a stale or never-set valuation. */
  staleValue: number;
}

/**
 * After this long, a hand-typed valuation is reported as stale.
 *
 * 90 days rather than 30: a quarter is roughly how often somebody actually opens their
 * CAMS statement, and a warning that is always on is a warning nobody reads.
 */
export const STALE_AFTER_DAYS = 90;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/** Whole rupees in, whole rupees out. Guards against a NaN reaching a total. */
function rupees(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function isLiabilityAccount(kind: AccountKind): boolean {
  return LIABILITY_KINDS.includes(kind);
}

/**
 * Roll everything up.
 *
 * `now` is a parameter and not `new Date()` so staleness can be tested at a chosen date
 * rather than by waiting three months.
 */
export function computeNetWorth(
  accounts: PersonalAccountLike[],
  holdings: PersonalHoldingLike[],
  now: Date,
  /** R-2386: "Money I owe / hold for others" — only OPEN entries are subtracted. */
  oweHold: readonly OweHoldLike[] = [],
): NetWorth {
  let liquidAssets = 0;
  let liabilities = 0;

  for (const a of accounts) {
    // A closed account is history, not holdings. Including it would inflate net worth
    // with money that is not there.
    if (a.is_active === false) continue;
    const bal = rupees(a.balance);
    if (isLiabilityAccount(a.kind)) liabilities += bal;
    else liquidAssets += bal;
  }

  let investments = 0;
  let investedTotal = 0;
  let neverValuedCount = 0;
  let staleCount = 0;
  let staleValue = 0;

  const byClassMap = new Map<AssetClass, ClassRollup>();

  for (const h of holdings) {
    const current = rupees(h.current_value);
    const invested = rupees(h.invested);

    investments += current;
    investedTotal += invested;

    if (!h.valued_on) {
      neverValuedCount++;
      staleValue += current;
    } else {
      const valued = new Date(h.valued_on);
      if (Number.isNaN(valued.getTime())) {
        // An unparseable date is not a fresh one. Counting it as never-valued is the
        // conservative reading and keeps the warning honest.
        neverValuedCount++;
        staleValue += current;
      } else if (daysBetween(now, valued) > STALE_AFTER_DAYS) {
        staleCount++;
        staleValue += current;
      }
    }

    const existing = byClassMap.get(h.asset_class);
    if (existing) {
      existing.invested += invested;
      existing.currentValue += current;
      existing.count += 1;
    } else {
      byClassMap.set(h.asset_class, {
        assetClass: h.asset_class,
        label: ASSET_CLASS_LABEL[h.asset_class] ?? h.asset_class,
        invested,
        currentValue: current,
        gain: 0,
        gainPct: null,
        sharePct: null,
        count: 1,
      });
    }
  }

  const byClass = Array.from(byClassMap.values())
    .map((r) => ({
      ...r,
      gain: r.currentValue - r.invested,
      gainPct: r.invested > 0 ? ((r.currentValue - r.invested) / r.invested) * 100 : null,
      sharePct: investments > 0 ? (r.currentValue / investments) * 100 : null,
    }))
    // Biggest holding first — that is the one a decision is about.
    .sort((a, b) => b.currentValue - a.currentValue);

  const oweHoldOpen = openOweHoldTotal(oweHold);
  const owed = owedTotal({ cardDues: liabilities, oweHoldOpen });

  return {
    liquidAssets,
    investments,
    liabilities,
    oweHoldOpen,
    owedTotal: owed,
    net: liquidAssets + investments - owed,
    investedTotal,
    portfolioGain: investments - investedTotal,
    portfolioGainPct: investedTotal > 0 ? ((investments - investedTotal) / investedTotal) * 100 : null,
    byClass,
    neverValuedCount,
    staleCount,
    staleValue,
  };
}

export interface PersonalTransactionLike {
  kind: "drawing" | "dividend" | "salary" | "interest" | "other_income" | "expense";
  amount: number;
  occurred_on: string;
  category?: string | null;
}

export interface CashFlowSummary {
  /** Money that came out of the business or otherwise arrived. */
  moneyIn: number;
  /** Household and personal spending. */
  moneyOut: number;
  net: number;
  /** Only drawings + dividends — what was actually taken out of the company. */
  drawnFromCompany: number;
  byCategory: { category: string; total: number; count: number }[];
  count: number;
}

const INCOME_KINDS = new Set(["drawing", "dividend", "salary", "interest", "other_income"]);
const FROM_COMPANY_KINDS = new Set(["drawing", "dividend"]);

/**
 * Summarise a period's personal cash flow.
 *
 * `drawnFromCompany` is separated from the rest of the income on purpose: it is the one
 * figure with a counterpart in the company's books, so it is the one an accountant will
 * ask about at year end. Salary and interest are personal income that never touched the
 * business, and adding them to the same number would make it unanswerable.
 */
export function summariseCashFlow(transactions: PersonalTransactionLike[]): CashFlowSummary {
  let moneyIn = 0;
  let moneyOut = 0;
  let drawnFromCompany = 0;

  const catMap = new Map<string, { total: number; count: number }>();

  for (const t of transactions) {
    const amount = rupees(t.amount);
    if (amount <= 0) continue; // the CHECK enforces this in the DB; belt and braces

    if (INCOME_KINDS.has(t.kind)) {
      moneyIn += amount;
      if (FROM_COMPANY_KINDS.has(t.kind)) drawnFromCompany += amount;
    } else {
      moneyOut += amount;
      // Categories are only meaningful for spending. Bucketing income by category would
      // put "Salary" next to "Groceries" in the same list.
      const key = (t.category ?? "").trim() || "Uncategorised";
      const cur = catMap.get(key) ?? { total: 0, count: 0 };
      cur.total += amount;
      cur.count += 1;
      catMap.set(key, cur);
    }
  }

  const byCategory = Array.from(catMap.entries())
    .map(([category, v]) => ({ category, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);

  return {
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    drawnFromCompany,
    byCategory,
    count: transactions.length,
  };
}

/** Personal spending buckets. Indian household vocabulary, not a US chart of accounts. */
export const PERSONAL_EXPENSE_CATEGORIES = [
  "Household",
  "Groceries",
  "Rent / EMI",
  "Utilities",
  "Education / Fees",
  "Medical",
  "Insurance Premium",
  "Travel",
  "Vehicle / Fuel",
  "Family Support",
  "Festival / Gifts",
  "Investment",
  "Tax",
  "Other",
] as const;
