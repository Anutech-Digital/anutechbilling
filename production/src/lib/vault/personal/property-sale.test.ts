/**
 * R-2393 — property sale rules: cash warning, s.50C value, TDS 194-IA, term, LTCG options,
 * and the open-deal advance joining the R-2386 owe/hold total.
 */
import { describe, it, expect } from "vitest";
import {
  balanceDue,
  capitalGains,
  fyStart,
  isCashWarning,
  monthsHeld,
  openSaleAdvances,
  receivedTotal,
  saleValue,
  tds194IA,
} from "./property-sale";
import { computeNetWorth } from "./net-worth";

describe("R-2393 cash warning (s.269SS / 269ST)", () => {
  it("warns on cash of ₹20,000 or more, never on bank or cheque", () => {
    expect(isCashWarning("cash", 5_00_000)).toBe(true);
    expect(isCashWarning("cash", 20_000)).toBe(true);
    expect(isCashWarning("cash", 19_999)).toBe(false);
    expect(isCashWarning("bank", 5_00_000)).toBe(false);
    expect(isCashWarning("cheque", 5_00_000)).toBe(false);
  });
});

describe("R-2393 TDS 194-IA", () => {
  it("1% of ₹60 L is ₹60,000; below ₹50 L none", () => {
    expect(tds194IA(60_00_000, null)).toBe(60_000);
    expect(tds194IA(50_00_000, null)).toBe(50_000);
    expect(tds194IA(49_99_999, null)).toBe(0);
  });
  it("uses the stamp value when it is higher", () => {
    expect(tds194IA(45_00_000, 55_00_000)).toBe(55_000);
  });
});

describe("R-2393 s.50C sale value", () => {
  it("agreed price unless the stamp value is more than 110% of it", () => {
    expect(saleValue(60_00_000, 65_00_000)).toEqual({ value: 60_00_000, usesStampValue: false });
    expect(saleValue(60_00_000, 66_00_000)).toEqual({ value: 60_00_000, usesStampValue: false });
    expect(saleValue(60_00_000, 66_00_001)).toEqual({ value: 66_00_001, usesStampValue: true });
    expect(saleValue(60_00_000, null).value).toBe(60_00_000);
  });
});

describe("R-2393 holding period", () => {
  it("counts whole months; more than 24 = long term", () => {
    expect(monthsHeld("2024-01-15", "2026-01-15")).toBe(24);
    expect(monthsHeld("2024-01-15", "2026-01-14")).toBe(23);
    expect(fyStart("2026-03-31")).toBe(2025);
    expect(fyStart("2026-04-01")).toBe(2026);
    const at24 = capitalGains({ acquiredOn: "2024-01-15", transferOn: "2026-01-15", agreedPrice: 100, stampValue: null, cost: 50, improvements: 0, transferExpenses: 0 });
    expect(at24.term).toBe("short");
    expect(at24.newRegime).toBeNull();
    const at25 = capitalGains({ acquiredOn: "2024-01-15", transferOn: "2026-02-15", agreedPrice: 100, stampValue: null, cost: 50, improvements: 0, transferExpenses: 0 });
    expect(at25.term).toBe("long");
  });
  it("unknown purchase date → no term", () => {
    expect(capitalGains({ acquiredOn: null, transferOn: "2026-01-01", agreedPrice: 100, stampValue: null, cost: 0, improvements: 0, transferExpenses: 0 }).term).toBeNull();
  });
});

describe("R-2393 long-term gain", () => {
  it("bought 2015, sold Mar 2026: 12.5% vs 20% indexed, lower one wins", () => {
    const cg = capitalGains({
      acquiredOn: "2015-06-10", transferOn: "2026-03-20",
      agreedPrice: 60_00_000, stampValue: 58_00_000,
      cost: 25_00_000, improvements: 2_00_000, transferExpenses: 60_000,
    });
    expect(cg.term).toBe("long");
    expect(cg.gain).toBe(60_00_000 - 60_000 - 25_00_000 - 2_00_000); // 32,40,000
    expect(cg.newRegime).toEqual({ tax: 4_05_000, cess: 16_200, total: 4_21_200 });
    // FY 2015-16 CII 254 → FY 2025-26 CII 376
    expect(cg.indexed?.ciiFrom).toBe(254);
    expect(cg.indexed?.ciiTo).toBe(376);
    expect(cg.indexed?.indexedCost).toBe(Math.round((25_00_000 * 376) / 254));
    expect(cg.bestTotal).toBe(Math.min(cg.newRegime!.total, cg.indexed!.total));
  });
  it("bought after 23 Jul 2024: no indexation option", () => {
    const cg = capitalGains({ acquiredOn: "2024-08-01", transferOn: "2026-11-01", agreedPrice: 100_000, stampValue: null, cost: 50_000, improvements: 0, transferExpenses: 0 });
    expect(cg.term).toBe("long");
    expect(cg.indexed).toBeNull();
    expect(cg.indexedMissing).toBeNull();
  });
  it("CII of the sale year not in the app → says so, 12.5% still shown", () => {
    const cg = capitalGains({ acquiredOn: "2010-05-01", transferOn: "2026-11-01", agreedPrice: 60_00_000, stampValue: null, cost: 10_00_000, improvements: 0, transferExpenses: 0 });
    expect(cg.indexed).toBeNull();
    expect(cg.indexedMissing).toContain("FY 2026-27");
    expect(cg.newRegime?.tax).toBe(6_25_000);
  });
  it("a loss is never taxed", () => {
    const cg = capitalGains({ acquiredOn: "2015-01-01", transferOn: "2025-12-01", agreedPrice: 10_00_000, stampValue: null, cost: 20_00_000, improvements: 0, transferExpenses: 0 });
    expect(cg.gain).toBeLessThan(0);
    expect(cg.newRegime?.total).toBe(0);
  });
});

describe("R-2393 receipts and net worth", () => {
  const sales = [
    { id: "s1", status: "agreement" as const, agreed_price: 65_00_000, tds_deducted: 0 },
    { id: "s2", status: "registered" as const, agreed_price: 60_00_000, tds_deducted: 60_000 },
    { id: "s3", status: "cancelled" as const, agreed_price: 10_00_000 },
  ];
  const receipts = [
    { sale_id: "s1", amount: 5_00_000 },
    { sale_id: "s2", amount: 5_00_000 },
    { sale_id: "s2", amount: 54_40_000 },
    { sale_id: "s3", amount: 1_00_000 },
  ];

  it("received and balance due (price − received − TDS)", () => {
    expect(receivedTotal("s1", receipts)).toBe(5_00_000);
    expect(balanceDue(sales[0], receipts)).toBe(60_00_000);
    expect(balanceDue(sales[1], receipts)).toBe(0);
  });

  it("only an open deal's money is owed to the buyer", () => {
    expect(openSaleAdvances(sales, receipts)).toEqual([{ amount: 5_00_000, status: "open" }]);
  });

  it("byana ₹5 L on an open deal: net worth unchanged by the cash; sold property leaves net worth", () => {
    const now = new Date("2026-11-03T00:00:00Z");
    const cash = [{ kind: "cash" as const, balance: 5_00_000 }];
    const flat = { asset_class: "real_estate" as const, invested: 25_00_000, current_value: 60_00_000, valued_on: "2026-10-01" };
    const open = computeNetWorth(cash, [flat], now, openSaleAdvances(sales.slice(0, 1), receipts));
    expect(open.net).toBe(60_00_000);
    const sold = computeNetWorth([{ kind: "savings", balance: 59_40_000 }], [{ ...flat, sold_on: "2026-11-02" }], now, []);
    expect(sold.investments).toBe(0);
    expect(sold.net).toBe(59_40_000);
  });
});
