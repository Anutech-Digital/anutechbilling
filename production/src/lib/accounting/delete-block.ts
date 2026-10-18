/**
 * R-1577 — a delete the database refused, turned into the button that fixes it (CLAUDE.md §24).
 *
 * delete_expense / delete_vendor_bill (migration 20261018180436_r1577_delete_expense_bill_links)
 * refuse when a salary, EMI, loan, tax challan, reimbursement, claim, fixed asset, open payment
 * run or a matched bank line hangs off the row. The message says what to do; the error's HINT
 * carries the app page where it is done. Only known Accounting pages become a button — the hint
 * comes from the database, and a link must never go anywhere else.
 */

const PAGE_LABELS: Record<string, string> = {
  "/accounting/payroll":        "Open Payroll",
  "/accounting/assets":         "Open Assets & EMIs",
  "/accounting/business-loans": "Open Business Loans",
  "/accounting/loans":          "Open Loans & Advances",
  "/accounting/banking":        "Open Banking",
  "/accounting/reimbursements": "Open Reimbursements",
  "/accounting/payment-runs":   "Open Payment Runs",
};

const BANK_ACCOUNT_PAGE = /^\/accounting\/banking\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DeleteBlockAction = { label: string; href: string };

/** The button for a refused delete, from the error's `hint`; null when there is none to offer. */
export function deleteBlockAction(err: unknown): DeleteBlockAction | null {
  const hint = err && typeof err === "object" ? (err as { hint?: unknown }).hint : undefined;
  if (typeof hint !== "string") return null;
  if (PAGE_LABELS[hint]) return { label: PAGE_LABELS[hint], href: hint };
  if (BANK_ACCOUNT_PAGE.test(hint)) return { label: "Open bank account", href: hint };
  return null;
}
