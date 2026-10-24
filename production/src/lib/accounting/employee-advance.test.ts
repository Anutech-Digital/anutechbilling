import { describe, it, expect } from "vitest";
import {
  advanceForReturn, advanceRegister, billProblem, isOverdueAdvance, openAdvancesOf, openEmployeeAdvanceTotal, parseRupees,
  REGISTER_CSV_HEADERS, registerCsvRows, returnedFromNotes, samePerson, splitBills, type AdvanceLite,
} from "./employee-advance";

const adv = (id: string, name: string, left: number, date: string, status: AdvanceLite["status"] = "active"): AdvanceLite =>
  ({ id, employee_name: name, remaining_balance: left, disbursed_date: date, status });

describe("R-1871 employee office-expense advance rules", () => {
  // Owner example 1: ₹10,000 given, bills ₹6,500 incl. GST → ₹3,500 still with Ramesh, nothing to reimburse.
  it("₹6,500 of bills on a ₹10,000 advance leaves ₹3,500, no reimbursement", () => {
    expect(splitBills([{ amount: 4130, gst: 630 }, { amount: 2370, gst: 0 }], 10000))
      .toEqual({ total: 6500, fromAdvance: 6500, extra: 0, left: 3500 });
  });

  // Owner example 2: ₹2,000 left, bills ₹3,200 → ₹1,200 owed to the employee.
  it("bills over the balance: the extra is a reimbursement", () => {
    expect(splitBills([{ amount: 3200, gst: 480 }], 2000)).toEqual({ total: 3200, fromAdvance: 2000, extra: 1200, left: 0 });
  });

  it("nothing left: every rupee is a reimbursement", () => {
    expect(splitBills([{ amount: 500, gst: 0 }], 0)).toEqual({ total: 500, fromAdvance: 0, extra: 500, left: 0 });
  });

  it("matches a person however the name was typed", () => {
    expect(samePerson("RAMESH  kumar", "Ramesh Kumar")).toBe(true);
    expect(samePerson("Ramesh", "Ramesh Kumar")).toBe(false);
    expect(samePerson("", "")).toBe(false);
  });

  it("open advances of a person, newest first; settled ones left out", () => {
    const list = [adv("a", "Ramesh Kumar", 100, "2026-09-01"), adv("b", "ramesh kumar", 50, "2026-10-01"),
      adv("c", "Ramesh Kumar", 0, "2026-10-05", "closed"), adv("d", "Suresh", 10, "2026-10-09")];
    expect(openAdvancesOf("Ramesh Kumar", list).map((a) => a.id)).toEqual(["b", "a"]);
  });

  // Owner example 3: ₹3,500 comes back by bank — the advance with exactly ₹3,500 left is picked.
  it("a return picks the advance with that exact balance, else one that can take it", () => {
    const list = [adv("a", "Ramesh Kumar", 5000, "2026-10-09"), adv("b", "Ramesh Kumar", 3500, "2026-09-01")];
    expect(advanceForReturn(3500, "Ramesh Kumar", list)?.id).toBe("b");
    expect(advanceForReturn(4000, "Ramesh Kumar", list)?.id).toBe("a");
    expect(advanceForReturn(9000, "Ramesh Kumar", list)).toBeNull();
  });

  it("bill row checks mirror the database", () => {
    const ok = { date: "2026-10-03", category: "Travel", amount: 2370, gst: 0 };
    expect(billProblem(ok)).toBeNull();
    expect(billProblem({ ...ok, date: "" })).toBe("date");
    expect(billProblem({ ...ok, category: " " })).toBe("category");
    expect(billProblem({ ...ok, amount: 0 })).toBe("amount");
    expect(billProblem({ ...ok, amount: 10.5 })).toBe("amount");
    expect(billProblem({ ...ok, gst: 2370 })).toBe("gst");
  });

  // R-1872 owner example: ₹10,000 given, ₹6,500 bills, ₹3,500 returned by bank → balance ₹0.
  it("register: given / spent / returned / balance from what settle wrote", () => {
    const rows = advanceRegister([
      { ...adv("a", "Ramesh Kumar", 0, "2026-10-01", "closed"), disbursed_amount: 6500, total_spent: 6500,
        notes: "Office expenses\nSettled on 09 Oct 2026 · ₹3500 returned" },
    ], "2026-10-24");
    expect(rows).toEqual([{ employee: "Ramesh Kumar", given: 10000, spent: 6500, returned: 3500, balance: 0, ageDays: null, advances: 1 }]);
  });

  it("register: part return, undo, and age of the oldest open money; > 30 days filter", () => {
    const rows = advanceRegister([
      { ...adv("a", "Suresh Pal", 500, "2026-09-10"), disbursed_amount: 500, total_spent: 0,
        notes: "Office expenses\nReturned ₹500 on 22 Oct 2026 · ₹500 still with them" },
      { ...adv("b", "SURESH PAL", 1000, "2026-10-20"), disbursed_amount: 1500, total_spent: 500,
        notes: "x\nSettled on 21 Oct 2026 · ₹700 returned\nReturn ₹700 undone (bank line un-reconciled)" },
      { ...adv("c", "Asha", 200, "2026-10-20"), disbursed_amount: 200, total_spent: 0, notes: null },
    ], "2026-10-24");
    expect(rows[0]).toEqual({ employee: "Suresh Pal", given: 2500, spent: 500, returned: 500, balance: 1500, ageDays: 44, advances: 2 });
    expect(rows.filter(isOverdueAdvance).map((r) => r.employee)).toEqual(["Suresh Pal"]);
    expect(registerCsvRows(rows)[1]).toEqual(["Asha", 200, 0, 0, 200, 4, 1]);
    expect(REGISTER_CSV_HEADERS).toHaveLength(registerCsvRows(rows)[0].length);
  });

  it("returned ignores lines it did not write", () => {
    expect(returnedFromNotes("Top-up ₹2000 on 12 Oct 2026\nReturned money soon")).toBe(0);
  });

  it("Balance Sheet line: open employee advances only", () => {
    expect(openEmployeeAdvanceTotal([adv("a", "R", 3500, "2026-10-01"), adv("b", "S", 900, "2026-10-01", "closed")])).toBe(3500);
  });

  it("reads typed rupees", () => {
    expect(parseRupees("4,130")).toBe(4130);
    expect(parseRupees("₹ 630")).toBe(630);
    expect(parseRupees("")).toBe(0);
    expect(parseRupees("12.5")).toBeNaN();
  });
});
