// @vitest-environment jsdom
/* R-2655 (11 Nov 2026, G-RECON N6): Banking → "Match Zoho expenses" shows the server's preview —
   "N clean matches · M need a look", each row with its reason and a link to its bank line. Part 1
   books nothing: there is no Book button. The pairing rules themselves:
   supabase/tests/r2655_zoho_expense_bank_match.test.sql. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { ZohoMatchRow } from "@/lib/banking/zoho-expense-match";

const s = vi.hoisted(() => ({ rows: [] as unknown[], error: null as Error | null }));
vi.mock("@/lib/queries/zoho-expense-match", () => ({
  useZohoExpenseMatches: () => ({ data: s.error ? undefined : s.rows, isLoading: false, isError: !!s.error, error: s.error, refetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { ZohoExpenseMatchSheet } from "./zoho-expense-match";

const row = (p: Partial<ZohoMatchRow>): ZohoMatchRow => ({
  status: "sure", reason: "Same amount, paid from this account, 2 day(s) apart, the only open debit and the only Zoho document that fit.",
  zoho_doc_id: "expenses:Z1", vendor_id: "v1", vendor_name: "Amazon Retail", bill_no: "AMZ-1", categories: "Office Supplies, Software",
  doc_date: "2026-10-01", paid_on: "2026-10-01", cash: 6800, parts: 2, expense_ids: ["EXP-Z-1-1", "EXP-Z-1-2"], reference: null,
  account_id: "acc-1", account: "HDFC 4523", txn_id: "t1", txn_date: "2026-10-03", txn_description: "POS 416021XXXXXX1234 AMZN", ...p,
});

afterEach(() => { cleanup(); s.rows = []; s.error = null; });

describe("R-2655 Match Zoho expenses (preview)", () => {
  it("shows N clean matches · M need a look, each with its reason and a link to the bank line — and no Book button", () => {
    s.rows = [
      row({}),
      row({ zoho_doc_id: "expenses:Z4A", status: "ambiguous", txn_id: "t5", cash: 500, vendor_name: "Amazon Retail", bill_no: "AMZ-4A", parts: 1,
            reason: "2 documents / debits of this amount could pair here — nothing is matched when there is more than one. Match it on the bank line." }),
      row({ zoho_doc_id: "expenses:Z4A", status: "ambiguous", txn_id: "t6", cash: 500, vendor_name: "Amazon Retail", bill_no: "AMZ-4A", parts: 1,
            reason: "2 documents / debits of this amount could pair here — nothing is matched when there is more than one. Match it on the bank line." }),
      row({ zoho_doc_id: "expenses:Z6", status: "booked_elsewhere", txn_id: "t10", cash: 2500, bill_no: "AMZ-6", parts: 1,
            reason: "A debit of the same amount on 19 Oct 2026 is already reconciled as expense. If that is this payment, the expense is in the books twice — check it." }),
      row({ zoho_doc_id: "expenses:Z8", status: "no_line", txn_id: null, txn_date: null, txn_description: null, cash: 8000, vendor_name: null, bill_no: null, categories: "Rent", parts: 1,
            reason: "No open debit of this amount within 7 days of 01 Oct 2026 in this account — is the statement imported up to that date?" }),
    ];
    render(<ZohoExpenseMatchSheet open onOpenChange={() => {}} />);

    expect(screen.getByText("1 clean match · 3 need a look (₹6,800 clean)")).toBeTruthy();
    expect(screen.getByText("1 with the debit already booked as something else · 1 with more than one match · 1 with no bank line")).toBeTruthy();

    const clean = screen.getByRole("region", { name: "Clean matches" });
    expect(within(clean).getAllByRole("row")).toHaveLength(2);   // header + 1
    expect(within(clean).getByText("Amazon Retail · AMZ-1")).toBeTruthy();
    expect(within(clean).getByText(/Paid .* · HDFC 4523 · 2 parts/)).toBeTruthy();
    expect(within(clean).getByText(/the only open debit and the only Zoho document that fit/)).toBeTruthy();
    expect(within(clean).getByRole("link", { name: "Open the bank line for Amazon Retail · AMZ-1" }).getAttribute("href"))
      .toBe("/accounting/banking/acc-1?txn=t1");

    const review = screen.getByRole("region", { name: "Need a look" });
    expect(within(review).getAllByRole("row")).toHaveLength(5);  // header + 4 (the ambiguous document twice)
    expect(within(review).getByText("Debit already booked")).toBeTruthy();
    expect(within(review).getByText(/in the books twice/)).toBeTruthy();
    expect(within(review).getAllByText("More than one match")).toHaveLength(2);
    expect(within(review).getByText("Rent")).toBeTruthy();          // a vendor-less Zoho expense: its category
    expect(within(review).getByText("No bank line")).toBeTruthy();
    expect(within(review).getAllByRole("link")).toHaveLength(3);    // no line → no link

    // Part 1 is read only: nothing on the sheet books or undoes.
    expect(screen.queryByRole("button", { name: /book|undo|match all/i })).toBeNull();
  });

  it("nothing waiting → says so", () => {
    render(<ZohoExpenseMatchSheet open onOpenChange={() => {}} />);
    expect(screen.getByText(/No imported Zoho expense is waiting for its bank line/)).toBeTruthy();
  });

  it("a refused login (not owner / accountant) sees the server's message, not an empty list", () => {
    s.error = new Error("Only an owner or accountant can match imported Zoho expenses to bank lines");
    render(<ZohoExpenseMatchSheet open onOpenChange={() => {}} />);
    expect(screen.queryByText(/No imported Zoho expense is waiting/)).toBeNull();
    expect(screen.getByText(/Zoho expense matches/)).toBeTruthy();
  });
});
