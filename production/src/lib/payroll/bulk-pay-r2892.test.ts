/* R-2892 — "Pay selected": the draft is what Pay salary opens with (LOP from attendance applied);
   the runner books one by one, stops at the first failure, never pays someone twice. */
import { describe, expect, it, vi } from "vitest";
import { buildSalaryDraft, lopSuggestionForMonth, type DraftEmployee } from "./salary-draft";
import { bulkPayInput, bulkSkipReason, bulkTotal, runBulkPay, type BulkPlanRow } from "./bulk-pay";

const asha: DraftEmployee = {
  id: "emp-asha", name: "Asha Rani", is_active: true, joining_date: "2026-01-01", exit_date: null,
  monthly_gross: 30000, basic_monthly: 15000, da_monthly: 0, pf_applicable: true, pf_full_wage: false, esi_applicable: false,
} as DraftEmployee;

/* September 2026: 30 days, Sundays 6/13/20/27 → 26 working days. */
const workingDays = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`)
  .filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
const attendance = (skip: string[]) => workingDays.filter((d) => !skip.includes(d)).map((d) => ({
  employee_id: "emp-asha", work_date: d, check_in: `${d}T04:00:00Z`, check_out: null,
}));

const lop = (emp: DraftEmployee, skip: string[]) => lopSuggestionForMonth({
  period: "2026-09", employee: emp, todayIso: "2026-11-17", companyHolidays: [], attendance: attendance(skip), leaves: [],
});
const draftOf = (over: Partial<Parameters<typeof buildSalaryDraft>[0]> = {}) => buildSalaryDraft({
  employee: asha, period: "2026-09", todayIso: "2026-11-17", revisions: [], history: [], arrears: null, lop: { lopDays: 0 }, ...over,
});

describe("R-2892 salary draft = what Pay salary opens with", () => {
  it("2 absences: 2 LOP days, 2,000 off, PF on the reduced wage, net = earned - PF", () => {
    const l = lop(asha, ["2026-09-03", "2026-09-04"]);
    expect(l.workingDays).toBe(26);
    expect(l.lopDays).toBe(2);
    const d = draftOf({ lop: l });
    expect(d.gross).toBe(30000);
    expect(d.lopAmount).toBe(2000);
    expect(d.pf).toBe(1680); // 12% of Basic 15,000 x 28,000/30,000 = 14,000
    expect(d.net).toBe(28000 - d.pf - d.esi - d.tds);
    expect(d.net).toBeGreaterThan(0);
  });

  it("full attendance: no LOP, full gross", () => {
    const d = draftOf({ lop: lop(asha, []) });
    expect(d.lopDays).toBe(0);
    expect(d.lopAmount).toBe(0);
    expect(d.net).toBe(30000 - d.pf - d.esi - d.tds);
  });

  it("PF / ESI switched off on the employee: all zero (rule Y1)", () => {
    const d = draftOf({ employee: { ...asha, pf_applicable: false, esi_applicable: false } });
    expect([d.pf, d.esi, d.pfEmployer, d.esiEmployer, d.pfWage]).toEqual([0, 0, 0, 0, null]);
  });

  it("a month not over pays only the days so far, as the form does", () => {
    const d = draftOf({ todayIso: "2026-09-10" });
    expect(d.payDays.complete).toBe(false);
    expect(d.gross).toBe(10000); // 10 of 30 days
  });

  it("exit month pays up to the last working day only (R-1896)", () => {
    expect(draftOf({ employee: { ...asha, exit_date: "2026-09-15" } }).gross).toBe(15000);
  });

  it("a revision from a later month does not change this month (Y2)", () => {
    const rev = {
      id: "r1", employee_id: "emp-asha", effective_from: "2026-10-01", monthly_gross: 40000, basic_monthly: 20000, da_monthly: 0,
      prev_monthly_gross: 30000, prev_basic_monthly: 15000, prev_da_monthly: 0, annual_ctc: null, note: null, created_by: null, created_at: "2026-10-01",
    };
    const d = draftOf({ employee: { ...asha, monthly_gross: 40000, basic_monthly: 20000 }, revisions: [rev as never] });
    expect(d.monthGross).toBe(30000);
    expect(d.gross).toBe(30000);
  });

  it("arrears ride only on a month after the months they are for", () => {
    const arrears = { due: 6000, paid: 0, outstanding: 6000, overpaid: 0, months: [{ period: "2026-08", arrears: 6000 }], monthsLabel: "Aug 2026", lastMonth: "2026-08" };
    const d = draftOf({ arrears: arrears as never });
    expect(d.arrears).toBe(6000);
    expect(d.net).toBe(30000 + 6000 - d.pf - d.esi - d.tds);
    expect(draftOf({ arrears: arrears as never, period: "2026-08" }).arrears).toBe(0);
  });
});

describe("R-2892 skip reasons", () => {
  const draft = draftOf();
  const base = { employee: asha, alreadyRun: false, draft, bankAccountId: "acct-hdfc" };
  it("pays a normal employee", () => expect(bulkSkipReason(base)).toBeNull());
  it("already run for the month", () => expect(bulkSkipReason({ ...base, alreadyRun: true })).toMatch(/already run/i));
  it("no salary set", () => {
    const e = { ...asha, monthly_gross: 0 };
    expect(bulkSkipReason({ ...base, employee: e, draft: draftOf({ employee: e }) })).toMatch(/Set salary/);
  });
  it("no bank chosen", () => expect(bulkSkipReason({ ...base, bankAccountId: null })).toMatch(/bank/i));
  it("net not above zero", () => expect(bulkSkipReason({ ...base, draft: { ...draft, net: 0 } })).toMatch(/Net pay/));
  it("inactive and not exiting", () => expect(bulkSkipReason({ ...base, employee: { ...asha, is_active: false } })).toMatch(/active/i));
});

function plan(ids: string[]): BulkPlanRow[] {
  const d = draftOf();
  return ids.map((id) => ({ employeeId: id, name: id, draft: d, skip: null, input: bulkPayInput(d, id, "2026-09-30", "acct-hdfc") }));
}

describe("R-2892 bulk input = the single Pay salary input", () => {
  it("same fields; no bonus / advance / other; bank and date as chosen", () => {
    const d = draftOf({ lop: { lopDays: 2 } });
    expect(bulkPayInput(d, "emp-asha", "2026-09-30", "acct-hdfc")).toEqual({
      employeeId: "emp-asha", period: "2026-09", payDate: "2026-09-30", gross: 30000, lopDays: 2, lopAmount: 2000, incentive: 0,
      advanceRecovered: 0, advanceLoanId: null, tds: d.tds, pf: d.pf, esi: d.esi, esiEmployer: d.esiEmployer, pfEmployer: d.pfEmployer,
      other: 0, bankAccountId: "acct-hdfc", pfWage: d.pfWage, arrears: 0,
    });
  });
  it("total counts only the people who will be paid", () => {
    const rows = plan(["a", "b"]);
    rows[1] = { ...rows[1], skip: "Salary already run for this month", input: null };
    expect(bulkTotal(rows)).toEqual({ count: 1, net: rows[0].draft!.net });
  });
});

describe("R-2892 runner", () => {
  const none = async () => new Set<string>();
  it("books everyone in order, one call each", async () => {
    const pay = vi.fn(async (_i: { employeeId: string }) => undefined);
    const r = await runBulkPay({ rows: plan(["a", "b", "c"]), readRunIds: none, pay });
    expect(pay.mock.calls.map((c) => c[0].employeeId)).toEqual(["a", "b", "c"]);
    expect(r).toEqual({ paid: ["a", "b", "c"], alreadyRun: [], failed: null, notRun: [] });
  });
  it("stops at the first failure: the rest are never touched", async () => {
    const pay = vi.fn(async (i: { employeeId: string }) => { if (i.employeeId === "b") throw new Error("Books are locked for September"); });
    const r = await runBulkPay({ rows: plan(["a", "b", "c", "d"]), readRunIds: none, pay });
    expect(pay).toHaveBeenCalledTimes(2);
    expect(r.paid).toEqual(["a"]);
    expect(r.failed).toEqual({ employeeId: "b", message: "Books are locked for September" });
    expect(r.notRun).toEqual(["c", "d"]);
  });
  it("retry does not pay twice: someone already run (fresh read) is left out", async () => {
    const pay = vi.fn(async () => undefined);
    const r = await runBulkPay({ rows: plan(["a", "b"]), readRunIds: async () => new Set(["a"]), pay });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(r.alreadyRun).toEqual(["a"]);
    expect(r.paid).toEqual(["b"]);
  });
  it("skipped rows are never booked", async () => {
    const pay = vi.fn(async () => undefined);
    const rows = plan(["a", "b"]);
    rows[0] = { ...rows[0], skip: "No bank account chosen", input: null };
    const r = await runBulkPay({ rows, readRunIds: none, pay });
    expect(r.paid).toEqual(["b"]);
    expect(pay).toHaveBeenCalledTimes(1);
  });
  it("a failed read of who is already run stops before paying (never guess)", async () => {
    const pay = vi.fn(async () => undefined);
    const r = await runBulkPay({ rows: plan(["a", "b"]), readRunIds: async () => { throw new Error("offline"); }, pay });
    expect(pay).not.toHaveBeenCalled();
    expect(r.failed?.employeeId).toBe("a");
    expect(r.notRun).toEqual(["b"]);
  });
});
