import { describe, it, expect } from "vitest";
import { tdsDecision, deducteeTypeFromPan, panFromGstin, statutoryDues, TDS_THRESHOLDS } from "./tds-deductor";

const CO = "AABCU9603R";   // 4th letter C → company
const IND = "ABCPE1234F";  // P → individual

describe("PAN helpers", () => {
  it("reads the deductee type from the PAN's 4th letter", () => {
    expect(deducteeTypeFromPan(CO)).toBe("company");
    expect(deducteeTypeFromPan(IND)).toBe("individual");
    expect(deducteeTypeFromPan("ABCHE1234F")).toBe("huf");
    expect(deducteeTypeFromPan("ABCFE1234F")).toBe("firm");
    expect(deducteeTypeFromPan("abcpe1234f")).toBe("individual");
    expect(deducteeTypeFromPan("nope")).toBeNull();
  });
  it("lifts the PAN out of a well-formed GSTIN only", () => {
    expect(panFromGstin("07AABCU9603R1ZM")).toBe("AABCU9603R");
    expect(panFromGstin("07AABCU9603R1Z")).toBeNull();
    expect(panFromGstin("")).toBeNull();
  });
});

describe("tdsDecision", () => {
  it("194C: below both limits → no TDS, with the headroom", () => {
    const d = tdsDecision({ section: "194C", base: 25000, fyBaseSoFar: 40000, fyBaseWithoutTds: 40000, pan: CO });
    expect(d.applies).toBe(false);
    expect(d.tds).toBe(0);
    expect(d.headroom).toBe(35000);
    expect(d.reason).toMatch(/TDS not required/);
  });

  it("194C: a single payment over ₹30,000 bites even when the year is under ₹1L", () => {
    const d = tdsDecision({ section: "194C", base: 31000, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: CO });
    expect(d.applies).toBe(true);
    expect(d.ratePct).toBe(2);
    expect(d.tds).toBe(620);
    expect(d.catchUpBase).toBe(0);
    expect(d.reason).toMatch(/single payment/);
  });

  it("194C: individual / HUF contractor is 1%", () => {
    expect(tdsDecision({ section: "194C", base: 50000, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: IND }).ratePct).toBe(1);
    expect(tdsDecision({ section: "194C", base: 50000, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: "ABCHE1234F" }).ratePct).toBe(1);
  });

  it("crossing the year's limit catches the earlier untaxed payments too", () => {
    const d = tdsDecision({ section: "194J", base: 20000, fyBaseSoFar: 40000, fyBaseWithoutTds: 40000, pan: CO });
    expect(d.applies).toBe(true);
    expect(d.ratePct).toBe(10);
    expect(d.tds).toBe(2000);
    expect(d.catchUpBase).toBe(40000);
    expect(d.catchUpTds).toBe(4000);
    expect(d.reason).toMatch(/earlier ₹40,000/);
  });

  it("no PAN → s.206AA 20% (higher of the two), 194Q 5%", () => {
    const d = tdsDecision({ section: "194C", base: 50000, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: null });
    expect(d.noPan).toBe(true);
    expect(d.ratePct).toBe(20);
    expect(d.tds).toBe(10000);
    expect(d.reason).toMatch(/206AA/);
    expect(tdsDecision({ section: "194Q", base: 1_000_000, fyBaseSoFar: 5_000_000, fyBaseWithoutTds: 0, pan: null }).ratePct).toBe(5);
  });

  it("194Q taxes only the part above ₹50L, never catches up", () => {
    const d = tdsDecision({ section: "194Q", base: 1_000_000, fyBaseSoFar: 4_500_000, fyBaseWithoutTds: 4_500_000, pan: CO });
    expect(d.applies).toBe(true);
    expect(d.tds).toBe(500);            // 0.1% of the ₹5L above the limit
    expect(d.catchUpBase).toBe(0);
    expect(tdsDecision({ section: "194Q", base: 100, fyBaseSoFar: 1000, fyBaseWithoutTds: 0, pan: CO }).applies).toBe(false);
  });

  it("thresholds for FY 2026-27", () => {
    expect(TDS_THRESHOLDS["194I"].aggregate).toBe(600_000);
    expect(TDS_THRESHOLDS["194H"].aggregate).toBe(20_000);
    expect(TDS_THRESHOLDS["194A"].aggregate).toBe(10_000);
    expect(tdsDecision({ section: "194I", base: 50000, fyBaseSoFar: 540000, fyBaseWithoutTds: 540000, pan: CO }).applies).toBe(false);
    expect(tdsDecision({ section: "194I", base: 70000, fyBaseSoFar: 540000, fyBaseWithoutTds: 540000, pan: CO }).applies).toBe(true);
  });

  it("an unknown section refuses to guess", () => {
    const d = tdsDecision({ section: "194X", base: 1, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: CO });
    expect(d.applies).toBe(false);
    expect(d.reason).toMatch(/CA/);
  });
});

describe("statutoryDues", () => {
  const salaries = [
    { tds: 2000, pf: 1800, esi: 75, pf_employer: 1800, esi_employer: 325 },
    { tds: 0, pf: 1800, esi: 0, pf_employer: 1800, esi_employer: 0 },
  ];
  it("counts employer shares and vendor TDS as dues, splits paid by kind", () => {
    const s = statutoryDues({ salaries, vendorTds: 5000, paid: [{ kind: "tds", amount: 3000 }, { kind: "pf", amount: 7200 }] });
    expect(s).toMatchObject({ tdsSalary: 2000, tdsVendor: 5000, pf: 7200, esi: 400, withheld: 14600, paid: 10200, payable: 4400 });
    expect(s.payableByKind).toEqual({ tds: 4000, pf: 0, esi: 400 });
  });
  it("a mixed challan can't be attributed — total only", () => {
    const s = statutoryDues({ salaries, vendorTds: 0, paid: [{ kind: "mixed", amount: 9000 }] });
    expect(s.payable).toBe(600);
    expect(s.payableByKind).toBeNull();
  });
  it("never goes negative when more was paid than withheld", () => {
    expect(statutoryDues({ salaries: [], vendorTds: 0, paid: [{ kind: "tds", amount: 10 }] }).payable).toBe(0);
  });
});
