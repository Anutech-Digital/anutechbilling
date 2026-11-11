/* R-2655 (11 Nov 2026, G-RECON N6): the counts and words of "Match Zoho expenses". The pairing rules
   themselves: supabase/tests/r2655_zoho_expense_bank_match.test.sql. */
import { describe, expect, it } from "vitest";

import {
  zohoMatchBreakdown, zohoMatchDocLabel, zohoMatchHeadline, zohoMatchLineHref, zohoMatchSummary, type ZohoMatchRow,
} from "./zoho-expense-match";

const row = (p: Partial<ZohoMatchRow>): ZohoMatchRow => ({
  status: "sure", reason: "Same amount, paid from this account, 2 day(s) apart, the only open debit and the only Zoho document that fit.",
  zoho_doc_id: "expenses:Z1", vendor_id: "v1", vendor_name: "Amazon Retail", bill_no: "AMZ-1", categories: "Office Supplies, Software",
  doc_date: "2026-10-01", paid_on: "2026-10-01", cash: 6800, parts: 2, expense_ids: ["EXP-Z-1-1", "EXP-Z-1-2"], reference: null,
  account_id: "acc-1", account: "HDFC 4523", txn_id: "t1", txn_date: "2026-10-03", txn_description: "POS AMZN", ...p,
});

describe("R-2655 zohoMatchSummary", () => {
  it("counts documents, not rows: an ambiguous document with two possible lines is one to look at", () => {
    const s = zohoMatchSummary([
      row({}),
      row({ zoho_doc_id: "bills:Z2", cash: 10800 }),
      row({ zoho_doc_id: "expenses:Z4A", status: "ambiguous", txn_id: "t5", cash: 500 }),
      row({ zoho_doc_id: "expenses:Z4A", status: "ambiguous", txn_id: "t6", cash: 500 }),
      row({ zoho_doc_id: "expenses:Z6", status: "booked_elsewhere", cash: 2500 }),
      row({ zoho_doc_id: "expenses:Z8", status: "no_line", txn_id: null, cash: 8000 }),
      row({ zoho_doc_id: "expenses:Z7", status: "locked", cash: 3000 }),
      row({ zoho_doc_id: "expenses:Z3", status: "look", cash: 999 }),
    ]);
    expect(s.sure).toBe(2);
    expect(s.sureAmount).toBe(17600);
    expect(s.look).toBe(5);
    expect(s.byStatus).toEqual({ ambiguous: 1, look: 1, booked_elsewhere: 1, locked: 1, no_line: 1 });
    expect(zohoMatchHeadline(s)).toBe("2 clean matches · 5 need a look");
    expect(zohoMatchBreakdown(s)).toBe(
      "1 with the debit already booked as something else · 1 with more than one match · 1 to check by hand · 1 with no bank line · 1 in locked books");
  });

  it("singular words", () => {
    const s = zohoMatchSummary([row({}), row({ zoho_doc_id: "expenses:Z8", status: "no_line", txn_id: null })]);
    expect(zohoMatchHeadline(s)).toBe("1 clean match · 1 needs a look");
    expect(zohoMatchBreakdown(s)).toBe("1 with no bank line");
  });

  it("nothing → zeros and no breakdown", () => {
    const s = zohoMatchSummary([]);
    expect(zohoMatchHeadline(s)).toBe("0 clean matches · 0 need a look");
    expect(zohoMatchBreakdown(s)).toBe("");
  });
});

describe("R-2655 row helpers", () => {
  it("links a row to its bank line on the account page; no line → no link", () => {
    expect(zohoMatchLineHref(row({}))).toBe("/accounting/banking/acc-1?txn=t1");
    expect(zohoMatchLineHref(row({ txn_id: null }))).toBeNull();
  });

  it("labels a document by vendor + bill, a vendor-less Zoho expense by its category", () => {
    expect(zohoMatchDocLabel(row({}))).toBe("Amazon Retail · AMZ-1");
    expect(zohoMatchDocLabel(row({ vendor_name: null, bill_no: null }))).toBe("Office Supplies, Software");
    expect(zohoMatchDocLabel(row({ vendor_name: " ", bill_no: "", categories: null }))).toBe("Zoho expense");
  });
});
