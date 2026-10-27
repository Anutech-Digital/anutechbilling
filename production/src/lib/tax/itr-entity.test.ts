/**
 * R-1844 — the ITR pack by business type. Every figure worked by hand:
 *   Proprietor: slabs on the owner's PAN, new regime (default) and old regime, 87A rebate.
 *   Firm / LLP: 30% + 12% surcharge above ₹1 crore + 4% cess.
 *   Pvt Ltd / empty type: exactly today's pack (25% / 115BAA 22%, ITR-6, 31 Oct).
 */
import { describe, it, expect } from "vitest";
import { computeItrPack, financialYear, type ItrSources } from "./itr";
import { slabTax, slabRegimeTax, firmTax, individualRates } from "./entity-tax";

const fy = financialYear(2025);   // FY 2025-26 = AY 2026-27, rates read on the e-filing portal
const SRC = (profit: number): ItrSources => ({
  revenueExGst: profit, invoiceCount: 3, creditNoteCount: 0, debitNoteCount: 0,
  cogs: 0, cogsCount: 1, placedPoCost: 0, placedPoCount: 0,
  commissions: 0, commissionsCount: 0,
  expenses: [{ category: "Salaries", amount: 0, itc: 0, count: 1 }],
  tdsCredit: 0, tdsCount: 0, advanceTaxPaid: 0, assetCount: 1,
});

describe("slab maths (AY 2026-27)", () => {
  const r = individualRates(2025);
  it("new regime ₹15,00,000: 20,000 + 40,000 + 45,000 = ₹1,05,000, no rebate, + 4% cess = ₹1,09,200", () => {
    expect(slabTax(1_500_000, r.newRegime.slabs)).toBe(105_000);
    expect(slabRegimeTax(1_500_000, r.newRegime)).toEqual({ baseTax: 105_000, rebate: 0, surcharge: 0, cess: 4_200, total: 109_200 });
  });
  it("new regime ₹12,00,000: ₹60,000 tax, 87A rebate ₹60,000 → ₹0", () => {
    expect(slabRegimeTax(1_200_000, r.newRegime)).toEqual({ baseTax: 60_000, rebate: 60_000, surcharge: 0, cess: 0, total: 0 });
  });
  it("old regime ₹15,00,000: 12,500 + 1,00,000 + 1,50,000 = ₹2,62,500 + cess ₹10,500", () => {
    expect(slabRegimeTax(1_500_000, r.oldRegime).total).toBe(273_000);
  });
  it("new regime ₹60,00,000 carries 10% surcharge on tax", () => {
    // 3,00,000 + 30% of 36,00,000 = 13,80,000; surcharge 1,38,000; cess 4% of 15,18,000 = 60,720
    expect(slabRegimeTax(6_000_000, r.newRegime)).toEqual({ baseTax: 1_380_000, rebate: 0, surcharge: 138_000, cess: 60_720, total: 1_578_720 });
  });
  it("AY 2026-27 rates are the official ones; FY 2026-27 and FY 2024-25 are marked secondary", () => {
    expect(r.confirmed).toBe("official");
    expect(individualRates(2026).confirmed).toBe("secondary");
    expect(individualRates(2024).confirmed).toBe("secondary");
    expect(individualRates(2030)).toMatchObject({ exactYear: false, confirmed: "secondary" });
  });
});

describe("firm / LLP maths", () => {
  it("₹10,00,000 → 30% = ₹3,00,000 + cess ₹12,000", () => {
    expect(firmTax(1_000_000)).toEqual({ baseTax: 300_000, rebate: 0, surcharge: 0, cess: 12_000, total: 312_000 });
  });
  it("₹2 crore → 12% surcharge: 60,00,000 + 7,20,000 + cess 2,68,800", () => {
    expect(firmTax(20_000_000).total).toBe(6_988_800);
  });
});

describe("computeItrPack by business type", () => {
  it("proprietor: ITR-3 on the owner's PAN, both slab regimes, the lower one drives advance tax, 31 Jul", () => {
    const p = computeItrPack(fy, SRC(1_500_000), "proprietor");
    expect(p.itrForm).toBe("ITR-3");
    expect(p.itrText).toBe("ITR-3 on the owner's PAN");
    expect(p.estimates.map((e) => [e.regime, e.total])).toEqual([["new_slab", 109_200], ["old_slab", 273_000]]);
    expect(p.cheaperEstimate?.regime).toBe("new_slab");
    expect(p.netPayableAfterTds).toBe(109_200);
    expect(p.due.date).toBe("2026-07-31");
    expect(p.obligationKey).toBe("it_itr_business");
    expect(p.ratesNote).toMatch(/CA \/ Hitesh to confirm/);
    expect(p.gaps.some((g) => /TOTAL income/.test(g))).toBe(true);
  });

  it("partnership: ITR-5, 30% + cess, 40(b) gap", () => {
    const p = computeItrPack(fy, SRC(1_000_000), "partnership");
    expect(p.itrForm).toBe("ITR-5");
    expect(p.estimates).toHaveLength(1);
    expect(p.estimates[0]).toMatchObject({ regime: "firm", regimeLabel: "Firm rate (30%)", rateText: "30%", total: 312_000 });
    expect(p.gaps.some((g) => /40\(b\)/.test(g))).toBe(true);
    expect(p.ratesNote).toMatch(/ESTIMATE — CA \/ Hitesh to confirm/);
  });

  it("LLP: ITR-5 for the LLP, same 30%", () => {
    const p = computeItrPack(fy, SRC(1_000_000), "llp");
    expect(p.itrText).toBe("ITR-5 for the LLP");
    expect(p.estimates[0]).toMatchObject({ regimeLabel: "LLP rate (30%)", total: 312_000 });
  });

  it("Pvt Ltd and empty type: today's pack (25% / 115BAA), ITR-6, 31 Oct, it_itr6", () => {
    const before = computeItrPack(fy, SRC(1_000_000));
    for (const t of ["pvt_ltd", null] as const) {
      const p = computeItrPack(fy, SRC(1_000_000), t);
      expect(p).toEqual(before);
      expect(p.itrForm).toBe("ITR-6");
      expect(p.obligationKey).toBe("it_itr6");
      expect(p.due.date).toBe(fy.itrDue);
    }
    expect(before.estimates.map((e) => [e.regime, e.ratePct, e.total])).toEqual([["normal", 25, 260_000], ["s115BAA", 22, 251_680]]);
  });

  it("a loss: no estimate for any type", () => {
    for (const t of ["proprietor", "partnership", "pvt_ltd"] as const) expect(computeItrPack(fy, SRC(-5), t).estimates).toEqual([]);
  });
});
