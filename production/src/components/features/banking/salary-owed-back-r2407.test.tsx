// @vitest-environment jsdom
/* R-2407 — Banking → Reconcile → a salary payout that also pays back money owed to the employee.
   Owner example (staging 4523): Neelam paid ₹16,000 in by mistake (booked "owed back"); her October
   salary ₹30,000 went out as ONE ₹46,000 line → "also pays back ₹16,000 owed to Neelam Sharma";
   saving pays the salary and settles the ₹16,000 — no extra salary expense. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ReconcileFooter, type FooterSave } from "./reconcile-who-tiles";
import type { BankTransactionRow } from "@/lib/queries/bank";

const mutateAsync = vi.fn();
let pending: Array<{ id: string; person_name: string; amount: number; incurred_on: string; purpose: string; employee_id: string | null }> = [];
vi.mock("@/lib/queries/employee-advance-bank", () => ({
  usePendingReimbursements: () => ({ data: pending }),
  useReconcileSalaryWithOwedBack: () => ({ mutateAsync, isPending: false }),
}));

import { SalaryOwedBackSection } from "./salary-owed-back-r2407";

const salaries = [
  { id: "s1", employee_id: "e1", employee_name: "Neelam Sharma", period: "2026-10", remaining: 30000 },
  { id: "s2", employee_id: "e2", employee_name: "Ravi Verma", period: "2026-10", remaining: 40000 },
];
const owedNeelam = { id: "r1", person_name: "Neelam Sharma", amount: 16000, incurred_on: "2026-10-26", purpose: "Paid to the company by mistake — owed back", employee_id: "e1" };

const txn = (over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  id: "t1", tenant_id: "x", bank_account_id: "acc-1", txn_date: "2026-11-01", description: "NEFT SALARY NEELAM SHARMA OCT",
  debit: 46000, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "", created_at: "", updated_at: "", ...over,
} as BankTransactionRow);

function InSheet({ t, onDone = () => {} }: { t: BankTransactionRow; onDone?: () => void }) {
  const [footer, setFooter] = React.useState<FooterSave | null>(null);
  return (
    <>
      <div data-testid="body"><SalaryOwedBackSection transaction={t} salaries={salaries} onDone={onDone} onFooterSave={setFooter} /></div>
      <ReconcileFooter amount={t.debit || t.credit} save={footer} hint="pick" onClose={() => {}} />
    </>
  );
}

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({}); pending = []; });

describe("R-2407 salary payout that also pays back what is owed", () => {
  it("₹46,000 = Neelam's ₹30,000 salary + ₹16,000 owed back: shown, pre-picked, footer pays both", async () => {
    pending = [owedNeelam];
    const done = vi.fn();
    render(<InSheet t={txn()} onDone={done} />);
    expect(screen.getByText(/also pays back ₹16,000 owed to Neelam Sharma/i)).toBeTruthy();
    expect(screen.getByText(/₹30,000/)).toBeTruthy();
    const btn = await vi.waitFor(() => within(screen.getByTestId("reconcile-footer"))
      .getByRole("button", { name: "Pay salary + ₹16,000 owed back · Neelam Sharma" }));
    expect(screen.getByTestId("reconcile-footer").textContent).toContain("Bank ₹46,000 = ₹46,000 ✓");
    fireEvent.click(btn);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", salaryId: "s1", reimbursementId: "r1" });
  });

  it("nothing owed to that employee → nothing shown, no footer save", () => {
    pending = [{ ...owedNeelam, employee_id: "e9", person_name: "Someone Else" }];
    render(<InSheet t={txn()} />);
    expect(screen.getByTestId("body").innerHTML).toBe("");
    expect(within(screen.getByTestId("reconcile-footer")).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("a money-in line never shows it", () => {
    pending = [owedNeelam];
    render(<InSheet t={txn({ debit: 0, credit: 46000 })} />);
    expect(screen.getByTestId("body").innerHTML).toBe("");
  });
});
