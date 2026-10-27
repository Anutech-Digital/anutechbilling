import { describe, it, expect } from "vitest";
import {
  remunerationRule, maxRemuneration, MAX_PARTNER_INTEREST_PCT, partnerTdsRule, partnerTds,
  partnerAppropriation, capitalAtFyStart, scaleToTotal, type AppropriationPartner,
} from "./partner-appropriation";

const P = (id: string, name: string, sharePct: number, capitalBase = 0, over: Partial<AppropriationPartner> = {}): AppropriationPartner => ({
  id, name, sharePct, capitalBase, joinedOn: null, leftOn: null, pan: "ABCDE1234F", ...over,
});

describe("s.40(b)(v) / s.35(e)(iii) — maximum remuneration to working partners", () => {
  it("doneWhen: book profit ₹10,00,000 → ₹7,80,000 (5,40,000 on the first 6 lakh + 2,40,000)", () => {
    expect(maxRemuneration(1_000_000, 2025)).toBe(780_000);
  });
  it("small profit: ₹3,00,000 is the floor (90% of ₹2,00,000 = 1,80,000 is less)", () => {
    expect(maxRemuneration(200_000, 2025)).toBe(300_000);
  });
  it("a loss still allows ₹3,00,000", () => {
    expect(maxRemuneration(-100_000, 2025)).toBe(300_000);
  });
  it("exactly ₹6,00,000 → 5,40,000", () => {
    expect(maxRemuneration(600_000, 2025)).toBe(540_000);
  });
  it("FY 2023-24 and before: the older slab (first ₹3 lakh: ₹1,50,000 or 90%; balance 60%)", () => {
    expect(maxRemuneration(1_000_000, 2023)).toBe(270_000 + 420_000);
    expect(maxRemuneration(100_000, 2023)).toBe(150_000);
  });
  it("FY 2024-25 (AY 2025-26) is the first year of the new slab", () => {
    expect(maxRemuneration(1_000_000, 2024)).toBe(780_000);
  });
  it("names the law in force: 1961 Act up to FY 2025-26, Income-tax Act 2025 from 2026-27", () => {
    expect(remunerationRule(2025).section).toBe("s.40(b)(v), Income-tax Act 1961");
    expect(remunerationRule(2026).section).toBe("s.35(e)(iii), Income-tax Act 2025");
    expect(remunerationRule(2026).source).toMatch(/^https:\/\/www\.incometaxindia\.gov\.in\//);
  });
  it("interest on capital: 12% simple a year at most", () => {
    expect(MAX_PARTNER_INTEREST_PCT).toBe(12);
  });
});

describe("194T / s.393(3) Table Sl. 7 — TDS on interest + remuneration to a partner", () => {
  it("none before 1 Apr 2025", () => {
    expect(partnerTdsRule(2024)).toBeNull();
    expect(partnerTds(2024, 500_000)).toBe(0);
  });
  it("10% of the whole amount once it is above ₹20,000 in the year", () => {
    expect(partnerTds(2025, 20_000)).toBe(0);
    expect(partnerTds(2025, 20_001)).toBe(2_000);
    expect(partnerTds(2026, 493_333)).toBe(49_333);
  });
  it("section name by year", () => {
    expect(partnerTdsRule(2025)?.section).toBe("s.194T, Income-tax Act 1961");
    expect(partnerTdsRule(2026)?.section).toBe("s.393(3) Table Sl. 7, Income-tax Act 2025");
  });
});

describe("scaleToTotal — cut the deed amounts down to the limit, in proportion, whole rupees", () => {
  it("₹5L + ₹4L cut to ₹7.8L → 4,33,333 + 3,46,667", () => {
    expect(scaleToTotal(780_000, [500_000, 400_000])).toEqual([433_333, 346_667]);
  });
  it("nothing to share → zeros", () => {
    expect(scaleToTotal(780_000, [0, 0])).toEqual([0, 0]);
  });
});

describe("partnerAppropriation — interest, remuneration, then the rest by ratio", () => {
  const base = {
    fyStart: 2025, today: "2026-10-25",
    partners: [P("a", "Asha", 60, 500_000), P("b", "Bimal", 40, 0)],
    terms: {
      a: { interestPct: 12, remuneration: 500_000, working: true },
      b: { interestPct: 12, remuneration: 400_000, working: true },
    },
  };

  it("doneWhen: book profit ₹10L → remuneration ₹9L asked, ₹7.8L allowed; the rest shared 60:40", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_060_000 });
    expect(r.interestTotal).toBe(60_000);
    expect(r.bookProfit).toBe(1_000_000);
    expect(r.maxRemuneration).toBe(780_000);
    expect(r.remunerationAsked).toBe(900_000);
    expect(r.remunerationTotal).toBe(780_000);
    expect(r.remunerationOver).toBe(120_000);
    expect(r.residual).toBe(220_000);
    const [a, b] = r.lines;
    expect([a.interest, a.remuneration, a.profitShare]).toEqual([60_000, 433_333, 132_000]);
    expect([b.interest, b.remuneration, b.profitShare]).toEqual([0, 346_667, 88_000]);
    expect(a.tds).toBe(49_333);
    expect(b.tds).toBe(34_667);
    expect(a.credited + b.credited).toBe(1_060_000);
    expect(a.net).toBe(a.credited - a.tds);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/₹1,20,000/);
  });

  it("interest 15% in the deed → 12% only", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_000_000, terms: { ...base.terms, a: { ...base.terms.a, interestPct: 15 } } });
    expect(r.lines[0].interestPct).toBe(12);
    expect(r.lines[0].interestCapped).toBe(true);
    expect(r.lines[0].interest).toBe(60_000);
    expect(r.warnings.join(" ")).toMatch(/15%.*12%/);
  });

  it("deed allows less than the law → the deed figure is used", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_060_000, terms: {
      a: { interestPct: 10, remuneration: 100_000, working: true },
      b: { interestPct: 10, remuneration: 50_000, working: true },
    } });
    expect(r.lines[0].interest).toBe(50_000);
    expect(r.remunerationTotal).toBe(150_000);
    expect(r.remunerationOver).toBe(0);
  });

  it("a partner who is not a working partner gets no remuneration", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_060_000, terms: { ...base.terms, b: { interestPct: 12, remuneration: 400_000, working: false } } });
    expect(r.lines[1].remuneration).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/Bimal.*not a working partner/);
  });

  it("a partner who joined half-way gets interest for the days in the firm", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_000_000,
      partners: [P("a", "Asha", 60, 365_000, { joinedOn: "2025-10-01" }), P("b", "Bimal", 40)] });
    // 1 Oct 2025 – 31 Mar 2026 = 182 of 365 days; 12% of 3,65,000 = 43,800 a year → 21,840
    expect(r.lines[0].interestDays).toBe(182);
    expect(r.lines[0].interest).toBe(21_840);
  });

  it("FY 2024-25: the new slab applies but there is no 194T TDS yet", () => {
    const r = partnerAppropriation({ ...base, fyStart: 2024, netProfit: 1_060_000 });
    expect(r.remunerationTotal).toBe(780_000);
    expect(r.lines.every((l) => l.tds === 0)).toBe(true);
  });

  it("a loss: remuneration up to ₹3,00,000 is still allowed, the loss is shared by ratio", () => {
    const r = partnerAppropriation({ ...base, netProfit: -100_000, partners: [P("a", "Asha", 60), P("b", "Bimal", 40)] });
    expect(r.maxRemuneration).toBe(300_000);
    expect(r.remunerationTotal).toBe(300_000);
    expect(r.residual).toBe(-400_000);
    expect(r.lines.map((l) => l.profitShare)).toEqual([-240_000, -160_000]);
  });

  it("blocks posting until the year is over, while profit loads, and when shares are not 100%", () => {
    expect(partnerAppropriation({ ...base, fyStart: 2026, netProfit: 1 }).blockers.join(" ")).toMatch(/after 31 Mar 2027/);
    expect(partnerAppropriation({ ...base, netProfit: null }).blockers.join(" ")).toMatch(/profit/i);
    const r = partnerAppropriation({ ...base, netProfit: 1_000, partners: [P("a", "Asha", 60), P("b", "Bimal", 30)] });
    expect(r.blockers.join(" ")).toMatch(/90%/);
    expect(partnerAppropriation({ ...base, netProfit: 1_000, partners: [] }).blockers.join(" ")).toMatch(/partners register/);
  });

  it("only partners in the firm on 31 March share; someone who left before the year started is out", () => {
    const r = partnerAppropriation({ ...base, netProfit: 100_000,
      partners: [P("a", "Asha", 100), P("x", "Old", 50, 0, { leftOn: "2025-01-31" })] });
    expect(r.lines.map((l) => l.partnerId)).toEqual(["a"]);
  });

  it("no PAN on a partner who has TDS → warned (higher rate may apply)", () => {
    const r = partnerAppropriation({ ...base, netProfit: 1_060_000, partners: [P("a", "Asha", 60, 500_000, { pan: null }), P("b", "Bimal", 40)] });
    expect(r.warnings.join(" ")).toMatch(/Asha has no PAN/);
  });
});

describe("capitalAtFyStart — the capital interest is worked on", () => {
  it("contribution + entries before 1 April (after the CA's opening date) + earlier years posted", () => {
    const v = capitalAtFyStart({
      fyStart: 2025, contribution: 100_000, openingAsOf: "2024-03-31",
      movements: [
        { kind: "capital_introduced", amount: 50_000, movement_date: "2024-06-01" },
        { kind: "drawings", amount: 20_000, movement_date: "2025-02-01" },
        { kind: "drawings", amount: 99_000, movement_date: "2025-04-02" },   // in the year: not in the base
        { kind: "capital_introduced", amount: 7_000, movement_date: "2024-03-01" }, // inside the CA's opening
      ],
      earlierPostedNet: 30_000,
    });
    expect(v).toBe(160_000);
  });
  it("never below zero", () => {
    expect(capitalAtFyStart({ fyStart: 2025, contribution: 0, openingAsOf: null, movements: [{ kind: "drawings", amount: 5, movement_date: "2024-05-01" }], earlierPostedNet: 0 })).toBe(0);
  });
});
