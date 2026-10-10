import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  simpleInterest, loanPosition, splitRepayment, addMonthsISO, loanSchedule, nextDue, overdueAmount,
  canUseLoansGiven, type LoanTerms, type RepaymentPart,
} from "./loans-given";

const interestFree: LoanTerms = {
  principal: 100_000, givenOn: "2026-04-01", interestRate: 0, plan: "one_shot", dueOn: "2026-10-01", instalments: null,
};
const twelvePct: LoanTerms = { ...interestFree, interestRate: 12 };

describe("simpleInterest", () => {
  it("is principal × rate × days / 365", () => {
    expect(simpleInterest(100_000, 12, 365)).toBeCloseTo(12_000);
    expect(simpleInterest(100_000, 12, 30)).toBeCloseTo(986.30, 1);
  });
  it("is zero for 0%, no days or nothing owed", () => {
    expect(simpleInterest(100_000, 0, 365)).toBe(0);
    expect(simpleInterest(100_000, 12, 0)).toBe(0);
    expect(simpleInterest(0, 12, 365)).toBe(0);
  });
});

describe("loanPosition", () => {
  it("interest-free: outstanding = principal − repaid", () => {
    const reps: RepaymentPart[] = [{ repaidOn: "2026-05-01", amount: 30_000, principalPart: 30_000, interestPart: 0 }];
    const p = loanPosition(interestFree, reps, "2026-06-01");
    expect(p).toEqual({ principalRepaid: 30_000, interestReceived: 0, principalLeft: 70_000, interestDue: 0, outstanding: 70_000 });
  });

  it("accrues simple interest on the principal left between events", () => {
    // 1 Apr → 1 May (30 days) on 1,00,000 @12% = 986.30; then 50,000 for 31 days = 509.59
    const reps: RepaymentPart[] = [{ repaidOn: "2026-05-01", amount: 50_986, principalPart: 50_000, interestPart: 986 }];
    const p = loanPosition(twelvePct, reps, "2026-06-01");
    expect(p.principalLeft).toBe(50_000);
    expect(p.interestDue).toBe(Math.round(986.30 + 509.59 - 986));
    expect(p.outstanding).toBe(50_000 + p.interestDue);
  });

  it("ignores repayments after the as-of date", () => {
    const reps: RepaymentPart[] = [{ repaidOn: "2026-09-01", amount: 10_000, principalPart: 10_000, interestPart: 0 }];
    expect(loanPosition(interestFree, reps, "2026-08-01").principalLeft).toBe(100_000);
  });

  it("never goes negative", () => {
    const reps: RepaymentPart[] = [{ repaidOn: "2026-05-01", amount: 150_000, principalPart: 150_000, interestPart: 0 }];
    const p = loanPosition(interestFree, reps, "2026-06-01");
    expect(p.principalLeft).toBe(0);
    expect(p.outstanding).toBe(0);
  });

  it("whole rupees out", () => {
    const p = loanPosition({ ...twelvePct, principal: 33_333 }, [], "2026-04-18");
    expect(Number.isInteger(p.interestDue)).toBe(true);
    expect(Number.isInteger(p.outstanding)).toBe(true);
  });
});

describe("splitRepayment", () => {
  it("pays interest first, then principal", () => {
    const s = splitRepayment(twelvePct, [], "2026-05-01", 10_000);
    expect(s.interestPart).toBe(986);
    expect(s.principalPart).toBe(9_014);
    expect(s.tooMuch).toBe(false);
    expect(s.closes).toBe(false);
  });
  it("a small payment can be all interest", () => {
    const s = splitRepayment(twelvePct, [], "2026-05-01", 500);
    expect(s).toMatchObject({ interestPart: 500, principalPart: 0 });
  });
  it("closes the loan when it pays everything", () => {
    const s = splitRepayment(twelvePct, [], "2026-05-01", 100_986);
    expect(s.closes).toBe(true);
    expect(s.maxAmount).toBe(100_986);
  });
  it("flags more than is owed", () => {
    const s = splitRepayment(interestFree, [], "2026-05-01", 100_001);
    expect(s.tooMuch).toBe(true);
    expect(s.closes).toBe(false);
  });
  it("interest-free: everything is principal", () => {
    expect(splitRepayment(interestFree, [], "2026-09-01", 100_000)).toMatchObject({ interestPart: 0, principalPart: 100_000, closes: true });
  });
});

describe("addMonthsISO", () => {
  it("adds months and keeps the day", () => {
    expect(addMonthsISO("2026-04-15", 1)).toBe("2026-05-15");
    expect(addMonthsISO("2026-11-15", 3)).toBe("2027-02-15");
  });
  it("a 31st falls back to month end", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2028-01-31", 1)).toBe("2028-02-29");
  });
});

describe("loanSchedule / nextDue / overdue", () => {
  const monthly: LoanTerms = { ...interestFree, principal: 100_000, plan: "instalments", instalments: 3, dueOn: "2026-05-01" };

  it("N equal monthly parts, the last takes the rounding", () => {
    const rows = loanSchedule(monthly, 0, "2026-04-02");
    expect(rows.map((r) => r.principal)).toEqual([33_333, 33_333, 33_334]);
    expect(rows.map((r) => r.dueOn)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    expect(rows[2].cumulative).toBe(100_000);
    expect(rows.every((r) => r.state === "due")).toBe(true);
  });

  it("applies repaid principal in order and marks overdue rows", () => {
    const rows = loanSchedule(monthly, 40_000, "2026-06-15");
    expect(rows.map((r) => r.state)).toEqual(["paid", "overdue", "due"]);
    expect(rows[1].unpaid).toBe(26_666);
    expect(overdueAmount(rows)).toBe(26_666);
    expect(nextDue(rows)?.n).toBe(2);
  });

  it("not overdue on the due date itself", () => {
    expect(overdueAmount(loanSchedule(monthly, 0, "2026-05-01"))).toBe(0);
  });

  it("one-shot: one row; no fixed date is never overdue", () => {
    expect(loanSchedule(interestFree, 0, "2026-12-01")[0].state).toBe("overdue");
    const open = loanSchedule({ ...interestFree, dueOn: null }, 0, "2030-01-01");
    expect(open).toHaveLength(1);
    expect(overdueAmount(open)).toBe(0);
  });

  it("fully repaid: nothing next, nothing overdue", () => {
    const rows = loanSchedule(monthly, 100_000, "2027-01-01");
    expect(nextDue(rows)).toBeNull();
    expect(overdueAmount(rows)).toBe(0);
  });
});

describe("role guard", () => {
  it("owner and accountant only", () => {
    expect(canUseLoansGiven("owner")).toBe(true);
    expect(canUseLoansGiven("accountant")).toBe(true);
    for (const r of ["manager", "billing", "sales", "support", "delivery", null, undefined]) {
      expect(canUseLoansGiven(r)).toBe(false);
    }
  });
});

describe("migration 20261010140000 — tenant + role guards", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../../../supabase/migrations/20261010140000_loans_given.sql"), "utf8");

  it("has RLS on both tables, read limited to tenant + owner/accountant, and a service_role policy", () => {
    expect(sql).toMatch(/alter table public\.loans_given\s+enable row level security/);
    expect(sql).toMatch(/alter table public\.loan_repayments enable row level security/);
    expect(sql).toMatch(/tenant_id = public\.current_tenant_id\(\)\s+and public\.current_user_has_role\('owner', 'accountant'\)/);
    expect(sql).toContain("zzz_service_role_all");
  });

  it("gives authenticated no direct write grant — writes only through the RPCs", () => {
    expect(sql).not.toMatch(/^grant [^;\n]*\b(insert|update|delete)\b[^;\n]* on public\.(loans_given|loan_repayments)\s+to authenticated/m);
  });

  it("every RPC checks tenant and role", () => {
    const fns = sql.split("create or replace function").slice(1);
    expect(fns).toHaveLength(4);
    for (const f of fns) {
      expect(f).toContain("public.current_tenant_id()");
      expect(f).toContain("security definer");
    }
    // Writes: owner / accountant only.
    for (const f of fns.slice(0, 3)) expect(f).toContain("public.current_user_has_role('owner', 'accountant')");
    // The Balance Sheet total: also the manager (who reads the Balance Sheet), and no names.
    expect(fns[3]).toContain("public.current_user_has_role('owner', 'manager', 'accountant')");
    expect(fns[3]).toContain("returns bigint");
  });

  it("refuses a repayment above the principal left", () => {
    expect(sql).toMatch(/if v_prin > v_left then/);
  });
});
