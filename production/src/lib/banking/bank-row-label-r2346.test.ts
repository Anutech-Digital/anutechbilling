/* R-2346: a bank line matched to a LOAN GIVEN (matched_to_type 'loan_given' — an R-2340 receipt or
   disbursal, or a repayment from the Loans given page's Record repayment) reads "Loan given" on the
   bank page and in the CSV, and sits in the "Loan / EMI" filter group — it used to read "Reconciled". */
import { describe, expect, it } from "vitest";
import { bankRowStatusLabel } from "./bank-row-label";
import { applyBankFilters, DEFAULT_FILTERS, lineStatusLabel, matchGroupOf, bankLinesCsv } from "./bank-filters";

describe("R-2346 loan_given bank lines", () => {
  it("the row badge reads Loan given (receipt and disbursal alike)", () => {
    expect(bankRowStatusLabel("loan_given" as never, false)).toBe("Loan given");
    expect(bankRowStatusLabel("loan_given" as never, true)).toBe("Loan given");
  });
  it("is grouped with Loans", () => {
    expect(matchGroupOf("loan_given")).toBe("loan");
  });
  it("the status word (and the CSV) says Loan given, not Loan / EMI", () => {
    expect(lineStatusLabel("loan_given")).toBe("Loan given");
    expect(lineStatusLabel("emi")).toBe("Loan / EMI");
    const line = { id: "a", txn_date: "2026-10-05", description: "NEFT CR VINOD", reference: null, debit: 0, credit: 16476, balance_after: null, matched_to_type: "loan_given" };
    expect(bankLinesCsv([line]).rows[0][5]).toBe("Loan given");
  });
  it("the Loan / EMI filter finds a loan given receipt and a disbursal", () => {
    const lines = [
      { id: "in",  txn_date: "2026-10-05", description: "NEFT CR VINOD", reference: null, debit: 0, credit: 16476, balance_after: null, matched_to_type: "loan_given" },
      { id: "out", txn_date: "2026-09-01", description: "RTGS DR VINOD", reference: null, debit: 350000, credit: 0, balance_after: null, matched_to_type: "loan_given" },
      { id: "x",   txn_date: "2026-10-06", description: "Office rent", reference: null, debit: 5000, credit: 0, balance_after: null, matched_to_type: "expense" },
    ];
    expect(applyBankFilters(lines, { ...DEFAULT_FILTERS, types: ["loan"] }).map((l) => l.id).sort()).toEqual(["in", "out"]);
  });
});
