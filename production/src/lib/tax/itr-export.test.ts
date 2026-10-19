/**
 * CSV builder ke test — jo cheez file me HONI CHAHIYE uski maujoodgi, aur
 * amounts ka kaccha (integer) hona.
 */
import { describe, it, expect } from "vitest";
import { computeItrPack, financialYear, type ItrSources } from "./itr";
import { itrCsvRows, ITR_CSV_HEADERS } from "./itr-export";

const SOURCES: ItrSources = {
  revenueExGst: 1_500_000, invoiceCount: 10, creditNoteCount: 0, debitNoteCount: 0,
  cogs: 500_000, cogsCount: 5, placedPoCost: 0, placedPoCount: 0,
  commissions: 0, commissionsCount: 0,
  expenses: [{ category: "Hosting", amount: 118_000, itc: 18_000, count: 3 }],
  tdsCredit: 50_000, tdsCount: 4,
  advanceTaxPaid: 0,
};

describe("itrCsvRows", () => {
  const pack = computeItrPack(financialYear(2026), SOURCES);
  const rows = itrCsvRows(pack);
  const flat = rows.map((r) => r.join("|")).join("\n");

  it("amounts kacche integer hain, formatted string nahi", () => {
    // ₹15,00,000 formatted hota to Excel jod nahi pata. Kaccha 1500000 hona chahiye.
    expect(flat).toContain("1500000");
    expect(flat).not.toContain("₹15,00,000");
  });

  it("dono regime, TDS (minus me), net payable aur advance-tax schedule maujood hain", () => {
    expect(flat).toContain("115BAA");
    expect(flat).toContain("Saadha raasta");
    expect(flat).toContain("-50000"); // TDS credit ghatane wali cheez hai
    expect(flat).toContain("Net payable");
    expect(flat).toContain("15 September");
  });

  it("har GAP file me hai — CA ke liye, screen ke liye nahi", () => {
    const gapRows = rows.filter((r) => r[0] === "GAP");
    expect(gapRows.length).toBe(pack.gaps.length);
    expect(gapRows.length).toBeGreaterThan(0);
  });

  it("headers 5 column ke hain aur har row unse milti hai", () => {
    expect(ITR_CSV_HEADERS.length).toBe(5);
    for (const r of rows) expect(r.length).toBe(5);
  });

  it("ghate wali file me carry-forward ki chetavni hoti hai", () => {
    const lossPack = computeItrPack(financialYear(2026), {
      ...SOURCES, revenueExGst: 100_000, tdsCredit: 0, tdsCount: 0,
    });
    const lossFlat = itrCsvRows(lossPack).map((r) => r.join("|")).join("\n");
    expect(lossFlat).toContain("GHATA");
    expect(lossFlat).toContain("Section 208");
  });
});
