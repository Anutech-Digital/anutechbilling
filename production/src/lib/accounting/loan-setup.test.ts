/**
 * R-2323 — "Set up this loan" from an EMI line on the bank statement (owner's case, staging
 * 31 Oct: Bike EMI ₹19,054 every month, nothing in Accounting › Loans to match it to).
 *
 * Owner example: the bike loan still owes ₹2,50,000 before this EMI, 11% a year, 14 EMIs left,
 * the bank takes ₹19,054 (the standard EMI works out to ₹19,109 — the bank's own figure is kept).
 */
import { describe, expect, it } from "vitest";
import { scheduleTotals } from "./emi-schedule";
import { guessLender, isLoanOnly, loanSetupErrors, loanSetupPayload, loanSetupSchedule, type LoanSetupInput } from "./loan-setup";

const bike = (over: Partial<LoanSetupInput> = {}): LoanSetupInput => ({
  lender: "HDFC Bank", principal: 250000, annualRatePct: 11, emi: 19054, months: 14,
  firstDueOn: "2026-10-05", receivedInto: null, ...over,
});

describe("loanSetupSchedule — standard reducing balance, the bank's EMI kept", () => {
  it("bank EMI ₹19,054 differs from the computed ₹19,109: the bank's is used, interest from the balance each month", () => {
    const s = loanSetupSchedule(bike());
    expect(s.computedEmi).toBe(19109);
    expect(s.bankEmiDiffers).toBe(true);
    expect(s.rows).toHaveLength(14);
    // Month 1: 11%/12 of ₹2,50,000 = ₹2,292 interest; the rest of the EMI reduces the loan.
    expect(s.rows[0]).toEqual({ seq: 1, dueOn: "2026-10-05", emi: 19054, principal: 16762, interest: 2292, balanceAfter: 233238 });
    // Month 2: interest on what is left (₹2,33,238), not on the original amount.
    expect(s.rows[1]).toMatchObject({ dueOn: "2026-11-05", interest: 2138, principal: 16916, balanceAfter: 216322 });
    for (const r of s.rows.slice(0, 13)) expect(r.emi).toBe(19054);
    // The last EMI clears exactly what is left.
    expect(s.rows[13].balanceAfter).toBe(0);
    expect(scheduleTotals(s.rows).principal).toBe(250000);
    expect(s.totalInterest).toBe(scheduleTotals(s.rows).interest);
  });

  it("no EMI typed → the standard EMI", () => {
    const s = loanSetupSchedule(bike({ emi: null }));
    expect(s.bankEmiDiffers).toBe(false);
    expect(s.rows[0].emi).toBe(19109);
  });

  it("an EMI that does not cover the month's interest is an error, not a schedule", () => {
    const s = loanSetupSchedule(bike({ emi: 2000 }));
    expect(s.rows).toEqual([]);
    expect(s.error).toMatch(/does not cover the month's interest/);
  });
});

describe("loanSetupErrors — ask only what the loan needs", () => {
  it("a complete loan has no errors", () => {
    expect(loanSetupErrors(bike())).toEqual([]);
  });
  it("lender, amount, EMIs and first EMI date are required", () => {
    expect(loanSetupErrors(bike({ lender: " ", principal: 0, months: 0, firstDueOn: "" }))).toEqual([
      "Enter the lender (bank / NBFC)", "Enter the amount still owed", "Enter how many EMIs are left", "Enter the first EMI date",
    ]);
  });
  it("money received into an account needs the date, on or before the first EMI", () => {
    expect(loanSetupErrors(bike({ receivedInto: { accountId: "a1", receivedOn: "" } }))).toEqual(["Enter the date the loan money came in"]);
    expect(loanSetupErrors(bike({ receivedInto: { accountId: "a1", receivedOn: "2026-11-01" } }))).toEqual(["The loan money must come in on or before the first EMI"]);
  });
});

describe("loanSetupPayload — what record_emi_loan_taken gets", () => {
  it("taken before these books: no account; this bank line is reconciled as EMI 1", () => {
    const s = loanSetupSchedule(bike());
    const p = loanSetupPayload(bike({ lenderRef: " LAN 77 " }), s.rows, "txn-1");
    expect(p).toMatchObject({
      lender: "HDFC Bank", lender_ref: "LAN 77", principal: 250000, interest_rate: 11,
      account_id: null, received_on: null, reconcile_txn_id: "txn-1",
    });
    expect(p.schedule[0]).toEqual({ seq: 1, due_on: "2026-10-05", emi: 19054, principal: 16762, interest: 2292, balance_after: 233238 });
  });
  it("money came into a bank account: account + date sent", () => {
    const p = loanSetupPayload(bike({ receivedInto: { accountId: "acc-9", receivedOn: "2026-09-05" } }), [], null);
    expect(p).toMatchObject({ account_id: "acc-9", received_on: "2026-09-05", reconcile_txn_id: null });
  });
});

describe("isLoanOnly — a loan is not an asset", () => {
  it("kind 'loan' rows are loans; older rows (no kind) are assets bought on EMI", () => {
    expect(isLoanOnly({ kind: "loan" })).toBe(true);
    expect(isLoanOnly({ kind: "asset" })).toBe(false);
    expect(isLoanOnly({})).toBe(false);
  });
});

describe("guessLender — the narration's lender as the default", () => {
  it("names the lender the staging lines show", () => {
    expect(guessLender("NACH DR BAJAJ FINANCE LTD 4455")).toBe("Bajaj Finance");
    expect(guessLender("ECS/TATA CAPITAL FIN SERV")).toBe("Tata Capital");
    expect(guessLender("SI SBI CAR LOAN")).toBe("State Bank of India");
    expect(guessLender("Bike EMI")).toBe("");
    expect(guessLender(null)).toBe("");
  });
});
