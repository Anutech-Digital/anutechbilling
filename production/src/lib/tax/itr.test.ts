/**
 * ITR computation ke test — har aankda haath se ginkar pin kiya hua hai.
 *
 * Tax ki darein code me likhi hain, isliye unka har kadam (base, surcharge,
 * cess) yahan alag-alag naapa jata hai — sirf total nahi, warna galat base
 * aur galat cess ek doosre ko dhak sakte hain.
 */
import { describe, it, expect } from "vitest";
import {
  financialYear, currentFinancialYear, roundTaxable, computeItrPack,
  type ItrSources,
} from "./itr";

const EMPTY: ItrSources = {
  revenueExGst: 0, invoiceCount: 0, creditNoteCount: 0, debitNoteCount: 0,
  cogs: 0, cogsCount: 0, placedPoCost: 0, placedPoCount: 0,
  commissions: 0, commissionsCount: 0,
  expenses: [],
  tdsCredit: 0, tdsCount: 0,
  advanceTaxPaid: 0,
};

describe("financialYear", () => {
  it("FY 2026-27 ki har pehchaan sahi banati hai", () => {
    const fy = financialYear(2026);
    expect(fy.label).toBe("FY 2026-27");
    expect(fy.assessmentYear).toBe("AY 2027-28");
    expect(fy.start).toBe("2026-04-01");
    expect(fy.end).toBe("2027-03-31");
    expect(fy.fiscalKey).toBe("FY2627");
    expect(fy.itrDue).toBe("2027-10-31");
  });

  it("fiscalKey tds_receivable ke live format se milta hai", () => {
    // Live DB me naapa (1 Sep 2026): fiscal_year = "FY2627".
    expect(financialYear(2026).fiscalKey).toBe("FY2627");
    expect(financialYear(2029).fiscalKey).toBe("FY2930");
  });
});

describe("currentFinancialYear — IST ki dehleez", () => {
  it("31 March IST raat ke pehle purana FY", () => {
    // 31 Mar 2026 ko IST me 23:00 = UTC 17:30.
    expect(currentFinancialYear(new Date("2026-03-31T17:30:00Z")).startYear).toBe(2025);
  });
  it("1 April IST hote hi naya FY — jabki UTC me abhi 31 March hai", () => {
    // UTC 31 Mar 20:00 = IST 1 Apr 01:30. UTC-ghadi se ginne wala yahan girta hai.
    expect(currentFinancialYear(new Date("2026-03-31T20:00:00Z")).startYear).toBe(2026);
  });
  it("aaj (Sep 2026) FY 2026-27 hai", () => {
    expect(currentFinancialYear(new Date("2026-09-01T10:00:00Z")).label).toBe("FY 2026-27");
  });
});

describe("roundTaxable — Section 288A", () => {
  it("das ke nikattam ank par", () => {
    expect(roundTaxable(1_234_567)).toBe(1_234_570);
    expect(roundTaxable(1_234_564)).toBe(1_234_560);
    expect(roundTaxable(1_234_565)).toBe(1_234_570);
  });
});

describe("computeItrPack — tax ke aankde, haath se gine hue", () => {
  const fy = financialYear(2026);

  it("₹10,00,000 munafe par dono regime ka har kadam", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 1_500_000, invoiceCount: 10,
      cogs: 500_000, cogsCount: 5,
    });
    expect(pack.bookProfit).toBe(1_000_000);
    expect(pack.taxableIncome).toBe(1_000_000);

    const normal = pack.estimates.find((e) => e.regime === "normal")!;
    // 25% = 2,50,000 · surcharge 0 (≤ ₹1cr) · cess 4% = 10,000
    expect(normal.baseTax).toBe(250_000);
    expect(normal.surcharge).toBe(0);
    expect(normal.cess).toBe(10_000);
    expect(normal.total).toBe(260_000);

    const baa = pack.estimates.find((e) => e.regime === "s115BAA")!;
    // 22% = 2,20,000 · surcharge 10% = 22,000 · cess 4% of 2,42,000 = 9,680
    expect(baa.baseTax).toBe(220_000);
    expect(baa.surcharge).toBe(22_000);
    expect(baa.cess).toBe(9_680);
    expect(baa.total).toBe(251_680);

    // Kam wala 115BAA hai — advance tax usi par banta hai.
    expect(pack.cheaperEstimate!.regime).toBe("s115BAA");
  });

  it("₹1cr ke upar saadhe raaste par 7% surcharge lagta hai", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY, revenueExGst: 12_000_000, invoiceCount: 1,
    });
    const normal = pack.estimates.find((e) => e.regime === "normal")!;
    // 25% of 1,20,00,000 = 30,00,000 · surcharge 7% = 2,10,000 · cess 4% of 32,10,000 = 1,28,400
    expect(normal.baseTax).toBe(3_000_000);
    expect(normal.surcharge).toBe(210_000);
    expect(normal.total).toBe(3_000_000 + 210_000 + 128_400);
  });

  it("ghate me tax shunya, estimates khaali, advance tax nahi", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 100_000, invoiceCount: 1,
      cogs: 300_000, cogsCount: 3,
    });
    expect(pack.bookProfit).toBe(-200_000);
    expect(pack.taxableIncome).toBe(0);
    expect(pack.estimates).toEqual([]);
    expect(pack.advanceTaxRequired).toBe(false);
    expect(pack.advanceTaxSchedule).toEqual([]);
  });

  it("TDS credit tax me se katta hai, aur advance tax bache par banta hai", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 1_000_000, invoiceCount: 4,
      tdsCredit: 100_000, tdsCount: 4,
    });
    // 115BAA: 10,00,000 → 2,51,680 · TDS 1,00,000 → net 1,51,680
    expect(pack.netPayableAfterTds).toBe(151_680);
    expect(pack.advanceTaxRequired).toBe(true);
    // Kishtein cumulative: 15% / 45% / 75% / 100%
    expect(pack.advanceTaxSchedule.map((i) => i.cumulativeDue)).toEqual([
      Math.round(151_680 * 0.15),
      Math.round(151_680 * 0.45),
      Math.round(151_680 * 0.75),
      151_680,
    ]);
    // Aakhri kisht agle calendar saal ke March me hai.
    expect(pack.advanceTaxSchedule[3].dueDate).toBe("2027-03-15");
    expect(pack.advanceTaxSchedule[0].dueDate).toBe("2026-06-15");
  });

  it("Section 208: ₹10,000 se kam bache par advance tax zaroori nahi", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 39_000, invoiceCount: 1, // 115BAA ≈ ₹9,812
    });
    expect(pack.netPayableAfterTds).toBeLessThan(10_000);
    expect(pack.advanceTaxRequired).toBe(false);
  });
});

describe("computeItrPack — expenses category-wise, GST ghata kar", () => {
  const fy = financialYear(2026);

  it("kharcha amount − gst hota hai (GST input credit hai, kharcha nahi)", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 500_000, invoiceCount: 2,
      expenses: [
        { category: "Hosting", amount: 118_000, itc: 18_000, count: 3 },
        { category: "Salaries", amount: 200_000, itc: 0, count: 2 },
      ],
    });
    const hosting = pack.pnl.find((l) => l.label === "Hosting")!;
    expect(hosting.amount).toBe(100_000);
    expect(pack.totalExpense).toBe(300_000);
    expect(pack.bookProfit).toBe(200_000);
  });

  it("khaali category chhapti nahi", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      expenses: [{ category: "Travel", amount: 0, itc: 0, count: 0 }],
    });
    expect(pack.pnl.find((l) => l.label === "Travel")).toBeUndefined();
  });
});

describe("computeItrPack — gaps (jo nahi hai wo bolna)", () => {
  const fy = financialYear(2026);

  it("ANUTECH ki aaj ki asliyat: TDS hai par invoices nahi — dono gap bolte hain", () => {
    // Live DB, 1 Sep 2026: 32 TDS entries ₹4,13,520, invoices 0.
    const pack = computeItrPack(fy, {
      ...EMPTY, tdsCredit: 413_520, tdsCount: 32,
    });
    expect(pack.gaps.some((g) => g.includes("Not a single invoice"))).toBe(true);
    expect(pack.gaps.some((g) => g.includes("32 TDS entries"))).toBe(true);
  });

  it("R-1579: COGS bill na ho to khareed ka gap (PO ho to uska note); bill ho to nahi", () => {
    const without = computeItrPack(fy, EMPTY);
    expect(without.gaps.some((g) => g.includes("no COGS vendor bill is recorded"))).toBe(true);

    const poOnly = computeItrPack(fy, { ...EMPTY, placedPoCost: 100_000, placedPoCount: 2 });
    expect(poOnly.gaps.some((g) => g.includes("2 placed purchase orders"))).toBe(true);
    expect(poOnly.pnl.find((l) => l.label.startsWith("Licence purchases"))!.amount).toBe(0);

    const withBill = computeItrPack(fy, { ...EMPTY, cogs: 100_000, cogsCount: 2, placedPoCost: 100_000, placedPoCount: 2 });
    expect(withBill.gaps.some((g) => g.includes("COGS vendor bill"))).toBe(false);
  });

  it("salary book na ho to gap; book ho to nahi", () => {
    const without = computeItrPack(fy, EMPTY);
    expect(without.gaps.some((g) => g.includes("No salary expense is booked"))).toBe(true);

    const withSalary = computeItrPack(fy, {
      ...EMPTY,
      expenses: [{ category: "Salaries", amount: 50_000, itc: 0, count: 1 }],
    });
    expect(withSalary.gaps.some((g) => g.includes("No salary expense is booked"))).toBe(false);
  });

  it("bank-byaaj ka gap HAMESHA; asset register khaali ho to uska gap", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 1_000_000, invoiceCount: 5,
      expenses: [{ category: "Salaries", amount: 100_000, itc: 0, count: 1 }],
    });
    expect(pack.gaps.some((g) => g.includes("Asset register is empty"))).toBe(true);
    expect(pack.gaps.some((g) => g.includes("Bank interest"))).toBe(true);
    expect(pack.pnl.some((l) => l.label.startsWith("Depreciation"))).toBe(false);
  });

  it("R-1578: register ka depreciation ek expense line hai aur book profit ghatata hai; gap nahi", () => {
    const pack = computeItrPack(fy, {
      ...EMPTY,
      revenueExGst: 1_000_000, invoiceCount: 5,
      expenses: [{ category: "Salaries", amount: 100_000, itc: 0, count: 1 }],
      depreciation: 24_000, assetCount: 1,
    });
    expect(pack.pnl.find((l) => l.label.startsWith("Depreciation"))).toMatchObject({ amount: 24_000, kind: "expense", count: 1 });
    expect(pack.bookProfit).toBe(1_000_000 - 100_000 - 24_000);
    expect(pack.gaps.some((g) => g.includes("Asset register") || g.includes("Depreciation app me"))).toBe(false);
  });

  it("advance tax bharna banta ho aur darj na ho to gap", () => {
    const due = computeItrPack(fy, { ...EMPTY, revenueExGst: 1_000_000, invoiceCount: 1 });
    expect(due.gaps.some((g) => g.includes("Advance tax"))).toBe(true);

    const notDue = computeItrPack(fy, EMPTY);
    expect(notDue.gaps.some((g) => g.includes("Advance tax"))).toBe(false);
  });
});
