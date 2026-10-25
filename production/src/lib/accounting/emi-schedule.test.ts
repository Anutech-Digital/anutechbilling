/**
 * R-1864: the EMI schedule maths. Owner examples (Pardeep, 24 Oct):
 *  1. Laptop ₹1,20,000, ₹20,000 down, ₹1,00,000 at 14% for 12 months → EMI ₹8,979; EMI 1 =
 *     ₹7,812 principal + ₹1,167 interest; the 12th EMI is ₹8,977 (it absorbs the rounding);
 *     principal adds up to exactly ₹1,00,000, interest ₹7,746.
 *  2. Phone ₹30,000 on no-cost EMI for 7 months → ₹4,286 × 6 + ₹4,284, no interest at all.
 *  3. After EMI 2 the owner prepays ₹20,000 → ₹64,285 owed; same tenure → EMI ₹6,848; same EMI
 *     → the loan ends sooner.
 */
import { describe, expect, it } from "vitest";
import {
  addMonthsIso, buildSchedule, currentVsNonCurrent, emiFor, recomputeRemaining, scheduleTotals, splitDebit, toRpcRows,
} from "./emi-schedule";

const laptop = () => buildSchedule({ principal: 100000, annualRatePct: 14, months: 12, firstDueOn: "2026-11-05" });

describe("buildSchedule — reducing balance", () => {
  it("laptop ₹1,00,000 at 14% for 12 months", () => {
    const rows = laptop();
    expect(emiFor(100000, 14, 12)).toBe(8979);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ seq: 1, dueOn: "2026-11-05", emi: 8979, principal: 7812, interest: 1167, balanceAfter: 92188 });
    expect(rows[1]).toMatchObject({ dueOn: "2026-12-05", principal: 7903, interest: 1076, balanceAfter: 84285 });
    expect(rows[11]).toEqual({ seq: 12, dueOn: "2027-10-05", emi: 8977, principal: 8873, interest: 104, balanceAfter: 0 });
    expect(scheduleTotals(rows)).toEqual({ emi: 107746, principal: 100000, interest: 7746 });
  });

  it("every row: EMI = principal + interest, the balance chains down to 0", () => {
    let bal = 100000;
    for (const r of laptop()) {
      expect(r.emi).toBe(r.principal + r.interest);
      bal -= r.principal;
      expect(r.balanceAfter).toBe(bal);
    }
    expect(bal).toBe(0);
  });

  it("no-cost EMI: zero interest, the last EMI absorbs the rupees", () => {
    const rows = buildSchedule({ principal: 30000, annualRatePct: 0, months: 7, firstDueOn: "2026-11-01" });
    expect(rows.map((r) => r.emi)).toEqual([4286, 4286, 4286, 4286, 4286, 4286, 4284]);
    expect(rows.every((r) => r.interest === 0)).toBe(true);
    expect(scheduleTotals(rows).principal).toBe(30000);
  });

  it("a lender's EMI is used as given", () => {
    const rows = buildSchedule({ principal: 100000, annualRatePct: 14, months: 12, firstDueOn: "2026-11-05", emi: 9000 });
    expect(rows[0]).toMatchObject({ emi: 9000, interest: 1167, principal: 7833 });
    expect(scheduleTotals(rows).principal).toBe(100000);
    expect(rows.at(-1)!.balanceAfter).toBe(0);
  });

  it("refuses an EMI that does not cover the interest", () => {
    expect(() => buildSchedule({ principal: 100000, annualRatePct: 14, months: 12, firstDueOn: "2026-11-05", emi: 1000 }))
      .toThrow(/does not cover/);
  });

  it("nothing to schedule → no rows", () => {
    expect(buildSchedule({ principal: 0, annualRatePct: 14, months: 12, firstDueOn: "2026-11-05" })).toEqual([]);
    expect(buildSchedule({ principal: 1000, annualRatePct: 14, months: 0, firstDueOn: "2026-11-05" })).toEqual([]);
  });

  it("month-end due dates clamp (31 Jan → 28 Feb → 31 Mar)", () => {
    expect(addMonthsIso("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsIso("2027-01-31", 2)).toBe("2027-03-31");
    expect(addMonthsIso("2026-11-05", 2)).toBe("2027-01-05");
  });
});

describe("recomputeRemaining — after a prepayment", () => {
  it("₹20,000 prepaid after EMI 2: same tenure → smaller EMI", () => {
    const rows = recomputeRemaining({ outstanding: 64285, annualRatePct: 14, nextSeq: 3, nextDueOn: "2027-01-05",
      remainingMonths: 10, currentEmi: 8979, mode: "reduce_emi" });
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ seq: 3, dueOn: "2027-01-05", emi: 6848, principal: 6098, interest: 750 });
    expect(rows.at(-1)).toMatchObject({ seq: 12, emi: 6849, balanceAfter: 0 });
    expect(scheduleTotals(rows).principal).toBe(64285);
  });

  it("same EMI → the loan ends sooner", () => {
    const rows = recomputeRemaining({ outstanding: 64285, annualRatePct: 14, nextSeq: 3, nextDueOn: "2027-01-05",
      remainingMonths: 10, currentEmi: 8979, mode: "reduce_tenure" });
    expect(rows.length).toBeLessThan(10);
    expect(rows[0].emi).toBe(8979);
    expect(scheduleTotals(rows).principal).toBe(64285);
    expect(rows.at(-1)!.balanceAfter).toBe(0);
  });

  it("nothing left owed → no rows", () => {
    expect(recomputeRemaining({ outstanding: 0, annualRatePct: 14, nextSeq: 3, nextDueOn: "2027-01-05",
      remainingMonths: 10, currentEmi: 8979, mode: "reduce_emi" })).toEqual([]);
  });
});

describe("splitDebit — a bank debit against its instalment", () => {
  const emi2 = { emi: 8979, principal: 7903, interest: 1076 };
  it("same amount → schedule split", () => {
    expect(splitDebit(emi2, 8979)).toEqual({ principal: 7903, interest: 1076, charges: 0, difference: 0, recompute: false });
  });
  it("₹50 more as a late fee → an expense, principal unchanged", () => {
    expect(splitDebit(emi2, 9029, "late_fee")).toEqual({ principal: 7903, interest: 1076, charges: 50, difference: 50, recompute: false });
  });
  it("₹50 more as extra principal → part prepayment, schedule recomputed", () => {
    expect(splitDebit(emi2, 9029, "prepay")).toEqual({ principal: 7953, interest: 1076, charges: 0, difference: 50, recompute: true });
  });
  it("less than the EMI → interest first, the rest is principal", () => {
    expect(splitDebit(emi2, 5000)).toEqual({ principal: 3924, interest: 1076, charges: 0, difference: -3979, recompute: true });
    expect(splitDebit(emi2, 800)).toMatchObject({ principal: 0, interest: 800 });
  });
  it("never puts the whole EMI into expense", () => {
    const s = splitDebit(emi2, 9029, "late_fee");
    expect(s.interest + s.charges).toBe(1126);
  });
});

describe("helpers", () => {
  it("toRpcRows uses the database's names", () => {
    expect(toRpcRows(laptop().slice(0, 1))).toEqual([{ seq: 1, due_on: "2026-11-05", emi: 8979, principal: 7812, interest: 1167, balance_after: 92188 }]);
  });
  it("current = principal due within 12 months; the rest is non-current", () => {
    const rows = laptop().map((r) => ({ dueOn: r.dueOn, principal: r.principal, paid: r.seq <= 2 }));
    const split = currentVsNonCurrent(rows, "2026-12-31");
    expect(split.current + split.nonCurrent).toBe(84285);
    expect(split.nonCurrent).toBe(0);
    const later = currentVsNonCurrent(rows, "2026-09-30");
    expect(later.nonCurrent).toBe(8873); // EMI 12 (5 Oct 2027) is after 30 Sep 2027
  });
});
