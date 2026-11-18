/**
 * R-2920 — one bank receipt across two or more loans given.
 * Owner's lines: +₹3,50,000 on 21 Feb 2026 from Kapil Dev (₹3,49,000 left on his ₹9,99,000 loan + a
 * separate ₹1,000 loan); +₹97,000 on 13 Feb from Rahul Chawla (₹90,000 + ₹7,000 loans). And the old
 * default: the first loan in the list ("Suman Rani") was pre-picked though the line names Kapil Dev.
 */
import { describe, expect, it } from "vitest";
import { matchLoanGivenReceipts, type LoanTerms, type RepaymentPart } from "./loans-given";
import {
  borrowerInNarration, defaultTicked, maxOnLoan, orderLoanChoices, receiptPlan, typedRupees, type SplitLoan,
} from "./loan-given-split";

const oneShot = (principal: number, givenOn: string, rate = 0): LoanTerms =>
  ({ principal, givenOn, interestRate: rate, plan: "one_shot", dueOn: null, instalments: null });
const loan = (id: string, name: string, terms: LoanTerms, parts: RepaymentPart[] = []): SplitLoan =>
  ({ id, borrower_name: name, given_on: terms.givenOn, terms, parts });

const suman = loan("suman", "suman rani", oneShot(200000, "2026-02-01"));
const kapilBig = loan("k-big", "Kapil Dev", oneShot(999000, "2025-12-15"),
  [{ repaidOn: "2026-01-10", amount: 650000, principalPart: 650000, interestPart: 0 }]);
const kapilSmall = loan("k-small", "Kapil Dev", oneShot(1000, "2026-01-05"));
const rahul90 = loan("r-90", "Rahul Chawla", oneShot(90000, "2025-11-01"));
const rahul7 = loan("r-7", "Rahul Chawla", oneShot(7000, "2026-01-20"));
const all = [suman, kapilSmall, kapilBig, rahul7, rahul90];

const choicesFor = (loans: SplitLoan[], credit: number, narration: string) =>
  orderLoanChoices(matchLoanGivenReceipts(loans.map((l) => ({
    id: l.id, borrowerName: l.borrower_name, status: "open", terms: l.terms,
    principalRepaid: l.parts.reduce((s, p) => s + p.principalPart, 0), receipts: l.parts.length,
  })), credit), loans, narration);

describe("R-2920 borrower named in the bank narration", () => {
  it("finds the name whatever the case, punctuation or joining", () => {
    expect(borrowerInNarration("Kapil Dev", "NEFT CR-HDFC0001234-KAPIL DEV-REF 998")).toBe(true);
    expect(borrowerInNarration("kapil  dev", "UPI/KAPILDEV@okaxis/Payment")).toBe(true);
    expect(borrowerInNarration("suman rani", "NEFT CR-HDFC0001234-KAPIL DEV-REF 998")).toBe(false);
  });
  it("a short name is not found inside a longer word; blanks never match", () => {
    expect(borrowerInNarration("Raj", "NEFT CR RAJESH TRADERS")).toBe(false);
    expect(borrowerInNarration("Raj", "NEFT CR RAJ 2201")).toBe(true);
    expect(borrowerInNarration("", "NEFT CR RAJ")).toBe(false);
    expect(borrowerInNarration("Kapil Dev", null)).toBe(false);
  });
});

describe("R-2920 the list and what is ticked first", () => {
  it("the borrower's own loans come first, oldest first; other people's after", () => {
    const c = choicesFor(all, 350000, "NEFT CR KAPIL DEV");
    expect(c.map((x) => x.loanId)).toEqual(["k-big", "k-small", "suman", "r-7", "r-90"]);
    expect(c.map((x) => x.named)).toEqual([true, true, false, false, false]);
  });
  it("Kapil Dev ₹3,50,000 → both his loans are ticked (₹3,49,000 + ₹1,000), never Suman Rani", () => {
    const c = choicesFor(all, 350000, "NEFT CR KAPIL DEV");
    expect(defaultTicked(c, all, "2026-02-21", 350000)).toEqual(["k-big", "k-small"]);
  });
  it("a line the first loan covers ticks only that loan", () => {
    const c = choicesFor(all, 50000, "NEFT CR KAPIL DEV");
    expect(defaultTicked(c, all, "2026-02-21", 50000)).toEqual(["k-big"]);
  });
  it("no borrower named in the line → nothing is ticked (was: the first loan in the list)", () => {
    const c = choicesFor(all, 350000, "CASH DEPOSIT BY SELF");
    expect(c[0].loanId).toBe("suman");
    expect(defaultTicked(c, all, "2026-02-21", 350000)).toEqual([]);
  });
  it("an exact next EMI receipt is still picked alone (R-2340)", () => {
    const emi = loan("vinod", "Vinod Hem Raj",
      { principal: 350000, givenOn: "2026-09-05", interestRate: 12, plan: "emi", dueOn: "2026-10-05", instalments: 24, emi: 16476 });
    const loans = [suman, emi];
    const c = choicesFor(loans, 16476, "CASH DEPOSIT");
    expect(c[0]).toMatchObject({ loanId: "vinod", confidence: "exact" });
    expect(defaultTicked(c, loans, "2026-10-05", 16476)).toEqual(["vinod"]);
  });
});

describe("R-2920 amounts of the ticked loans", () => {
  it("Kapil Dev: ₹3,49,000 + ₹1,000 = the ₹3,50,000 line, both loans cleared, Save on", () => {
    const p = receiptPlan([kapilSmall, kapilBig], {}, "2026-02-21", 350000);
    expect(p.parts.map((x) => [x.loanId, x.amount, x.principalPart, x.closes])).toEqual([
      ["k-small", 1000, 1000, true], ["k-big", 349000, 349000, true],
    ]);
    expect(p).toMatchObject({ total: 350000, difference: 0, tallies: true, canSave: true });
  });
  it("Rahul Chawla: ₹90,000 + ₹7,000 = the ₹97,000 line", () => {
    const p = receiptPlan([rahul90, rahul7], {}, "2026-02-13", 97000);
    expect(p.parts.map((x) => x.amount)).toEqual([90000, 7000]);
    expect(p.canSave).toBe(true);
  });
  it("oldest loan is filled first; a line smaller than what is owed leaves the newer loan part-paid", () => {
    const p = receiptPlan([rahul7, rahul90], {}, "2026-02-13", 93000);
    expect(p.parts.map((x) => [x.loanId, x.amount, x.closes])).toEqual([["r-7", 3000, false], ["r-90", 90000, true]]);
    expect(p.canSave).toBe(true);
  });
  it("the loans owe less than the line → ₹ still to place, Save off", () => {
    const p = receiptPlan([rahul90, rahul7], {}, "2026-02-13", 100000);
    expect(p).toMatchObject({ total: 97000, difference: -3000, tallies: false, canSave: false });
  });
  it("a typed amount is kept and the rest goes to the other loan", () => {
    const p = receiptPlan([kapilBig, kapilSmall], { "k-big": 349500 }, "2026-02-21", 350000);
    expect(p.parts.map((x) => x.amount)).toEqual([349500, 500]);
    expect(p.parts[0]).toMatchObject({ tooMuch: true, maxAmount: 349000 });
    expect(p.tallies).toBe(true);
    expect(p.canSave).toBe(false);   // more than is owed on the first loan
  });
  it("typed amounts that do not add up, or a ₹0 part, keep Save off", () => {
    expect(receiptPlan([kapilBig, kapilSmall], { "k-big": 300000, "k-small": 1000 }, "2026-02-21", 350000))
      .toMatchObject({ total: 301000, difference: -49000, canSave: false });
    expect(receiptPlan([kapilBig, kapilSmall], { "k-big": 349000, "k-small": 2000 }, "2026-02-21", 350000))
      .toMatchObject({ difference: 1000, canSave: false });
    const zero = receiptPlan([kapilBig, kapilSmall, suman], { "k-big": 349000, "k-small": 1000 }, "2026-02-21", 350000);
    expect(zero.tallies).toBe(true);
    expect(zero.canSave).toBe(false);   // Suman Rani is ticked with ₹0
  });
  it("one ticked loan takes the whole line — more than is owed is said, as before", () => {
    const p = receiptPlan([kapilBig], {}, "2026-02-21", 350000);
    expect(p.parts[0]).toMatchObject({ amount: 350000, tooMuch: true, maxAmount: 349000 });
    expect(p.canSave).toBe(false);
    expect(receiptPlan([kapilBig], {}, "2026-02-21", 349000).canSave).toBe(true);
    expect(receiptPlan([], {}, "2026-02-21", 349000).canSave).toBe(false);
  });
  it("each part splits by its own loan's rule: EMI interest by the server's rule (not sent), simple interest sent", () => {
    const emi = loan("emi", "Rahul Chawla",
      { principal: 100000, givenOn: "2026-01-13", interestRate: 12, plan: "emi", dueOn: "2026-02-13", instalments: 12, emi: 10000 });
    const tenPct = loan("ten", "Rahul Chawla", oneShot(50000, "2026-01-01", 10));
    // 10% on ₹50,000 for 43 days = ₹589.04 → ₹589 interest due on 13 Feb.
    expect(maxOnLoan(tenPct, "2026-02-13")).toBe(50589);
    const p = receiptPlan([emi, tenPct], { emi: 10000, ten: 6200 }, "2026-02-13", 16200);
    expect(p.parts[0]).toMatchObject({ principalPart: 9000, interestPart: 1000, interestForRpc: null });
    expect(p.parts[1]).toMatchObject({ principalPart: 5611, interestPart: 589, interestForRpc: 589 });
    expect(p.canSave).toBe(true);
  });
});

describe("R-2920 typed rupees", () => {
  it("blank / junk / negative = not typed", () => {
    expect(typedRupees("")).toBeNull();
    expect(typedRupees(undefined)).toBeNull();
    expect(typedRupees("abc")).toBeNull();
    expect(typedRupees("-5")).toBeNull();
    expect(typedRupees("349000")).toBe(349000);
    expect(typedRupees("0")).toBe(0);
  });
});

describe("R-2921 paise are refused, never rounded", () => {
  it("a decimal amount is not a whole-rupee amount", () => {
    expect(typedRupees("100.5")).toBeNull();
    expect(typedRupees("349000.49")).toBeNull();
    expect(typedRupees("0.4")).toBeNull();
    expect(typedRupees("1e3")).toBe(1000);
    expect(typedRupees("1000.0")).toBe(1000);
    expect(typedRupees(" 250 ")).toBe(250);
  });
});
