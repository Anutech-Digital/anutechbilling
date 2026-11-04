/* R-2407 — a salary payout that also pays back money owed to the same employee.
   Owner example (staging 4523): Neelam paid ₹16,000 in by mistake; her October salary ₹30,000 went
   out as one ₹46,000 line → "also pays back ₹16,000 owed to Neelam". */
import { describe, expect, it } from "vitest";

import { owedBackMatches } from "./owed-back";

const neelamSalary = { id: "s1", employee_id: "e1", employee_name: "Neelam Sharma", period: "2026-10", remaining: 30000 };
const raviSalary = { id: "s2", employee_id: "e2", employee_name: "Ravi Verma", period: "2026-10", remaining: 40000 };
const owedNeelam = { id: "r1", person_name: "Neelam Sharma", employee_id: "e1", amount: 16000 };

describe("R-2407 owedBackMatches", () => {
  it("salary due + owed back of the same employee = the line → offered", () => {
    const m = owedBackMatches(46000, [raviSalary, neelamSalary], [owedNeelam]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ salary: { id: "s1" }, owed: { id: "r1" }, salaryPart: 30000 });
  });

  it("another employee's payable is never offered on this salary", () => {
    expect(owedBackMatches(56000, [raviSalary], [owedNeelam])).toEqual([]);
  });

  it("by name when the payable has no employee id", () => {
    const m = owedBackMatches(46000, [neelamSalary], [{ ...owedNeelam, employee_id: null, person_name: "NEELAM  sharma" }]);
    expect(m).toHaveLength(1);
  });

  /* Review finding: a plain ₹30,000 salary line with a ₹500 pending reimbursement must NOT turn
     into "₹29,500 salary + ₹500 owed back". Only an exact due + owed fit is offered. */
  it("a near fit is not offered: plain salary line, or salary left partly due", () => {
    const petrol = { id: "r9", person_name: "Neelam Sharma", employee_id: "e1", amount: 500 };
    expect(owedBackMatches(30000, [neelamSalary], [petrol])).toEqual([]);
    expect(owedBackMatches(36000, [neelamSalary], [owedNeelam])).toEqual([]);
    expect(owedBackMatches(50000, [neelamSalary], [owedNeelam])).toEqual([]);
  });

  it("a line no bigger than the payable is not a salary + owed back", () => {
    expect(owedBackMatches(16000, [neelamSalary], [owedNeelam])).toEqual([]);
  });
});
