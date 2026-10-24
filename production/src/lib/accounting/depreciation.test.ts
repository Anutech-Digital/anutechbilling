import { describe, it, expect } from "vitest";
import {
  depreciationSchedule, wdvAtFyEnd, bookValueNow, registerSummary, fyStartOf, type AssetLike,
  accumulatedDepreciation, depreciationForRange, bookValueAt, netBlockAt, registerDepreciationForRange,
} from "./depreciation";

const laptop: AssetLike = { id: "a", name: "MacBook", block: "computers", cost: 120_000, put_to_use: "2024-06-10" };

describe("Income-tax WDV depreciation", () => {
  it("40% on the opening WDV each year, whole rupees", () => {
    const s = depreciationSchedule(laptop, 2026);
    expect(s.map((r) => [r.fyLabel, r.depreciation, r.closing])).toEqual([
      ["2024-25", 48_000, 72_000],
      ["2025-26", 28_800, 43_200],
      ["2026-27", 17_280, 25_920],
    ]);
    expect(s[0].halfRate).toBe(false);
  });

  it("put to use under 180 days in the year → half rate that year only", () => {
    const late: AssetLike = { ...laptop, put_to_use: "2024-11-15" };   // 137 days to 31 Mar
    const s = depreciationSchedule(late, 2025);
    expect(s[0]).toMatchObject({ ratePct: 20, halfRate: true, depreciation: 24_000, closing: 96_000 });
    expect(s[1]).toMatchObject({ ratePct: 40, depreciation: 38_400 });
    // 4 Oct 2024 → 179 days: half; 3 Oct → 180: full
    expect(depreciationSchedule({ ...laptop, put_to_use: "2024-10-04" }, 2024)[0].halfRate).toBe(true);
    expect(depreciationSchedule({ ...laptop, put_to_use: "2024-10-03" }, 2024)[0].halfRate).toBe(false);
  });

  it("nothing in the year of disposal; the row says the gain or loss", () => {
    const sold: AssetLike = { ...laptop, disposed_on: "2026-07-01", disposal_value: 30_000 };
    const s = depreciationSchedule(sold, 2027);
    expect(s).toHaveLength(3);
    expect(s[2]).toMatchObject({ fy: 2026, depreciation: 0, closing: 0 });
    expect(s[2].note).toMatch(/short-term loss ₹13,200/);
    expect(wdvAtFyEnd(sold, 2027)).toBe(0);
  });

  it("book value today = last year's closing WDV; cost in the year of purchase; 0 once sold", () => {
    expect(bookValueNow(laptop, "2026-09-27")).toBe(43_200);
    expect(bookValueNow({ ...laptop, put_to_use: "2026-05-01" }, "2026-09-27")).toBe(120_000);
    expect(bookValueNow({ ...laptop, disposed_on: "2026-07-01" }, "2026-09-27")).toBe(0);
    expect(bookValueNow(laptop, "2024-01-01")).toBe(0);
  });

  it("register summary groups by block for a year", () => {
    const chair: AssetLike = { id: "b", name: "Chairs", block: "furniture", cost: 40_000, put_to_use: "2025-04-01" };
    const r = registerSummary([laptop, chair], 2026);
    expect(r.byBlock.map((b) => [b.block, b.depreciation, b.closingWdv])).toEqual([
      ["computers", 17_280, 25_920],
      ["furniture", 3_600, 32_400],
    ]);
    expect(r.openingWdv).toBe(43_200 + 36_000);
    expect(r.depreciation).toBe(20_880);
    expect(r.closingWdv).toBe(58_320);
    expect(r.cost).toBe(160_000);
  });

  it("R-1578: accumulated depreciation runs day by day inside a year and lands on the register's figure", () => {
    // laptop 10 Jun 2024: FY 24-25 ₹48,000 over 295 days (10 Jun → 31 Mar), FY 25-26 ₹28,800 over 365 days
    expect(accumulatedDepreciation(laptop, "2024-06-09")).toBe(0);
    expect(accumulatedDepreciation(laptop, "2024-06-10")).toBe(Math.round(48_000 / 295));
    expect(accumulatedDepreciation(laptop, "2025-03-31")).toBe(48_000);
    expect(accumulatedDepreciation(laptop, "2025-04-30")).toBe(48_000 + Math.round((28_800 * 30) / 365));
    expect(accumulatedDepreciation(laptop, "2026-03-31")).toBe(76_800);
    expect(depreciationForRange(laptop, "2025-04-01", "2026-03-31")).toBe(28_800);
    expect(depreciationForRange(laptop, "2026-04-01", "2026-03-31")).toBe(0);
  });

  it("R-1578: book value on a date = cost − accumulated; 0 before use and once sold; sold asset stops depreciating", () => {
    expect(bookValueAt(laptop, "2026-03-31")).toBe(43_200);
    expect(bookValueAt(laptop, "2024-01-01")).toBe(0);
    const sold: AssetLike = { ...laptop, disposed_on: "2026-07-01", disposal_value: 30_000 };
    expect(bookValueAt(sold, "2026-07-01")).toBe(0);
    expect(depreciationForRange(sold, "2026-04-01", "2026-06-30")).toBe(0);   // nothing in the year of disposal
    const chair: AssetLike = { id: "b", name: "Chairs", block: "furniture", cost: 40_000, put_to_use: "2025-04-01" };
    const nb = netBlockAt([laptop, sold, chair], "2026-03-31");
    expect(nb).toEqual({ cost: 280_000, accumulated: 76_800 * 2 + 4_000, net: 280_000 - 157_600 });
    expect(netBlockAt([sold], "2026-07-02")).toEqual({ cost: 0, accumulated: 0, net: 0 });
    expect(registerDepreciationForRange([laptop, chair], "2026-04-01", "2027-03-31", "2027-04-10")).toBe(17_280 + 3_600);   // R-1808: a year already over
  });

  it("fyStartOf", () => {
    expect(fyStartOf("2026-03-31")).toBe(2025);
    expect(fyStartOf("2026-04-01")).toBe(2026);
  });
});
