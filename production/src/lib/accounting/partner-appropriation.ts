/**
 * R-1849 (epic R-1841, Phase 2) — the year-end split of a firm's profit among its partners
 * (the P&L appropriation), as pure, tested sums. Whole rupees. No I/O.
 *
 *   1. Interest on capital — the deed's rate, at most 12% simple a year, on the partner's
 *      capital at the start of the year (pro rata for the days in the firm).
 *   2. Remuneration to WORKING partners — the deed's amounts, all partners together at most
 *      the legal limit on the book profit (book profit = net profit after interest; our P&L
 *      has no partner remuneration in it, so nothing is added back). Over the limit → each
 *      partner's amount is cut in proportion (Pardeep, 25 Oct: the app caps at the legal limit).
 *   3. The rest — by the profit-sharing ratio of the partners register (R-1847).
 *   4. TDS on interest + remuneration (not on the share of profit): 10% of the whole amount
 *      once a partner's total for the year is above ₹20,000 — from 1 Apr 2025.
 *
 * ONE place for the legal figures (R-1841 decision 6). Sources, read 25 Oct 2026:
 *   • Income-tax Act 2025, s.35(e)(iii) remuneration slab, s.35(e)(iv) 12% interest, s.35(e)(v)
 *     "book profit" — https://www.incometaxindia.gov.in/w/section-35-181
 *   • Income-tax Act 2025, s.393(3) Table Sl. 7 (firm → partner: salary, remuneration,
 *     commission, bonus or interest; 10%; ₹20,000) — https://www.incometaxindia.gov.in/w/section-393-5
 *   • Income-tax Act 1961, s.40(b)(iv) "twelve per cent simple interest per annum" and the
 *     AY 2010-11 slab (first ₹3,00,000: ₹1,50,000 or 90%; balance 60%) — https://www.incometaxindia.gov.in/w/section-40
 *   • Memorandum to the Finance (No. 2) Bill 2024 (Ministry of Finance): new slab (first
 *     ₹6,00,000: ₹3,00,000 or 90%; balance 60%) from AY 2025-26 = FY 2024-25; new s.194T
 *     (10%, above ₹20,000, incl. credit to capital account) from 1 Apr 2025 —
 *     https://www.indiabudget.gov.in/budget2024-25/doc/memo.pdf
 * Hitesh / the CA confirms (card R-1849 step).
 */
import { splitProfit } from "./partner-capital";
import { rupee } from "@/lib/utils";

const ITD_S35 = "https://www.incometaxindia.gov.in/w/section-35-181";
const ITD_S40 = "https://www.incometaxindia.gov.in/w/section-40";
const MEMO_2024 = "https://www.indiabudget.gov.in/budget2024-25/doc/memo.pdf";
const ITD_S393 = "https://www.incometaxindia.gov.in/w/section-393-5";

/** s.40(b)(iv) (1961) / s.35(e)(iv) (2025): interest to a partner, simple, per annum. */
export const MAX_PARTNER_INTEREST_PCT = 12;

export interface RemunerationRule {
  /** First slab of book profit, ₹. */
  firstSlab: number;
  /** On the first slab (or a loss): this much, or firstPct of book profit, whichever is more. */
  floor: number;
  firstPct: number;
  /** On the balance of book profit. */
  balancePct: number;
  section: string;
  source: string;
}

/** fyStart = the year the FY begins (2025 → FY 2025-26). */
export function remunerationRule(fyStart: number): RemunerationRule {
  if (fyStart >= 2026) {
    return { firstSlab: 600_000, floor: 300_000, firstPct: 90, balancePct: 60, section: "s.35(e)(iii), Income-tax Act 2025", source: ITD_S35 };
  }
  if (fyStart >= 2024) {
    return { firstSlab: 600_000, floor: 300_000, firstPct: 90, balancePct: 60, section: "s.40(b)(v), Income-tax Act 1961", source: MEMO_2024 };
  }
  return { firstSlab: 300_000, floor: 150_000, firstPct: 90, balancePct: 60, section: "s.40(b)(v), Income-tax Act 1961", source: ITD_S40 };
}

export function interestSection(fyStart: number): { section: string; source: string } {
  return fyStart >= 2026
    ? { section: "s.35(e)(iv), Income-tax Act 2025", source: ITD_S35 }
    : { section: "s.40(b)(iv), Income-tax Act 1961", source: ITD_S40 };
}

/** Most remuneration all working partners together may get, whole rupees. */
export function maxRemuneration(bookProfit: number, fyStart: number): number {
  const r = remunerationRule(fyStart);
  if (bookProfit <= 0) return r.floor;
  const first = Math.min(bookProfit, r.firstSlab);
  const rest = Math.max(0, bookProfit - r.firstSlab);
  return Math.round(Math.max(r.floor, (first * r.firstPct) / 100) + (rest * r.balancePct) / 100);
}

export interface PartnerTdsRule { ratePct: number; threshold: number; section: string; source: string }

/** TDS on payments by a firm to its partners — null before 1 Apr 2025. */
export function partnerTdsRule(fyStart: number): PartnerTdsRule | null {
  if (fyStart >= 2026) return { ratePct: 10, threshold: 20_000, section: "s.393(3) Table Sl. 7, Income-tax Act 2025", source: ITD_S393 };
  if (fyStart >= 2025) return { ratePct: 10, threshold: 20_000, section: "s.194T, Income-tax Act 1961", source: MEMO_2024 };
  return null;
}

/** TDS on the year's interest + remuneration to one partner: on the whole amount once above the threshold. */
export function partnerTds(fyStart: number, amount: number): number {
  const r = partnerTdsRule(fyStart);
  if (!r || amount <= r.threshold) return 0;
  return Math.round((amount * r.ratePct) / 100);
}

/** `total` split in proportion to `weights`, whole rupees, adding up exactly (largest remainder). */
export function scaleToTotal(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  return splitProfit(total, weights.map((w) => (Math.max(0, w) * 100) / sum));
}

const fyBounds = (fyStart: number) => ({ start: `${fyStart}-04-01`, end: `${fyStart + 1}-03-31` });
const dayMs = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs) + 1;

/**
 * A partner's capital at the start of the year — what interest is worked on:
 * the register's contribution + capital introduced − drawings dated before 1 April (and after
 * the CA's opening date, which already holds earlier ones) + earlier years' posted splits
 * (net of TDS). Never below zero.
 */
export function capitalAtFyStart(i: {
  fyStart: number;
  contribution: number;
  openingAsOf: string | null;
  movements: readonly { kind: string; amount: number; movement_date: string }[];
  earlierPostedNet: number;
}): number {
  const start = fyBounds(i.fyStart).start;
  const moved = i.movements
    .filter((m) => m.movement_date < start && !(i.openingAsOf && m.movement_date <= i.openingAsOf))
    .reduce((s, m) => s + (m.kind === "drawings" ? -m.amount : m.amount), 0);
  return Math.max(0, Math.round(i.contribution + moved + i.earlierPostedNet));
}

export interface AppropriationPartner {
  id: string;
  name: string;
  sharePct: number;
  /** Capital interest is worked on (capitalAtFyStart, or as the deed says). */
  capitalBase: number;
  joinedOn: string | null;
  leftOn: string | null;
  pan: string | null;
}

export interface DeedTerms {
  /** Interest on capital as per the deed, % a year. */
  interestPct: number;
  /** Remuneration for the year as per the deed, ₹. */
  remuneration: number;
  working: boolean;
}

export interface AppropriationLine {
  partnerId: string;
  name: string;
  sharePct: number;
  capitalBase: number;
  interestDays: number;
  deedInterestPct: number;
  interestPct: number;
  interestCapped: boolean;
  interest: number;
  working: boolean;
  deedRemuneration: number;
  remuneration: number;
  profitShare: number;
  /** interest + remuneration — what TDS is on. */
  tdsBase: number;
  tds: number;
  /** interest + remuneration + share of profit — credited to the capital account. */
  credited: number;
  /** credited − TDS. */
  net: number;
}

export interface Appropriation {
  fyStart: number;
  fyEnd: string;
  netProfit: number;
  interestTotal: number;
  bookProfit: number;
  maxRemuneration: number;
  remunerationAsked: number;
  remunerationTotal: number;
  remunerationOver: number;
  residual: number;
  tdsTotal: number;
  lines: AppropriationLine[];
  /** Red: posting is not possible until these are fixed. */
  blockers: string[];
  /** Amber: post is possible; the person should know. */
  warnings: string[];
}

export function partnerAppropriation(input: {
  fyStart: number;
  /** P&L net profit for the year (before any partner interest / remuneration). Null = loading. */
  netProfit: number | null;
  partners: readonly AppropriationPartner[];
  terms: Readonly<Record<string, DeedTerms | undefined>>;
  /** Today's date (IST), YYYY-MM-DD. */
  today: string;
}): Appropriation {
  const { start, end } = fyBounds(input.fyStart);
  const fyDays = days(start, end);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const netProfit = input.netProfit ?? 0;

  /* In the firm on any day of the year; the ratio is the one on 31 March. */
  const inYear = input.partners
    .filter((p) => !(p.joinedOn && p.joinedOn > end) && !(p.leftOn && p.leftOn < start))
    .slice().sort((a, b) => a.name.localeCompare(b.name));

  const iRule = MAX_PARTNER_INTEREST_PCT;
  const pre = inYear.map((p) => {
    const t = input.terms[p.id] ?? { interestPct: 0, remuneration: 0, working: false };
    const from = p.joinedOn && p.joinedOn > start ? p.joinedOn : start;
    const to = p.leftOn && p.leftOn < end ? p.leftOn : end;
    const interestDays = Math.max(0, days(from, to));
    const deedPct = Math.max(0, Number(t.interestPct) || 0);
    const pct = Math.min(deedPct, iRule);
    const interest = Math.round((Math.max(0, p.capitalBase) * pct * interestDays) / (100 * fyDays));
    if (deedPct > iRule) warnings.push(`${p.name}: the deed says ${deedPct}% interest — only ${iRule}% is allowed, so ${iRule}% is used.`);
    const deedRem = Math.max(0, Math.round(Number(t.remuneration) || 0));
    if (!t.working && deedRem > 0) warnings.push(`${p.name} is not a working partner — remuneration to a partner who does not work in the business is not allowed, so none is given.`);
    return { p, t, interestDays, deedPct, pct, interest, deedRem: t.working ? deedRem : 0, deedRemTyped: deedRem };
  });

  const interestTotal = pre.reduce((s, x) => s + x.interest, 0);
  const bookProfit = netProfit - interestTotal;
  const maxRem = maxRemuneration(bookProfit, input.fyStart);
  const asked = pre.reduce((s, x) => s + x.deedRem, 0);
  const remTotal = Math.min(asked, maxRem);
  const rems = asked > maxRem ? scaleToTotal(maxRem, pre.map((x) => x.deedRem)) : pre.map((x) => x.deedRem);
  const over = asked - remTotal;
  if (over > 0) {
    warnings.push(`Remuneration in the deed is ${rupee(asked)} but the law allows only ${rupee(maxRem)} on a book profit of ${rupee(bookProfit)} — ${rupee(over)} would not be allowed as an expense for tax, so each partner's remuneration is cut in proportion.`);
  }

  const residual = netProfit - interestTotal - remTotal;
  const sharing = pre.filter((x) => !(x.p.leftOn && x.p.leftOn < end));
  const shares = splitProfit(residual, sharing.map((x) => Number(x.p.sharePct)));
  const shareOf = new Map(sharing.map((x, i) => [x.p.id, shares[i]]));

  const lines: AppropriationLine[] = pre.map((x, i) => {
    const remuneration = rems[i];
    const profitShare = shareOf.get(x.p.id) ?? 0;
    const tdsBase = x.interest + remuneration;
    const tds = partnerTds(input.fyStart, tdsBase);
    if (tds > 0 && !x.p.pan) warnings.push(`${x.p.name} has no PAN in the partners register — TDS may have to be at a higher rate. Add the PAN first.`);
    const credited = x.interest + remuneration + profitShare;
    return {
      partnerId: x.p.id, name: x.p.name, sharePct: Number(x.p.sharePct), capitalBase: Math.max(0, x.p.capitalBase),
      interestDays: x.interestDays, deedInterestPct: x.deedPct, interestPct: x.pct, interestCapped: x.deedPct > iRule,
      interest: x.interest, working: x.t.working, deedRemuneration: x.deedRemTyped, remuneration, profitShare,
      tdsBase, tds, credited, net: credited - tds,
    };
  });

  if (input.netProfit === null) blockers.push("The year's profit is still loading.");
  if (inYear.length === 0) blockers.push("Add the partners in the partners register (Settings → Company → Partners) first.");
  const pctTotal = Math.round(sharing.reduce((s, x) => s + Number(x.p.sharePct) * 100, 0)) / 100;
  if (sharing.length > 0 && Math.abs(pctTotal - 100) > 0.01 * sharing.length) {
    blockers.push(`Profit shares add up to ${pctTotal}% — they must add up to 100% before the profit can be split. Fix them in the partners register.`);
  }
  if (input.today <= end) {
    const d = new Date(`${end}T00:00:00Z`);
    const label = `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
    blockers.push(`The year is not over yet — you can post the split after ${label}. The figures below are a preview.`);
  }

  return {
    fyStart: input.fyStart, fyEnd: end, netProfit, interestTotal, bookProfit, maxRemuneration: maxRem,
    remunerationAsked: asked, remunerationTotal: remTotal, remunerationOver: over, residual,
    tdsTotal: lines.reduce((s, l) => s + l.tds, 0), lines, blockers, warnings,
  };
}
