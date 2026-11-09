/**
 * R-2625 — Advance billing on the Balance Sheet (Management view).
 * Owner's case: a ₹12,000 yearly invoice dated 1 Oct (Google Workspace, 12 months). The P&L
 * Management view earns ₹1,000 a month (R-2624); the part not earned yet is Advance billing:
 *   at 31 Oct → 12,000 − 1,000 = ₹11,000; at 9 Nov → 12,000 − 1,000 − 300 (Nov by days) = ₹10,700.
 * The statutory sheet (balanceSheetTotals) never changes; the management view still balances.
 */
import { describe, it, expect } from "vitest";
import { advanceBillingOf, balanceSheetTotals, managementBalanceSheet } from "./balance-sheet-totals";
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";

const rev = (inv: number, cn = 0, dn = 0) => ({ inv_taxable: inv, cn_taxable: cn, dn_taxable: dn });

describe("R-2625 advanceBillingOf — invoiced to date − earned to date", () => {
  it("yearly ₹12,000 dated 1 Oct: ₹11,000 at 31 Oct, ₹10,700 at 9 Nov", () => {
    expect(advanceBillingOf(rev(12_000), rev(1_000))).toEqual({ advance: 11_000, invoiced: 12_000, earned: 1_000 });
    expect(advanceBillingOf(rev(12_000), rev(1_300)).advance).toBe(10_700);
  });

  it("exact in rupees with credit and debit notes on both sides", () => {
    // invoiced 12,000 − CN 6,000 + DN 500 = 6,500; earned 1,000 − 143 + 21 = 878
    const a = advanceBillingOf(rev(12_000, 6_000, 500), rev(1_000, 143, 21));
    expect(a).toEqual({ advance: 5_622, invoiced: 6_500, earned: 878 });
  });

  it("a one-off sale earns whole on its date: nothing left as advance", () => {
    expect(advanceBillingOf(rev(500), rev(500)).advance).toBe(0);
  });

  it("an invoice dated later for months already passed: negative (earned, not yet invoiced)", () => {
    expect(advanceBillingOf(rev(0), rev(2_000)).advance).toBe(-2_000);
  });

  it("numbers arriving as strings (bigint from PostgREST) still add up", () => {
    expect(advanceBillingOf(rev("12000" as unknown as number), rev("1000" as unknown as number)).advance).toBe(11_000);
  });
});

describe("R-2625 managementBalanceSheet — the statutory sheet + Advance billing, still balanced", () => {
  const AUTO = { cashAndBank: 14_160, gstPayable: 2_160, fyLabel: "FY 2026-27" } as unknown as BalanceSheetAuto;

  it("statutory totals unchanged; management adds the liability and lowers net worth by the same", () => {
    const t = balanceSheetTotals(AUTO, []);
    expect(t).toMatchObject({ totalAssets: 14_160, totalLiab: 2_160, netWorth: 12_000 });
    const m = managementBalanceSheet(t, 11_000);
    expect(m).toEqual({ totalAssets: 14_160, totalLiab: 13_160, netWorth: 1_000 });
    expect(m.totalAssets).toBe(m.totalLiab + m.netWorth);
    // the statutory function is not touched by the management view
    expect(balanceSheetTotals(AUTO, [])).toEqual(t);
  });

  it("negative advance is an asset (revenue earned, not yet invoiced) and raises net worth", () => {
    const m = managementBalanceSheet({ totalAssets: 1_000, totalLiab: 0, netWorth: 1_000 }, -2_000);
    expect(m).toEqual({ totalAssets: 3_000, totalLiab: 0, netWorth: 3_000 });
    expect(m.totalAssets).toBe(m.totalLiab + m.netWorth);
  });

  it("zero advance: same as the statutory sheet", () => {
    expect(managementBalanceSheet({ totalAssets: 5, totalLiab: 2, netWorth: 3 }, 0)).toEqual({ totalAssets: 5, totalLiab: 2, netWorth: 3 });
  });
});
