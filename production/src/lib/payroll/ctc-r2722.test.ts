/**
 * R-2722 — payroll form follow-ups (staging 13 Nov on Prashant: gross 17,850, Basic 10,000).
 *  1) a CTC typed then cleared: the breakdown follows the saved figures, never CTC 0 / gross 10,000;
 *     the form never ends with an empty / 0 gross.
 *  2) Apply Salary Structure off when over budget / salary by revisions (G1); no saved Basic + CTC ±1
 *     keeps the gross (G2); a new employee's hand-typed gross survives a typed-then-cleared CTC (G3).
 *  3) PF / ESI unticked: the gross stays 17,850 (was re-derived 17,890 by the old CTC round trip).
 *  4) Revise salary wording: "already booked", and months booked before revisions named.
 */
import { describe, it, expect } from "vitest";
import {
  applyStructureBlockedReason, calculateCtcBreakdown, ctcFormFill, ctcFormulaText, ctcTabBreakdown, type CtcTabInput,
} from "./ctc";
import { revisionBookedNote } from "./salary-revision";
import { periodLabel } from "./period-label";

const NOV = "2026-11";
const prashant = { gross: 17_850, basic: 10_000, da: 0 };
const form: CtcTabInput = {
  ctcTyped: false, annualCtc: 0, gross: 17_850, basic: 10_000, da: 0,
  pfApplicable: true, esiApplicable: true, pfFullWage: false, includeGratuity: true, ctcIncludesEmployer: true,
  saved: prashant, calc: { asOf: NOV, customConveyanceMonthly: 1_600, customMedicalMonthly: 1_250 },
};
const base = { gross: "17850", basic: "10000" };
const fill = (b: ReturnType<typeof ctcTabBreakdown>, over: Partial<Parameters<typeof ctcFormFill>[0]> = {}) =>
  ctcFormFill({ ctcTyped: true, grossByHand: false, salaryByRevision: false, basicByHand: false, breakdown: b, base, ...over });

describe("R-2722 item 1 — CTC typed then cleared", () => {
  it("the saved figures, as before typing: CTC 2,41,344, gross 17,850 (staging showed CTC 0 / gross 10,000 / net 8,725)", () => {
    const before = ctcTabBreakdown(form);
    expect(before.annualCtc).toBe(241_344);
    for (const cleared of [0, Number.NaN]) {
      // the field is cleared while the form still holds the CTC-filled gross (before the effect runs)
      const b = ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: cleared, gross: 23_319 });
      expect(b.source).toBe("saved");
      expect(b.grossMonthly).toBe(17_850);
      expect(b.basicMonthly).toBe(10_000);
      expect(b.annualCtc).toBe(241_344);
      expect(b.monthlyCtc).toBe(before.monthlyCtc);
      expect(b.netTakeHomeMonthly).toBe(before.netTakeHomeMonthly);
      expect(b.netTakeHomeMonthly).not.toBe(8_725);
    }
  });
  it("an empty CTC never leaves the form's gross empty or 0 — it goes back to the saved salary", () => {
    const typed = ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: 300_000 });
    expect(fill(typed)).toEqual({ gross: "23319", basic: "10000" });
    const cleared = ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: 0, gross: 23_319 });
    const f = fill(cleared);
    expect(f).toEqual({ gross: "17850", basic: "10000" });
    expect(Math.round(Number(f?.gross) || 0)).toBe(17_850); // what submit() saves as monthly_gross
  });
  it("leaves the form alone when nothing was typed, the gross was typed by hand, or salary is by revisions", () => {
    const b = ctcTabBreakdown(form);
    expect(fill(b, { ctcTyped: false })).toBeNull();
    expect(fill(b, { grossByHand: true })).toBeNull();
    expect(fill(b, { salaryByRevision: true })).toBeNull();
    // a Basic typed by hand is not overwritten
    expect(fill(ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: 300_000 }), { basicByHand: true })).toEqual({ gross: "23319" });
  });
});

describe("R-2722 item 2 — Apply Salary Structure guard + G2 / G3", () => {
  it("G1: off when over budget (with the reason), off when the salary is set by revisions, on otherwise", () => {
    const over = ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: 120_000, saved: null, gross: 0, basic: null, calc: { asOf: NOV, customBasicMonthly: 20_000 } });
    expect(over.overBudget).toBe(true);
    expect(applyStructureBlockedReason(over, false)).toMatch(/Basic is more than this CTC allows/);
    const ok = ctcTabBreakdown({ ...form, ctcTyped: true, annualCtc: 300_000 });
    expect(applyStructureBlockedReason(ok, false)).toBeNull();
    expect(applyStructureBlockedReason(ok, true)).toMatch(/salary revisions/);
    // nothing typed for a new employee → no gross → Apply would write 0
    const empty = ctcTabBreakdown({ ...form, gross: 0, basic: null, saved: null });
    expect(empty.grossMonthly).toBe(0);
    expect(applyStructureBlockedReason(empty, false)).toMatch(/Type the annual CTC first/);
  });
  it("G2: no saved Basic — the shown CTC ±₹1 keeps the gross (was re-split 30,000 → ~31,547) and Basic stays not set", () => {
    const noBasic: CtcTabInput = { ...form, gross: 30_000, basic: null, esiApplicable: false, saved: { gross: 30_000, basic: null, da: 0 } };
    const shown = ctcTabBreakdown(noBasic);
    expect(shown.basicAssumed).toBe(true);
    for (const d of [-1, 1, 12, -12]) {
      const b = ctcTabBreakdown({ ...noBasic, ctcTyped: true, annualCtc: shown.annualCtc + d });
      expect(Math.abs(b.grossMonthly - 30_000)).toBeLessThanOrEqual(1);
      expect(b.basicAssumed).toBe(true);
      expect(b.overBudget).toBe(false);
      expect(b.costToCompanyMonthly).toBeLessThanOrEqual(b.monthlyCtc);
      // the form fills the gross but leaves Basic empty (not set)
      expect(fill(b, { base: { gross: "30000", basic: "" } })?.basic).toBe("");
    }
    // a bigger raise still fills the most gross that fits, and says Basic is not set
    const raise = ctcTabBreakdown({ ...noBasic, ctcTyped: true, annualCtc: 480_000 });
    expect(raise.grossMonthly).toBeGreaterThan(30_000);
    expect(raise.costToCompanyMonthly).toBeLessThanOrEqual(raise.monthlyCtc);
    expect(raise.monthlyCtc - raise.costToCompanyMonthly).toBeLessThanOrEqual(2);
    expect(ctcFormulaText(raise)).toMatch(/Basic is not set, so PF \/ gratuity are on the whole gross\.$/);
    // a Basic % picked in the dialog still splits by the calculator
    expect(ctcTabBreakdown({ ...noBasic, ctcTyped: true, annualCtc: 480_000, keepSavedBasic: false }).basicAssumed).toBe(false);
  });
  it("G2 with ESI: the gross that fits is found on both sides of the ₹21,000 ESI ceiling", () => {
    const esiNoBasic: CtcTabInput = { ...form, gross: 20_000, basic: null, pfApplicable: false, saved: { gross: 20_000, basic: null, da: 0 } };
    const shown = ctcTabBreakdown(esiNoBasic);
    const b = ctcTabBreakdown({ ...esiNoBasic, ctcTyped: true, annualCtc: shown.annualCtc + 1 });
    expect(b.grossMonthly).toBe(20_000);
    const big = ctcTabBreakdown({ ...esiNoBasic, ctcTyped: true, annualCtc: 22_500 * 12 });
    expect(big.costToCompanyMonthly).toBeLessThanOrEqual(big.monthlyCtc);
    expect(big.grossMonthly).toBeGreaterThan(21_000); // no employer ESI above the ceiling
  });
  it("G3: new employee — gross typed by hand, a CTC typed then cleared → the hand-typed gross comes back", () => {
    const newEmp: CtcTabInput = { ...form, saved: { gross: 15_000, basic: null, da: 0 }, gross: 15_000, basic: null };
    const newBase = { gross: "15000", basic: "" };
    const typed = ctcTabBreakdown({ ...newEmp, ctcTyped: true, annualCtc: 240_000 });
    expect(fill(typed, { base: newBase })?.gross).not.toBe("15000");
    const cleared = ctcTabBreakdown({ ...newEmp, ctcTyped: true, annualCtc: 0 });
    expect(cleared.grossMonthly).toBe(15_000);
    expect(fill(cleared, { base: newBase })).toEqual({ gross: "15000", basic: "" });
  });
});

describe("R-2722 item 3 — PF / ESI unticked in the unsaved form", () => {
  const off: CtcTabInput = { ...form, pfApplicable: false, esiApplicable: false };
  it("gross stays 17,850; only the CTC changes (2,41,344 → 2,19,972)", () => {
    const b = ctcTabBreakdown(off);
    expect(b.grossMonthly).toBe(17_850);
    expect(b.annualCtc).toBe(219_972);
    expect(b.employerPfMonthly + b.employerEsiMonthly + b.employeePfMonthly + b.employeeEsiMonthly).toBe(0);
    // the old tab ran 2,19,972 back through the CTC-first calculator (50% Basic) → 17,890
    expect(calculateCtcBreakdown(219_972, { asOf: NOV, includePf: false, includeEsi: false, customConveyanceMonthly: 1_600, customMedicalMonthly: 1_250 }).grossMonthly).toBe(17_890);
  });
  it("typing the shown CTC back, or ±₹1, keeps 17,850 — no rounding round trip", () => {
    for (const d of [0, 1, -1]) {
      const b = ctcTabBreakdown({ ...off, ctcTyped: true, annualCtc: 219_972 + d });
      expect(Math.abs(b.grossMonthly - 17_850)).toBeLessThanOrEqual(1);
      expect(b.basicMonthly).toBe(10_000);
      if (d === 0) expect(fill(b)).toEqual({ gross: "17850", basic: "10000" });
    }
  });
});

describe("R-2722 item 4 — Revise salary: booked months wording", () => {
  it("says 'already booked', never 'already paid'", () => {
    const n = revisionBookedNote([{ period: "2026-09", salary_in_force: 17_850 }], periodLabel);
    expect(n.booked).toBe("September 2026 is already booked at the old salary — it stays as booked.");
    expect(n.booked).not.toMatch(/paid/);
    expect(n.legacy).toBeNull();
  });
  it("names months booked before salary revisions — check the old salary", () => {
    const n = revisionBookedNote([
      { period: "2026-08", salary_in_force: null },
      { period: "2026-09", salary_in_force: null },
      { period: "2026-10", salary_in_force: 17_850 },
    ], periodLabel);
    expect(n.booked).toMatch(/^August 2026, September 2026, October 2026 are already booked at the old salary — they stay as booked\.$/);
    expect(n.legacy).toBe("August 2026, September 2026 were booked before salary revisions — check the old salary used for them.");
  });
});
