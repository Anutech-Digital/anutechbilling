/**
 * Commission to one person, and when s.194H TDS applies.
 *
 * s.194H: TDS on commission / brokerage once the amount credited to ONE payee in a financial
 * year exceeds ₹20,000 (from FY 2025-26; it was ₹15,000), at 2% (from 1 Oct 2024; it was 5%).
 * Once the year's total crosses the limit, TDS is due on the whole year's commission to that
 * person — so a ₹20,000 payment after ₹5,000 earlier crosses it, and the earlier ₹5,000 is
 * caught too. The screen suggests; the operator (and their CA) decides.
 */

import { fyStartISO } from "@/lib/dates/ist";

export const COMMISSION_CATEGORY = "Commission / Incentive (agents)";
export const TDS_194H_THRESHOLD = 20_000;
export const TDS_194H_RATE_PCT = 2;

export interface CommissionTdsView {
  /** This person's commission this FY before this entry. */
  earlier: number;
  /** Earlier + this entry. */
  yearTotal: number;
  /** True once the year's total is over the threshold. */
  crosses: boolean;
  /** 2% of this entry. */
  tdsOnThis: number;
  /** Earlier commission this FY on which no TDS was recorded — caught up once the limit is crossed. */
  earlierUntaxed: number;
}

export function commissionTdsView(input: {
  amount: number;
  earlier: number;
  earlierWithoutTds: number;
}): CommissionTdsView {
  const amount = Math.max(0, Math.round(input.amount || 0));
  const yearTotal = input.earlier + amount;
  return {
    earlier: input.earlier,
    yearTotal,
    crosses: yearTotal > TDS_194H_THRESHOLD,
    tdsOnThis: Math.round((amount * TDS_194H_RATE_PCT) / 100),
    earlierUntaxed: input.earlierWithoutTds,
  };
}

/** Indian FY start (1 April) for an ISO date, as YYYY-MM-DD. */
export function fyStartOf(isoDate: string): string {
  return fyStartISO(isoDate);
}
