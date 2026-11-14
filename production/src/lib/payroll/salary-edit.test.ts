/* R-2771 — change one booked salary month from the Salary Register (Hitesh, staging 14 Nov).
   Pure rules behind the one shared row menu + the Pay salary form in edit mode. */
import { describe, expect, it, vi } from "vitest";
import {
  salaryRowActionState, salaryEditPrefill, arrearsWhileEditing, loanOutstandingWhileEditing, rebookSalary, revisedSinceBookedInfo,
  type BookedSalary,
} from "./salary-edit";
import { arrearsSummary } from "./salary-revision";

const booked = (o: Partial<BookedSalary> = {}): BookedSalary => ({
  id: "sal-oct", period: "2026-10", pay_date: "2026-10-31", gross: 30000, lop_days: 1, lop_amount: 968,
  incentive: 2000, arrears: 0, advance_recovered: 0, advance_loan_id: null, tds: 0, pf: 1800, esi: 0,
  pf_employer: 1800, esi_employer: 0, pf_wage: 15000, other_deduction: 0, bank_account_id: "acct-hdfc",
  paid_amount: 0, paid_status: "unpaid", ...o,
});

describe("salaryRowActionState — which actions a booked month offers", () => {
  it("not yet paid by a bank line: Edit + Undo, no lock", () => {
    expect(salaryRowActionState(booked(), true)).toEqual({ edit: true, undo: true, adjustLop: false, lockReason: null, editNote: null });
  });
  it("recovered an advance whose record was deleted since: no one-step Edit (the recovery would be dropped), Undo stays", () => {
    const s = salaryRowActionState(booked({ advance_recovered: 5000, advance_loan_id: null }), true);
    expect(s).toMatchObject({ edit: false, undo: true, lockReason: null });
    expect(s.editNote).toMatch(/advance record was deleted/);
    expect(salaryRowActionState(booked({ advance_recovered: 5000, advance_loan_id: "loan-1" }), true).edit).toBe(true);
  });
  it("paid by a linked bank line: no Edit / Undo / LOP, says why", () => {
    const s = salaryRowActionState(booked({ paid_amount: 27232, paid_status: "paid" }), true);
    expect(s).toMatchObject({ edit: false, undo: false, adjustLop: false });
    expect(s.lockReason).toBe("Linked to a bank line — un-link it first to edit");
  });
  it("part-paid: only Edit salary — set LOP (R-2428), with the lock line", () => {
    const s = salaryRowActionState(booked({ paid_amount: 10000, paid_status: "partial" }), true);
    expect(s).toMatchObject({ edit: false, undo: false, adjustLop: true });
    expect(s.lockReason).toMatch(/un-link it first/);
  });
  it("month after the employee's exit month (rev-r2771 #3): no Edit — the re-book would be refused (tg_salary_after_exit) and leave the month unpaid; Undo stays", () => {
    const s = salaryRowActionState(booked({ period: "2026-10" }), true, { exitDate: "2026-09-20" });
    expect(s).toMatchObject({ edit: false, undo: true, lockReason: null });
    expect(s.editNote).toBe("Edit not possible — October 2026 is after the last working day (20 Sept 2026). Undo salary if it should not be booked.");
    // the exit month itself (final salary) and earlier months stay editable; no exit date = editable
    expect(salaryRowActionState(booked({ period: "2026-09" }), true, { exitDate: "2026-09-20" }).edit).toBe(true);
    expect(salaryRowActionState(booked({ period: "2026-08" }), true, { exitDate: "2026-09-20" }).edit).toBe(true);
    expect(salaryRowActionState(booked({ period: "2026-10" }), true, { exitDate: null }).edit).toBe(true);
    expect(salaryRowActionState(booked({ period: "2026-10" }), false, { exitDate: "2026-09-20" }).editNote).toBeNull();
  });
  it("viewer (no money write): no actions at all; a linked month still says it is locked", () => {
    expect(salaryRowActionState(booked(), false)).toEqual({ edit: false, undo: false, adjustLop: false, lockReason: null, editNote: null });
    expect(salaryRowActionState(booked({ advance_recovered: 5000, advance_loan_id: null }), false).editNote).toBeNull();
    const s = salaryRowActionState(booked({ paid_amount: 27232, paid_status: "paid" }), false);
    expect(s).toMatchObject({ edit: false, undo: false, adjustLop: false });
    expect(s.lockReason).not.toBeNull();
  });
});

describe("salaryEditPrefill — the form starts from what is booked", () => {
  it("every figure of THAT month, so a one-field change is one field", () => {
    expect(salaryEditPrefill(booked())).toEqual({
      gross: 30000, bonus: 2000, arrears: 0, lopDays: 1, lopAmount: 968, advanceLoanId: null, advanceRecovered: 0,
      tds: 0, pf: 1800, esi: 0, pfEmployer: 1800, esiEmployer: 0, pfWage: 15000, other: 0,
      payDate: "2026-10-31", bankAccountId: "acct-hdfc",
    });
  });
  it("arrears ride inside incentive (pay_salary_with_arrears) — split back out", () => {
    const f = salaryEditPrefill(booked({ incentive: 8000, arrears: 6000 }));
    expect(f.bonus).toBe(2000);
    expect(f.arrears).toBe(6000);
  });
  it("advance recovery keeps its loan", () => {
    const f = salaryEditPrefill(booked({ advance_recovered: 5000, advance_loan_id: "loan-1" }));
    expect(f).toMatchObject({ advanceLoanId: "loan-1", advanceRecovered: 5000 });
  });
});

describe("limits while the old row is still booked", () => {
  it("arrears: this row's arrears count as still due again (never above what was due)", () => {
    const s = arrearsSummary([{ period: "2026-09", arrears: 6000 }], 6000);
    expect(s.outstanding).toBe(0);
    const e = arrearsWhileEditing(s, 6000)!;
    expect(e.outstanding).toBe(6000);
    expect(e.paid).toBe(0);
    expect(arrearsWhileEditing(s, 0)).toBe(s);
    expect(arrearsWhileEditing(null, 6000)).toBeNull();
  });
  it("advance: the loan this salary recovered from gets that recovery back", () => {
    const p = booked({ advance_recovered: 5000, advance_loan_id: "loan-1" });
    expect(loanOutstandingWhileEditing({ id: "loan-1", outstanding: 0 }, p)).toBe(5000);
    expect(loanOutstandingWhileEditing({ id: "loan-2", outstanding: 3000 }, p)).toBe(3000);
    expect(loanOutstandingWhileEditing({ id: "loan-1", outstanding: 1000 }, null)).toBe(1000);
  });
});

describe("revisedSinceBookedInfo — the month was revised after it was booked (Y2)", () => {
  it("booked at 30,000, the month is now 33,000 → says so, with the booked gross scaled to the raise", () => {
    expect(revisedSinceBookedInfo({ gross: 30000, salary_in_force: 30000 }, 33000)).toEqual({ bookedAt: 30000, atRevised: 33000, arrears: "unknown" });
    expect(revisedSinceBookedInfo({ gross: 15000, salary_in_force: 30000 }, 33000)).toEqual({ bookedAt: 30000, atRevised: 16500, arrears: "unknown" });
  });
  it("rev-r2771 #4 — the raise is never paid twice: the offer needs the arrears summary, and none of the arrears paid", () => {
    const row = { gross: 30000, salary_in_force: 30000, period: "2026-10" };
    // Oct's ₹3,000 arrears are still due → paying Oct at the revised salary is the one payment of the raise.
    expect(revisedSinceBookedInfo(row, 33000, arrearsSummary([{ period: "2026-10", arrears: 3000 }], 0))!.arrears).toBe("due");
    // Already paid with November's salary → paying Oct at ₹33,000 too would pay the raise twice.
    expect(revisedSinceBookedInfo(row, 33000, arrearsSummary([{ period: "2026-10", arrears: 3000 }], 3000))!.arrears).toBe("paid");
    // Part paid across months — cannot say which month it was for → treated as paid (no offer).
    expect(revisedSinceBookedInfo(row, 33000, arrearsSummary([{ period: "2026-09", arrears: 3000 }, { period: "2026-10", arrears: 3000 }], 3000))!.arrears).toBe("paid");
    // Summary not read yet → unknown (no offer until it is).
    expect(revisedSinceBookedInfo(row, 33000, null)!.arrears).toBe("unknown");
  });
  it("same salary, a row from before revisions (no stored salary) or no edit → nothing", () => {
    expect(revisedSinceBookedInfo({ gross: 30000, salary_in_force: 30000 }, 30000)).toBeNull();
    expect(revisedSinceBookedInfo({ gross: 30000, salary_in_force: null }, 33000)).toBeNull();
    expect(revisedSinceBookedInfo(null, 33000)).toBeNull();
  });
});

describe("rebookSalary — Save = undo the old run, then book the new one (same RPCs as Payroll)", () => {
  it("undo first, then pay", async () => {
    const calls: string[] = [];
    const r = await rebookSalary("sal-oct", { undo: async (id) => { calls.push(`undo ${id}`); }, pay: async () => { calls.push("pay"); } });
    expect(r).toEqual({ ok: true, oldRemoved: true });
    expect(calls).toEqual(["undo sal-oct", "pay"]);
  });
  it("undo refused (e.g. linked meanwhile) → nothing booked, old salary stays", async () => {
    const pay = vi.fn();
    const r = await rebookSalary("sal-oct", { undo: async () => { throw new Error("reconciled"); }, pay });
    expect(r).toMatchObject({ ok: false, oldRemoved: false });
    expect(pay).not.toHaveBeenCalled();
  });
  it("pay fails after the undo → says the old run is removed so Save again only books", async () => {
    const r = await rebookSalary("sal-oct", { undo: async () => {}, pay: async () => { throw new Error("no bank"); } });
    expect(r).toMatchObject({ ok: false, oldRemoved: true });
  });
  it("old run already removed (second Save) → only books", async () => {
    const undo = vi.fn();
    const r = await rebookSalary(null, { undo, pay: async () => {} });
    expect(r).toEqual({ ok: true, oldRemoved: false });
    expect(undo).not.toHaveBeenCalled();
  });
});
