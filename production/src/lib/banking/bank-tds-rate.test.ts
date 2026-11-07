/* R-2558 — the TDS rate + section a bank receipt books (Reconcile → New sale / open item).
   The owner's case (R-2538 card test, 7 Nov): 50 × ₹3,150 M365 Basic, annual, billed half-yearly
   → part 1 taxable ₹78,750, whole year ₹1,57,500. */
import { describe, expect, it } from "vitest";
import { bankTdsDefault, bankTdsGrossPreview, bankTdsProblem, parseTdsRate, shortChoiceDefault } from "./bank-tds-rate";

const PART = 78750;
const WHOLE = 157500;

describe("R-2558 bankTdsDefault", () => {
  it("₹3,150 on the half-yearly part = 2% of the whole year — rate 2, never TDS ÷ part (4%)", () => {
    const d = bankTdsDefault({ shortBy: 3150, partTaxable: PART, wholeTaxable: WHOLE });
    expect(d.ratePct).toBe(2);
    expect(d.ratePct).not.toBe(4);
    expect(d.likely).toBe(true);
    expect(d.section).toBe("194C");
    expect(d.reason).toMatch(/2% of the whole sale's taxable ₹1,57,500/);
  });

  it("₹1,575 = 2% of the part → rate 2 on the part", () => {
    const d = bankTdsDefault({ shortBy: 1575, partTaxable: PART, wholeTaxable: WHOLE });
    expect(d).toMatchObject({ ratePct: 2, likely: true, section: "194C" });
    expect(d.reason).toMatch(/2% of the taxable value ₹78,750/);
  });

  it("the customer's saved rate wins when it also fits (₹1,575 = 1% of the whole year) — its section too", () => {
    const d = bankTdsDefault({ shortBy: 1575, partTaxable: PART, wholeTaxable: WHOLE, customer: { tds_default_section: "194c", tds_default_rate_pct: "1" } });
    expect(d).toMatchObject({ ratePct: 1, section: "194C", likely: true });
  });

  it("a gap that fits no rate: no rate, no section, nothing pre-chosen (no 194J guess)", () => {
    const d = bankTdsDefault({ shortBy: 3000, partTaxable: PART, wholeTaxable: WHOLE });
    expect(d).toMatchObject({ ratePct: null, section: null, likely: false });
    expect(d.reason).toMatch(/enter the rate and section/);
  });

  it("no fit but the customer has a saved TDS → that rate + section, not pre-chosen as TDS", () => {
    const d = bankTdsDefault({ shortBy: 3000, partTaxable: PART, wholeTaxable: WHOLE, customer: { tds_default_section: "194JB", tds_default_rate_pct: 10 } });
    expect(d).toMatchObject({ ratePct: 10, section: "194JB", likely: false });
  });

  it("5% fits but its section is unknown → rate 5, section left to the operator", () => {
    const d = bankTdsDefault({ shortBy: 500, partTaxable: 10000, wholeTaxable: null });
    expect(d).toMatchObject({ ratePct: 5, section: null, likely: true });
  });

  it("not billed in parts (whole = part): only the part is tried", () => {
    expect(bankTdsDefault({ shortBy: 200, partTaxable: 10000, wholeTaxable: 10000 })).toMatchObject({ ratePct: 2, likely: true });
    expect(bankTdsDefault({ shortBy: 400, partTaxable: 10000, wholeTaxable: 10000 })).toMatchObject({ ratePct: null, likely: false });
  });

  it("the due amount's own rate (no taxable known) is used", () => {
    expect(bankTdsDefault({ shortBy: 200, partTaxable: null, partRatePct: 2 })).toMatchObject({ ratePct: 2, likely: true });
  });
});

describe("R-2558 rate box", () => {
  it("parses a typed % and refuses empty / 0 / over 100", () => {
    expect(parseTdsRate("2")).toBe(2);
    expect(parseTdsRate(" 0.1 ")).toBe(0.1);
    expect(parseTdsRate("")).toBeNull();
    expect(parseTdsRate("0")).toBeNull();
    expect(parseTdsRate("101")).toBeNull();
    expect(parseTdsRate("abc")).toBeNull();
  });
  it("says what is missing", () => {
    expect(bankTdsProblem("", "194C")).toMatch(/Enter the TDS rate/);
    expect(bankTdsProblem("200", "194C")).toMatch(/between 0 and 100/);
    expect(bankTdsProblem("2", null)).toMatch(/Choose the TDS section/);
    expect(bankTdsProblem("2", "194C")).toBeNull();
  });
});

describe("R-2558 gross preview = the server's R-2538 rule", () => {
  it("rate fits the part → the part's taxable; else TDS × 100 ÷ rate, capped at the whole", () => {
    expect(bankTdsGrossPreview(1575, 2, PART, WHOLE)).toBe(78750);
    expect(bankTdsGrossPreview(3150, 2, PART, WHOLE)).toBe(157500);
    expect(bankTdsGrossPreview(3150, 1, PART, WHOLE)).toBe(157500);
    expect(bankTdsGrossPreview(3150, null, PART, WHOLE)).toBeNull();
  });
});

describe("R-2558 shortChoiceDefault — nothing pre-chosen the amounts don't prove", () => {
  it("TDS-like → tds; more than any TDS (20%) → part; else none", () => {
    expect(shortChoiceDefault(3150, 92925, true)).toBe("tds");
    expect(shortChoiceDefault(6800, 11800, false)).toBe("part");
    expect(shortChoiceDefault(3000, 92925, false)).toBeNull();
    expect(shortChoiceDefault(230, 13206, false)).toBeNull();
  });
});
