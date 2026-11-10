/* R-2378 — a bank line booked through Loan / EMI → "Loan / advance with a person" (book_bank_advance) is
   stored as matched_to_type 'manual'; the line must read as its booking + party, never "Reconciled". */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { bsItemParty, lineBookingMap, lineBookingOf, lineBookingText, typedParty, type LineBookingRow } from "./line-booking";
import { applyBankFilters, bankLinesCsv, DEFAULT_FILTERS, facetCounts, lineGroupOf, type FilterLine } from "./bank-filters";
import { bankRowStatusLabel } from "./bank-row-label";

const row = (over: Partial<LineBookingRow>): LineBookingRow => ({ txn_id: "t1", source: "bs_item", sub: "liability", party: null, amount: 0, ...over });

describe("R-2378 lineBookingOf — the owner's audit lines", () => {
  it("Bajaj credit booked as 'Loan received' reads Loan received · Bajaj Finance, linking to the Balance Sheet", () => {
    const b = lineBookingOf(row({ party: "Loan received · Bajaj Finance", amount: 500000 }));
    expect(b).toMatchObject({ label: "Loan received", party: "Bajaj Finance", href: "/accounting/balance-sheet", group: "loan" });
    expect(lineBookingText(b)).toBe("Loan received · Bajaj Finance");
  });
  it("Tata EMI debit booked as 'received' kind reads Loan repaid · Tata Capital", () => {
    expect(lineBookingText(lineBookingOf(row({ party: "Loan repaid · Tata Capital", amount: -25000 })))).toBe("Loan repaid · Tata Capital");
  });
  it("advance given / returned (asset side)", () => {
    expect(lineBookingText(lineBookingOf(row({ sub: "asset", party: "Advance/loan given · Ravi", amount: 10000 })))).toBe("Advance given · Ravi");
    expect(lineBookingText(lineBookingOf(row({ sub: "asset", party: "Advance/loan returned · Ravi", amount: -10000 })))).toBe("Advance returned · Ravi");
  });
  it("book_bank_credit: director's loan with a typed label, owner's capital with the default label", () => {
    expect(lineBookingText(lineBookingOf(row({ party: "Loan from Pardeep", amount: 300000 })))).toBe("Loan received · Pardeep");
    expect(lineBookingText(lineBookingOf(row({ party: "Loan received from HDFC", amount: 300000 })))).toBe("Loan received · HDFC");
    expect(lineBookingText(lineBookingOf(row({ party: "HDFC OD", amount: 300000 })))).toBe("Loan received · HDFC OD");
    const cap = lineBookingOf(row({ sub: "equity", party: "Owner's capital", amount: 100000 }));
    expect(cap).toMatchObject({ label: "Owner's capital", party: null, group: "owner" });
  });
  it("typedParty drops the kind words a typed label repeats", () => {
    expect(typedParty("Director's loan from Pardeep", "Loan received")).toBe("Pardeep");
    expect(typedParty("Loan", "Loan received")).toBeNull();
    expect(typedParty("Bajaj Finance", "Loan received")).toBe("Bajaj Finance");
  });
  it("bsItemParty strips only the RPC's own prefixes", () => {
    expect(bsItemParty("Loan received")).toBeNull();
    expect(bsItemParty("Director's loan")).toBeNull();
    expect(bsItemParty("  ")).toBeNull();
    expect(bsItemParty("HDFC OD")).toBe("HDFC OD");
  });
  it("every other source the server returns names its booking and its page", () => {
    const cases: [Partial<LineBookingRow>, string, string][] = [
      [{ source: "employee_loan", sub: "loan", party: "Asha" }, "Staff loan given · Asha", "/accounting/loans"],
      [{ source: "employee_loan", sub: "salary_advance", party: "Asha" }, "Salary advance given · Asha", "/accounting/loans"],
      [{ source: "employee_loan", sub: "expense_advance", party: "Asha" }, "Expense advance given · Asha", "/accounting/advances"],
      [{ source: "loan_given", party: "Kumar" }, "Loan given · Kumar", "/accounting/loans-given"],
      [{ source: "loan_given_repayment", party: "Kumar" }, "Loan repayment received · Kumar", "/accounting/loans-given"],
      [{ source: "business_loan", sub: "term", party: "HDFC" }, "Loan received · HDFC", "/accounting/business-loans"],
      [{ source: "business_loan_payment", party: "HDFC" }, "Loan repayment · HDFC", "/accounting/business-loans"],
      [{ source: "business_loan_drawdown", party: "HDFC" }, "Credit line drawdown · HDFC", "/accounting/business-loans"],
      [{ source: "emi_payment", sub: "emi", party: "Bajaj Finance" }, "EMI paid · Bajaj Finance", "/accounting/assets"],
      [{ source: "emi_down_payment", party: "Thar" }, "Down payment · Thar", "/accounting/assets"],
      [{ source: "emi_loan_received", party: "Bajaj Finance" }, "Loan received · Bajaj Finance", "/accounting/assets"],
      [{ source: "staff_advance", sub: "owed_back", party: "Asha" }, "Owed back by staff · Asha", "/accounting/reimbursements"],
      [{ source: "employee_loan_reversal", party: "Asha" }, "Staff loan reversed · Asha", "/accounting/loans"],
      [{ source: "employee_loan_repayment", party: "Asha" }, "Staff loan repaid · Asha", "/accounting/loans"],
      [{ source: "employee_advance_returned", party: "Asha" }, "Advance returned · Asha", "/accounting/advances"],
      [{ source: "staff_advance", sub: "reimburse", party: "Asha" }, "Reimbursement paid · Asha", "/accounting/reimbursements"],
      [{ source: "statutory", sub: "tds", party: "12345" }, "TDS paid · Challan 12345", "/accounting/salary-register"],
    ];
    for (const [r, text, href] of cases) {
      const b = lineBookingOf(row(r));
      expect(lineBookingText(b)).toBe(text);
      expect(b.href).toBe(href);
      expect(b.label).not.toMatch(/manual|reconciled/i);
    }
  });
});

describe("R-2378 bank line list — filters, CSV, badge", () => {
  const lines: FilterLine[] = [
    { id: "bajaj", txn_date: "2026-10-01", description: "NEFT BAJAJ FINANCE", reference: null, debit: 0, credit: 500000, balance_after: null, matched_to_type: "manual" },
    { id: "plain", txn_date: "2026-10-02", description: "RTGS FAILED", reference: null, debit: 0, credit: 7000, balance_after: null, matched_to_type: "manual" },
  ];
  const bookings = lineBookingMap([row({ txn_id: "bajaj", party: "Loan received · Bajaj Finance", amount: 500000 })]);

  it("a booked manual line is in the Loan / EMI group; a real manual one stays Other", () => {
    expect(lineGroupOf(lines[0], bookings)).toBe("loan");
    expect(lineGroupOf(lines[1], bookings)).toBe("other");
    expect(applyBankFilters(lines, { ...DEFAULT_FILTERS, types: ["loan"] }, { bookings }).map((t) => t.id)).toEqual(["bajaj"]);
    expect(facetCounts(lines, DEFAULT_FILTERS, { bookings }).types).toMatchObject({ loan: 1, other: 1 });
  });
  it("the CSV Status says the booking", () => {
    const { rows } = bankLinesCsv(lines, bookings);
    expect(rows.find((r) => r[1] === "NEFT BAJAJ FINANCE")?.[5]).toBe("Loan received · Bajaj Finance");
    expect(rows.find((r) => r[1] === "RTGS FAILED")?.[5]).toBe("Reconciled");
  });
  it("search finds a booked line by its party", () => {
    expect(applyBankFilters(lines, { ...DEFAULT_FILTERS, q: "bajaj fin" }, { bookings }).map((t) => t.id)).toEqual(["bajaj"]);
    expect(applyBankFilters([{ ...lines[0], description: "ACH DR 0045123" }], { ...DEFAULT_FILTERS, q: "bajaj" }, { bookings }).map((t) => t.id)).toEqual(["bajaj"]);
  });
  it("badge and CSV say the same words for every type", () => {
    for (const t of ["other_income", "referral_commission", "emi", "statutory", "prepaid", "project", "salary", "vendor_payment"]) {
      const csv = bankLinesCsv([{ ...lines[1], matched_to_type: t }]).rows[0][5];
      expect(bankRowStatusLabel(t as never, false)).toBe(csv);
    }
  });
  it("badge words for every type the app writes — only 'manual' falls back to Reconciled", () => {
    const named = ["payment", "expense", "vendor_bill", "transfer", "split", "owner_equity", "customer_refund", "loan_given", "business_loan",
      "loan_drawdown", "loan_repayment", "emi", "other_income", "statutory", "prepaid", "project", "salary", "vendor_payment", "referral_commission"];
    for (const t of named) expect(bankRowStatusLabel(t as never, false)).not.toBe("Reconciled");
    expect(bankRowStatusLabel("manual", false)).toBe("Reconciled");
  });
});
