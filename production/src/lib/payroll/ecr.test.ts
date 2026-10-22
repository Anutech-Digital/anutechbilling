import { describe, it, expect } from "vitest";
import { buildEcr, ecrLine } from "./ecr";

const base = { period: "2026-10", employee: "Asha Verma", uan: "100123456789", gross: 40000, lopAmount: 0, lopDays: 0, pfWage: 18000, employeePf: 2160, employerPf: 2160 };

describe("EPFO ECR line", () => {
  it("EPF wages from the payslip's PF wage, EPS/EDLI capped, employer split into EPS + diff", () => {
    const l = ecrLine({ ...base, pfWage: 30000, employeePf: 3000, employerPf: 3000 });
    expect(l).toMatchObject({ epfWages: 30000, epsWages: 25000, edliWages: 25000, ee: 3000, eps: 2083, erDiff: 917, wageAssumed: false });
  });
  it("uses the September ceiling for a September payslip", () => {
    const l = ecrLine({ ...base, period: "2026-09", pfWage: 30000, employeePf: 1800, employerPf: 1800 });
    expect(l).toMatchObject({ epsWages: 15000, eps: 1250, erDiff: 550 });
  });
  it("no PF wage on the payslip → earned gross, flagged", () => {
    const l = ecrLine({ ...base, pfWage: null, lopAmount: 4000, lopDays: 3 });
    expect(l).toMatchObject({ epfWages: 36000, ncpDays: 3, wageAssumed: true });
  });
  it("a member without a 12-digit UAN is skipped with the reason", () => {
    expect(ecrLine({ ...base, uan: null })).toEqual({ skipped: expect.stringMatching(/No UAN/) });
    expect(ecrLine({ ...base, uan: "12345" })).toEqual({ skipped: expect.stringMatching(/not 12 digits/) });
  });
});

describe("ECR file", () => {
  it("one #~# line per PF member, non-members left out, skipped named, totals add up", () => {
    const f = buildEcr([
      base,
      { ...base, employee: "No PF", employeePf: 0, employerPf: 0 },
      { ...base, employee: "No UAN", uan: null },
    ]);
    expect(f.lines).toHaveLength(1);
    expect(f.text).toBe("100123456789#~#Asha Verma#~#40000#~#18000#~#18000#~#18000#~#2160#~#1499#~#661#~#0#~#0");
    expect(f.skipped).toEqual([{ employee: "No UAN", reason: expect.any(String) }]);
    expect(f.totals).toEqual({ epfWages: 18000, ee: 2160, eps: 1499, erDiff: 661 });
  });
});
