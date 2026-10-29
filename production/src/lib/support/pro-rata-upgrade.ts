/**
 * R-2073 — what a support plan upgrade costs in the middle of a term.
 *
 * Decision D5 (Pardeep, 29 Oct 2026): an UPGRADE may happen any day and is charged
 * pro-rata BY DAYS — the new plan's price for the days left, minus the credit for the
 * old plan's price for those same days. The renewal date does not move. A DOWNGRADE
 * never happens mid-term: it takes effect at renewal, so there is no mid-term credit
 * to pay back.
 *
 *   ₹9,996 Standard yearly → ₹49,992 Enterprise yearly, 183 of 366 days left:
 *     new plan   49,992 × 183 / 366 = ₹24,996.00
 *     credit      9,996 × 183 / 366 = ₹4,998.00
 *     to pay                          ₹19,998 ex-GST (GST is added by the quote)
 *
 * ─── ROUNDING ───────────────────────────────────────────────────────────────
 * Money is whole rupees in the database (CLAUDE.md §13). Each side is computed in
 * integer PAISE from integers (price × days is exact) and rounded ONCE to the paisa;
 * the difference is rounded once more to the whole rupee the quote line stores. No
 * floating rupee ever feeds another division.
 *
 * ─── DAYS ───────────────────────────────────────────────────────────────────
 * `renewalDate` is the first day of the NEXT term (an exclusive end — what
 * followingTermStart() gives for either stored shape of subscriptions.renewal_date).
 * Today counts as a day left: on the last day of the term one day is charged.
 */
import { daysBetweenDates } from "@/lib/subscriptions/proration";
import { supportPrice, supportTier, type SupportTierId } from "./tiers";

export type SupportTerm = "monthly" | "yearly";

/** Free < Standard < Enterprise. */
const RANK: Record<SupportTierId, number> = { free: 0, standard: 1, enterprise: 2 };

export const DOWNGRADE_AT_RENEWAL = "Downgrades take effect at renewal";

export interface ProRataUpgradeInput {
  fromTier:    SupportTierId;
  toTier:      SupportTierId;
  term:        SupportTerm;
  /** First day of the current term (YYYY-MM-DD). */
  termStart:   string;
  /** First day of the next term — the renewal date kept by the upgrade (YYYY-MM-DD). */
  renewalDate: string;
  /** Today in IST (YYYY-MM-DD). */
  today:       string;
  /**
   * The catalogue's own whole-rupee price for one term, when the tenant's row holds one
   * (supportLineRate). Absent → the tier definition in tiers.ts.
   */
  fromPrice?:  number;
  toPrice?:    number;
}

export interface ProRataUpgrade {
  daysLeft:       number;
  daysInTerm:     number;
  /** ₹ (to the paisa) of the new plan for the days left. */
  newTierCharge:  number;
  /** ₹ (to the paisa) of the old plan for the days left — taken off. */
  oldTierCredit:  number;
  /** Whole ₹ to charge, before GST. */
  amountExGst:    number;
  /** The full one-term prices used. */
  fromPrice:      number;
  toPrice:        number;
}

export type ProRataUpgradeResult =
  | ({ ok: true } & ProRataUpgrade)
  | { ok: false; reason: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function wholeRupees(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/** Pro-rata of one whole-rupee term price, in integer paise, rounded once. */
function proRataPaise(price: number, daysLeft: number, daysInTerm: number): number {
  return Math.round((price * 100 * daysLeft) / daysInTerm);
}

export function proRataUpgrade(input: ProRataUpgradeInput): ProRataUpgradeResult {
  const { fromTier, toTier, term } = input;
  if (!(fromTier in RANK) || !(toTier in RANK)) return { ok: false, reason: "Unknown support plan." };
  if (fromTier === toTier) return { ok: false, reason: "The customer is already on this plan." };
  if (RANK[toTier] < RANK[fromTier]) return { ok: false, reason: DOWNGRADE_AT_RENEWAL };

  const termStart = input.termStart.slice(0, 10);
  const renewal = input.renewalDate.slice(0, 10);
  const today = input.today.slice(0, 10);
  if (![termStart, renewal, today].every((d) => ISO.test(d))) {
    return { ok: false, reason: "The subscription has no term dates." };
  }
  const daysInTerm = daysBetweenDates(termStart, renewal);
  if (daysInTerm <= 0) return { ok: false, reason: "The subscription has no term dates." };
  if (today >= renewal) return { ok: false, reason: "This term has ended. Renew on the new plan instead." };
  if (today < termStart) return { ok: false, reason: "This term has not started yet." };
  const daysLeft = daysBetweenDates(today, renewal);

  const fromPrice = wholeRupees(input.fromPrice, supportPrice(supportTier(fromTier), term));
  const toPrice = wholeRupees(input.toPrice, supportPrice(supportTier(toTier), term));
  if (toPrice <= fromPrice) {
    return { ok: false, reason: "The new plan does not cost more than the current one. Change it at renewal." };
  }

  const newPaise = proRataPaise(toPrice, daysLeft, daysInTerm);
  const oldPaise = proRataPaise(fromPrice, daysLeft, daysInTerm);
  return {
    ok: true,
    daysLeft,
    daysInTerm,
    newTierCharge: newPaise / 100,
    oldTierCredit: oldPaise / 100,
    amountExGst: Math.round((newPaise - oldPaise) / 100),
    fromPrice,
    toPrice,
  };
}

/** Parse a tier-plan SKU id: `SUP-STANDARD-YR-<tenant>` → standard / yearly. Null for any other SKU. */
export function parseSupportTierSku(id: string | null | undefined): { tier: SupportTierId; term: SupportTerm } | null {
  const m = /^SUP-(FREE|STANDARD|ENTERPRISE)-(MO|YR)(?:-|$)/.exec(id ?? "");
  if (!m) return null;
  return { tier: m[1].toLowerCase() as SupportTierId, term: m[2] === "YR" ? "yearly" : "monthly" };
}

/** The tiers a plan can be upgraded to, cheapest first. */
export function upgradeTargets(from: SupportTierId): SupportTierId[] {
  return (Object.keys(RANK) as SupportTierId[]).filter((t) => RANK[t] > RANK[from]);
}

/** "₹24,996.00 − ₹4,998.00 = ₹19,998" note text, shown on the quote. */
export function proRataUpgradeNote(args: {
  fromLabel: string; toLabel: string; r: ProRataUpgrade; renewalDateText: string; fmt: (n: number) => string;
}): string {
  const { fromLabel, toLabel, r, renewalDateText, fmt } = args;
  return (
    `Upgrade from ${fromLabel} to ${toLabel} for the ${r.daysLeft} of ${r.daysInTerm} days left in this term: ` +
    `${toLabel} ${fmt(r.toPrice)} × ${r.daysLeft}/${r.daysInTerm} = ${fmt(r.newTierCharge)}, ` +
    `less ${fromLabel} ${fmt(r.fromPrice)} × ${r.daysLeft}/${r.daysInTerm} = ${fmt(r.oldTierCredit)}, ` +
    `= ${fmt(r.amountExGst)} before GST. The renewal date stays ${renewalDateText}; ` +
    `on payment the plan changes to ${toLabel}.`
  );
}
