/* R-1895 — Salary register → the bank line that paid the salary. Owner's example (staging,
   25 Oct): Sajan Singh Negi, Apr 2026 salary ₹1,05,000 paid 21 May 2026, Sep 2026 "Not paid yet". */
import { describe, expect, it } from "vitest";
import { resolveSalaryBankLines, salaryBankLink, bankLineHref, type SalaryLinkFacts, type BankLineFacts } from "./salary-bank-link";

const ACCT = "acct-hdfc";
const apr: SalaryLinkFacts = { id: "sal-apr", net: 105000, paid_amount: 105000, paid_status: "paid", reconciled_txn_id: "txn-21may", expense_id: "exp-apr" };
const sep: SalaryLinkFacts = { id: "sal-sep", net: 94080, paid_amount: 0, paid_status: "unpaid", reconciled_txn_id: null, expense_id: "exp-sep" };
const lines: BankLineFacts[] = [
  { id: "txn-21may", bank_account_id: ACCT, txn_date: "2026-05-21", matched_to_type: "salary", matched_to_id: "sal-apr" },
];

describe("R-1895 salary → bank line", () => {
  it("Apr 2026 (Paid, linked) opens the 21 May 2026 bank line on its account", () => {
    const byId = resolveSalaryBankLines([apr, sep], lines);
    const link = salaryBankLink(apr, byId.get(apr.id));
    expect(link).toEqual({ kind: "open", href: `/accounting/banking/${ACCT}?txn=txn-21may` });
  });

  it("Sep 2026 (Not paid yet) gets no link and no 'Not matched'", () => {
    const byId = resolveSalaryBankLines([apr, sep], lines);
    expect(byId.has(sep.id)).toBe(false);
    expect(salaryBankLink(sep, byId.get(sep.id))).toEqual({ kind: "none" });
  });

  it("Paid with no bank line anywhere → 'Not matched to bank' with Match into the bank reconcile", () => {
    const orphan: SalaryLinkFacts = { ...apr, id: "sal-old", reconciled_txn_id: null, expense_id: null };
    expect(salaryBankLink(orphan, undefined, ACCT)).toEqual({ kind: "not_matched", matchHref: `/accounting/banking/${ACCT}?match=105000` });
    // No waiting line of that amount → the Banking accounts list (pick the account, reconcile there).
    expect(salaryBankLink(orphan, undefined)).toEqual({ kind: "not_matched", matchHref: "/accounting/banking" });
  });

  it("no reconciled_txn_id but a line matched to the salary (or its expense) still opens that line", () => {
    const viaSalary: SalaryLinkFacts = { ...apr, reconciled_txn_id: null };
    const viaExpense: SalaryLinkFacts = { ...apr, id: "sal-may", reconciled_txn_id: null, expense_id: "exp-may" };
    const more: BankLineFacts[] = [
      { id: "t-old", bank_account_id: ACCT, txn_date: "2026-05-01", matched_to_type: "salary", matched_to_id: "sal-apr" },
      { id: "t-new", bank_account_id: ACCT, txn_date: "2026-05-21", matched_to_type: "salary", matched_to_id: "sal-apr" },
      { id: "t-exp", bank_account_id: "acct-icici", txn_date: "2026-06-20", matched_to_type: "expense", matched_to_id: "exp-may" },
    ];
    const byId = resolveSalaryBankLines([viaSalary, viaExpense], more);
    expect(byId.get("sal-apr")).toEqual({ txnId: "t-new", accountId: ACCT });
    expect(byId.get("sal-may")).toEqual({ txnId: "t-exp", accountId: "acct-icici" });
  });

  it("a partly-paid salary with a linked line opens it too (never 'Not matched')", () => {
    const part: SalaryLinkFacts = { ...apr, paid_amount: 50000, paid_status: "partial", reconciled_txn_id: null };
    const byId = resolveSalaryBankLines([part], [{ ...lines[0], id: "t-part" }]);
    expect(salaryBankLink(part, byId.get(part.id))).toEqual({ kind: "open", href: `/accounting/banking/${ACCT}?txn=t-part` });
  });

  it("href is the bank account page with ?txn=", () => {
    expect(bankLineHref({ txnId: "x", accountId: "y" })).toBe("/accounting/banking/y?txn=x");
  });
});
