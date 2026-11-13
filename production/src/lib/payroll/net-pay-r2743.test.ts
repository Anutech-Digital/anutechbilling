/**
 * R-2743 (follow-ups from the R-2733 review, Hitesh's payroll screens):
 *  1. the CTC register's Net Take Home total is not a number until every row's net has loaded
 *     (it read ₹0 — and exported 0 — while payslips / revisions were still loading);
 *  2. Revise salary's "Take-home" is the ONE net-pay source (monthNetPay: gross − PF − ESI − TDS,
 *     no PT — owner 13 Nov), not ctc.ts netTakeHomeMonthly (PT deducted, no TDS);
 *  3. a Basic set from a Basic % is recomputed when the DA changes (Basic + DA never over gross).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { basicFromPct, monthNetPay, netPayTotal, revisedTakeHome } from "./net-pay";
import { ctcFromEmployee } from "./ctc";

const emp = {
  monthly_gross: 30_000, basic_monthly: null as number | null, da_monthly: 0,
  pf_applicable: true, esi_applicable: false, pf_full_wage: false,
};

describe("R-2743 (1): CTC register Net Take Home total while loading", () => {
  it("is null (not ₹0) until the payslips + revisions are in, even when every row is still null", () => {
    expect(netPayTotal([null, null], false)).toBeNull();
    expect(netPayTotal([], false)).toBeNull();
  });

  it("is the sum of the loaded nets once ready; a row with no salary ('—') adds nothing", () => {
    const a = monthNetPay(emp, [], "2026-11", [])!;
    const b = monthNetPay({ ...emp, monthly_gross: 21_000, esi_applicable: true }, [], "2026-11", [])!;
    expect(a.net).toBe(27_000);
    expect(netPayTotal([a, b, null], true)).toBe(a.net + b.net);
    expect(netPayTotal([], true)).toBe(0);
  });

  it("the register page reads it: the total cell shows '…' and the export waits (no `r.net?.net ?? 0` sum)", () => {
    const src = readFileSync(path.join(__dirname, "../../app/(app)/accounting/salary-register/page.tsx"), "utf8");
    expect(src).toContain("netPayTotal(");
    expect(src).not.toContain("net: t.net + (r.net?.net ?? 0)");
    expect(src).toMatch(/disabled=\{!netReady\}/);
  });
});

describe("R-2743 (2): Revise salary take-home = the shared net (no PT, TDS in)", () => {
  it("the unchanged salary gives exactly the Employees table's In-hand (same function, same inputs)", () => {
    const inHand = monthNetPay(emp, [], "2026-11", [])!;
    const next = { monthly_gross: 30_000, basic_monthly: null, da_monthly: 0 };
    const th = revisedTakeHome(next, emp, "2026-11", [])!;
    expect(th.net).toBe(inHand.net);
    expect(th.net).toBe(27_000); // 30,000 − PF 3,000 (whole gross, capped) − TDS 0
  });

  it("differs from the old ctc.ts figure, which deducted PT and no TDS", () => {
    const next = { monthly_gross: 300_000, basic_monthly: 75_000, da_monthly: 0 };
    const old = ctcFromEmployee({ ...next, ...emp }, { asOf: "2026-11" }).netTakeHomeMonthly;
    const th = revisedTakeHome(next, emp, "2026-11", [])!;
    expect(th.tds).toBeGreaterThan(0);
    expect(th.net).toBe(300_000 - th.pf - th.esi - th.tds);
    expect(th.net).not.toBe(old);
    expect(th.explain).not.toMatch(/\bPT\b|Professional/);
  });

  it("a raise is worked out on the NEW structure (a revision in the history does not pull it back)", () => {
    const next = { monthly_gross: 40_000, basic_monthly: 20_000, da_monthly: 0 };
    const th = revisedTakeHome(next, emp, "2026-12", [{ period: "2026-11", gross: 30_000, lop_amount: 0, incentive: 0, tds: 0, esi: 0 }])!;
    expect(th.gross).toBe(40_000);
    expect(th.pf).toBe(2_400); // 12% of Basic 20,000 (under the ₹25,000 ceiling)
    expect(th.net).toBe(40_000 - 2_400 - th.tds);
  });

  it("no gross → null (the dialog shows nothing, never a made-up figure)", () => {
    expect(revisedTakeHome({ monthly_gross: 0, basic_monthly: null, da_monthly: 0 }, emp, "2026-11", [])).toBeNull();
  });

  it("the dialog uses it (ctc.ts netTakeHomeMonthly is gone from Revise salary)", () => {
    const src = readFileSync(path.join(__dirname, "../../components/features/payroll/revise-salary-dialog.tsx"), "utf8");
    expect(src).toContain("revisedTakeHome(");
    expect(src).not.toContain("breakdown.netTakeHomeMonthly");
  });
});

describe("R-2743 (3): Basic % follows a DA change", () => {
  it("60% of 30,000 = 18,000; DA raised to 15,000 → Basic 15,000 (gross − DA), never 18,000 + 15,000 over gross", () => {
    expect(basicFromPct(0.6, 30_000, 0)).toBe(18_000);
    expect(basicFromPct(0.6, 30_000, 15_000)).toBe(15_000);
    expect(basicFromPct(1, 30_000, 5_000)).toBe(25_000);
    // DA lowered again → the % is back in full
    expect(basicFromPct(0.6, 30_000, 1_000)).toBe(18_000);
  });

  it("the DA box on the employee form re-applies the Basic % in force", () => {
    const src = readFileSync(path.join(__dirname, "../../app/(app)/accounting/payroll/screens.tsx"), "utf8");
    const da = src.slice(src.indexOf('id="payroll-da-month"'));
    const onChange = da.slice(0, da.indexOf("/>"));
    expect(onChange).toContain("setDaMonthly(e.target.value)");
    expect(onChange).toContain("if (basicPctOfGross !== null) setBasicFromPct(basicPctOfGross, gross, e.target.value)");
  });
});
