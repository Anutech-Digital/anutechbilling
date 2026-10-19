/** R-1585 — the CTC register's "actual this FY" columns are the sum of that FY's payslips. */
import { describe, it, expect } from "vitest";
import { fyPayslipActuals, type PayslipForActuals } from "./ctc-register";

const slip = (employee_id: string, period: string, o: Partial<PayslipForActuals> = {}): PayslipForActuals => ({
  employee_id, period, gross: 30_000, lop_amount: 0, incentive: 0, pf: 1_800, esi: 0, pf_employer: 1_800, esi_employer: 0, net: 28_000, ...o,
});

describe("fyPayslipActuals", () => {
  const slips = [
    slip("a", "2026-03"), // FY 2025-26 — must not count in FY 2026-27
    slip("a", "2026-04"),
    slip("a", "2026-05", { lop_amount: 1_000, incentive: 500 }),
    slip("b", "2026-06", { gross: 18_000, pf: 1_080, pf_employer: 1_080, esi: 135, esi_employer: 585, net: 16_785 }),
    slip("b", "2027-03", { gross: 18_000, pf: 1_080, pf_employer: 1_080, esi: 135, esi_employer: 585, net: 16_785 }),
    slip("a", "2027-04"), // next FY
  ];

  it("per employee: only the FY's months, earned = gross − LOP + incentive, cost adds employer PF + ESI", () => {
    const { byEmployee } = fyPayslipActuals(slips, 2026);
    const a = byEmployee.get("a")!;
    expect(a.months).toBe(2);
    expect(a.earned).toBe(30_000 + (30_000 - 1_000 + 500));
    expect(a.employerPf).toBe(3_600);
    expect(a.employerEsi).toBe(0);
    expect(a.cost).toBe(a.earned + 3_600);
    const b = byEmployee.get("b")!;
    expect(b.months).toBe(2);
    expect(b.employerEsi).toBe(1_170);
    expect(b.employeeEsi).toBe(270);
  });

  it("totals equal the plain sum of the FY's payslips", () => {
    const { totals } = fyPayslipActuals(slips, 2026);
    const fy = slips.filter((s) => s.period >= "2026-04" && s.period <= "2027-03");
    const sum = (f: (s: PayslipForActuals) => number) => fy.reduce((t, s) => t + f(s), 0);
    expect(totals.months).toBe(fy.length);
    expect(totals.gross).toBe(sum((s) => s.gross));
    expect(totals.earned).toBe(sum((s) => s.gross - s.lop_amount + s.incentive));
    expect(totals.employerPf).toBe(sum((s) => s.pf_employer));
    expect(totals.employerEsi).toBe(sum((s) => s.esi_employer));
    expect(totals.employeePf).toBe(sum((s) => s.pf));
    expect(totals.employeeEsi).toBe(sum((s) => s.esi));
    expect(totals.net).toBe(sum((s) => s.net));
    expect(totals.cost).toBe(totals.earned + totals.employerPf + totals.employerEsi);
  });
});
