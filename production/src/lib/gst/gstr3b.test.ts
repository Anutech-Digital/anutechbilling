import { describe, it, expect } from "vitest";
import { computeGstr3b, expenseHeadsByState, gstr3bRows, setOffItc } from "./gstr3b";

const H = (igst = 0, cgst = 0, sgst = 0) => ({ igst, cgst, sgst });

describe("GSTR-3B worksheet", () => {
  const g = computeGstr3b({
    output: [{ taxableValue: 500_000, heads: H(0, 45_000, 45_000) }, { taxableValue: 100_000, heads: H(18_000) }],
    itc: [H(0, 900, 900), H(2_700)],
    blocked17: [H(0, 90, 90)],
    notIn2b: 180,
    rcm: [{ amount: 50_000, tax: 9_000 }],
  });

  it("3.1(a) and 3.1(d)", () => {
    expect(g.outTaxable).toBe(600_000);
    expect(g.out).toEqual(H(18_000, 45_000, 45_000));
    expect(g.rcmTaxable).toBe(50_000);
    expect(g.rcmTax).toBe(9_000);
  });

  it("4(A)(5) is gross of the 17(5) part, 4(B)(1) reverses it, 4(C) nets and adds the RCM credit", () => {
    expect(g.itcAll).toEqual(H(2_700, 990, 990));
    expect(g.rev17).toEqual(H(0, 90, 90));
    expect(g.itcNet).toEqual(H(2_700 + 9_000, 900, 900));
    expect(g.itcRcm).toBe(9_000);
  });

  it("cash: RCM tax always, plus uncovered output per head", () => {
    expect(g.pay.igst).toBe(9_000 + Math.max(0, 18_000 - 11_700));
    expect(g.pay.cgst).toBe(45_000 - 900);
    expect(g.pay.sgst).toBe(45_000 - 900);
  });

  it("kaccha / no-GSTIN GST is reported outside the boxes", () => {
    expect(g.notIn2b).toBe(180);
    const rows = gstr3bRows(g);
    expect(rows.map((r) => r[0])).toEqual(["3.1(a)", "3.1(d)", "4(A)(3)", "4(A)(5)", "4(B)(1)", "4(C)", "6.1", "6.1", "6.1", "Net", "—"]);
  });

  it("no RCM, no blocked → only the classic four rows", () => {
    const g2 = computeGstr3b({ output: [], itc: [], blocked17: [], notIn2b: 0, rcm: [] });
    expect(gstr3bRows(g2).map((r) => r[0])).toEqual(["3.1(a)", "4(A)(5)", "4(C)", "Net"]);
    expect(g2.pay).toEqual(H());
  });
});

describe("WC-gst: 3.1(b) zero-rated and 3.2 unregistered inter-state", () => {
  const g = computeGstr3b({
    output: [
      { taxableValue: 500_000, heads: H(0, 45_000, 45_000) },
      { taxableValue: 100_000, heads: H(18_000), unregInterPos: "27-Maharashtra" },
      { taxableValue: 50_000, heads: H(9_000), unregInterPos: "27-Maharashtra" },
      { taxableValue: -10_000, heads: H(-1_800), unregInterPos: "27-Maharashtra" },   // credit note
      { taxableValue: 20_000, heads: H(3_600), unregInterPos: "09-Uttar Pradesh" },
      { taxableValue: 200_000, heads: H(), zeroRated: true },                           // export under LUT
      { taxableValue: 100_000, heads: H(18_000), zeroRated: true },                     // export with IGST
    ],
    itc: [], blocked17: [], notIn2b: 0, rcm: [],
  });

  it("exports leave 3.1(a) and go to 3.1(b)", () => {
    expect(g.outTaxable).toBe(500_000 + 100_000 + 50_000 - 10_000 + 20_000);
    expect(g.out.igst).toBe(18_000 + 9_000 - 1_800 + 3_600);
    expect(g.zeroTaxable).toBe(300_000);
    expect(g.zeroIgst).toBe(18_000);
  });

  it("IGST on exports with payment is still payable", () => {
    expect(g.pay.igst).toBe(18_000 + 9_000 - 1_800 + 3_600 + 18_000);
  });

  it("3.2 is per place of supply, netted, sorted", () => {
    expect(g.unregInter).toEqual([
      { pos: "09-Uttar Pradesh", taxable: 20_000, igst: 3_600 },
      { pos: "27-Maharashtra", taxable: 140_000, igst: 25_200 },
    ]);
    expect(gstr3bRows(g).map((r) => r[0])).toEqual(["3.1(a)", "3.1(b)", "3.2", "3.2", "4(A)(5)", "4(C)", "Net"]);
  });

  it("advances net into 3.1(a): 11A adds, 11B takes back", () => {
    const a = computeGstr3b({
      output: [{ taxableValue: 10_000, heads: H(0, 900, 900) }, { taxableValue: -5_000, heads: H(0, -450, -450) }],
      itc: [], blocked17: [], notIn2b: 0, rcm: [],
    });
    expect(a.outTaxable).toBe(5_000);
    expect(a.out).toEqual(H(0, 450, 450));
  });
});

describe("R-258: ITC set-off — s.49(5) / s.49A / Rule 88A", () => {
  const sum = (h: { igst: number; cgst: number; sgst: number }) => h.igst + h.cgst + h.sgst;

  it("card example: ₹10k IGST credit, ₹6k CGST + ₹6k SGST output → ₹2k cash, not ₹12k", () => {
    const s = setOffItc(H(0, 6_000, 6_000), H(10_000));
    expect(sum(s.cash)).toBe(2_000);
    expect(s.used.igst).toEqual(H(0, 6_000, 4_000));
    expect(s.cash).toEqual(H(0, 0, 2_000));
    expect(s.carryForward).toEqual(H());
    /* and through the worksheet: */
    const g = computeGstr3b({ output: [{ taxableValue: 66_667, heads: H(0, 6_000, 6_000) }], itc: [H(10_000)], blocked17: [], notIn2b: 0, rcm: [] });
    expect(sum(g.pay)).toBe(2_000);
  });

  it("IGST credit goes to IGST liability FIRST, the remainder to CGST/SGST", () => {
    const s = setOffItc(H(5_000, 4_000, 4_000), H(8_000));
    expect(s.used.igst).toEqual(H(5_000, 3_000, 0));
    expect(s.cash).toEqual(H(0, 1_000, 4_000));
    expect(sum(s.cash)).toBe(13_000 - 8_000);
  });

  it("Rule 88A remainder goes to the head its own credit cannot cover — no cash while credit is carried forward", () => {
    /* CGST credit covers CGST fully; SGST has no credit. The IGST remainder must go to SGST. */
    const s = setOffItc(H(0, 5_000, 5_000), H(5_000, 5_000, 0));
    expect(s.used.igst).toEqual(H(0, 0, 5_000));
    expect(s.used.cgst).toEqual(H(0, 5_000, 0));
    expect(s.cash).toEqual(H());
    expect(s.carryForward).toEqual(H());
  });

  it("s.49A: IGST credit is exhausted before CGST/SGST credit is used; the CGST/SGST credit is carried forward", () => {
    const s = setOffItc(H(0, 3_000, 3_000), H(10_000, 2_000, 2_000));
    expect(s.used.igst).toEqual(H(0, 3_000, 3_000));
    expect(s.used.cgst).toEqual(H());
    expect(s.used.sgst).toEqual(H());
    expect(s.cash).toEqual(H());
    expect(s.carryForward).toEqual(H(4_000, 2_000, 2_000));
  });

  it("CGST credit pays CGST then IGST; SGST credit pays SGST then IGST", () => {
    const s = setOffItc(H(10_000, 1_000, 1_000), H(0, 4_000, 3_000));
    expect(s.used.cgst).toEqual(H(3_000, 1_000, 0));
    expect(s.used.sgst).toEqual(H(2_000, 0, 1_000));
    expect(s.cash).toEqual(H(5_000, 0, 0));
    expect(s.paidByCredit).toEqual(H(5_000, 1_000, 1_000));
  });

  it("CGST credit NEVER pays SGST, SGST credit NEVER pays CGST", () => {
    const a = setOffItc(H(0, 0, 5_000), H(0, 5_000, 0));
    expect(a.cash).toEqual(H(0, 0, 5_000));
    expect(a.carryForward).toEqual(H(0, 5_000, 0));
    expect(a.used.cgst.sgst).toBe(0);
    const b = setOffItc(H(0, 5_000, 0), H(0, 0, 5_000));
    expect(b.cash).toEqual(H(0, 5_000, 0));
    expect(b.carryForward).toEqual(H(0, 0, 5_000));
    expect(b.used.sgst.cgst).toBe(0);
  });

  it("excess credit is carried forward per head; cash never negative", () => {
    const s = setOffItc(H(1_000, 1_000, 1_000), H(5_000, 3_000, 2_000));
    expect(s.cash).toEqual(H());
    /* IGST 5k: 1k IGST, 1k CGST, 1k SGST → 2k left; CGST/SGST credit untouched. */
    expect(s.carryForward).toEqual(H(2_000, 3_000, 2_000));
    expect(sum(s.carryForward)).toBe(10_000 - 3_000);
  });

  it("whole rupees; negative / non-finite inputs count as 0", () => {
    const s = setOffItc(H(100.4, -50, Number.NaN), H(40.6, 0, -10));
    expect(s.liability).toEqual(H(100, 0, 0));
    expect(s.credit).toEqual(H(41, 0, 0));
    expect(s.cash).toEqual(H(59, 0, 0));
  });

  it("invariant: liability = credit used + cash, credit = used + carried, for every head", () => {
    const cases: [ReturnType<typeof H>, ReturnType<typeof H>][] = [
      [H(7, 13, 2), H(3, 1, 20)], [H(0, 9, 9), H(4, 0, 0)], [H(50, 0, 0), H(0, 10, 10)], [H(1, 2, 3), H(9, 9, 9)],
    ];
    for (const [l, c] of cases) {
      const s = setOffItc(l, c);
      for (const k of ["igst", "cgst", "sgst"] as const) {
        expect(s.paidByCredit[k] + s.cash[k]).toBe(s.liability[k]);
        expect(sum(s.used[k]) + s.carryForward[k]).toBe(s.credit[k]);
        expect(s.cash[k]).toBeGreaterThanOrEqual(0);
      }
      expect(s.used.cgst.sgst).toBe(0);
      expect(s.used.sgst.cgst).toBe(0);
    }
  });

  it("RCM tax stays cash even when ITC is spare; worksheet shows 6.1 and C/F rows", () => {
    const g = computeGstr3b({ output: [], itc: [H(0, 500, 500)], blocked17: [], notIn2b: 0, rcm: [{ amount: 10_000, tax: 1_800 }] });
    expect(g.pay).toEqual(H(1_800));
    expect(g.setOff.carryForward).toEqual(H(1_800, 500, 500));
    expect(gstr3bRows(g).map((r) => r[0])).toEqual(["3.1(a)", "3.1(d)", "4(A)(3)", "4(A)(5)", "4(C)", "Net", "C/F"]);
  });
});

describe("R-258: guessed expense heads follow the vendor's GSTIN state", () => {
  const guessed = { igst: 0, cgst: 90, sgst: 90, measured: false };
  it("other-state vendor → IGST", () => expect(expenseHeadsByState(guessed, "09", "07")).toEqual(H(180)));
  it("same state or unknown state → keeps CGST+SGST", () => {
    expect(expenseHeadsByState(guessed, "07", "07")).toEqual(H(0, 90, 90));
    expect(expenseHeadsByState(guessed, null, "07")).toEqual(H(0, 90, 90));
    expect(expenseHeadsByState(guessed, "09", null)).toEqual(H(0, 90, 90));
  });
  it("a split read from the bill is never changed", () => {
    expect(expenseHeadsByState({ igst: 0, cgst: 90, sgst: 90, measured: true }, "09", "07")).toEqual(H(0, 90, 90));
  });
});
