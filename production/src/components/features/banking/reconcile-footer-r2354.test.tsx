// @vitest-environment jsdom
/* R-2354 — the last reconcile sections save from the sticky footer (after R-2348 / R-2008):
   Own transfer ("Post ₹X as transfer"), Other income ("Book ₹X as interest received"), Loan given
   receipt ("Reconcile as receipt N") and Razorpay settlement ("Reconcile settlement").
   In the sheet (onFooterSave given) each hands the footer the same label, the same disabled rule and
   the same handler / RPC args, and draws no Save of its own; outside the sheet the inline button stays.
   Owner's examples: HDFC "SWEEP IN" ₹50,000 to HDFC FD 1; "INT.PD" ₹1,234; Vinod Hem Raj's ₹16,476
   receipt 2; a ₹3,469 Razorpay settlement with one unmatched payment. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { SettlementPlan } from "@/lib/razorpay/settlement-match";
import { buildLoan, type LoanGivenRow } from "@/lib/queries/loans-given";

const s = vi.hoisted(() => ({
  book: vi.fn(), bookInterest: vi.fn(), post: vi.fn(), create: vi.fn(), reconcileLoan: vi.fn(), rzp: vi.fn(),
  loans: [] as unknown[], rzpData: undefined as unknown,
}));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useBookOtherIncome: () => ({ mutateAsync: s.book, isPending: false }),
  useBookInterestIncome: () => ({ mutateAsync: s.bookInterest, isPending: false }),
  useReconcileAsTransfer: () => ({ mutateAsync: s.post, isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "ca", name: "HDFC Current", bank_name: "HDFC", account_type: "current", is_active: true },
    { id: "fd1", name: "HDFC FD 1", bank_name: "HDFC", account_type: "fixed_deposit", is_active: true },
  ] }),
  useCreateBankAccount: () => ({ mutateAsync: s.create, isPending: false }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/loans-given", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/loans-given")>()),
  useLoansGiven: () => ({ data: s.loans, isLoading: false }),
  useSetUpLoanGiven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReconcileCreditToLoanGiven: () => ({ mutateAsync: s.reconcileLoan, isPending: false }),
  useLoanGivenDisbursalLines: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/queries/razorpay-settlement", () => ({
  useRazorpaySettlement: (_t: string, _s: string | null, enabled: boolean) =>
    ({ data: enabled ? s.rzpData : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useReconcileRazorpaySettlement: () => ({ mutateAsync: s.rzp, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReconcileFooter, type FooterSave } from "./reconcile-who-tiles";
import { OwnTransferSection } from "./own-transfer-section";
import { OtherIncomeSection } from "./other-income-section";
import { LoanGivenReceiptSection } from "./loan-given-receipt-section";
import { RazorpaySettlementSection } from "./razorpay-settlement-section";

/** The sheet's layout: the section in the scrolling body, its Save in the sticky footer. */
function InSheet({ amount, render: body }: { amount: number; render: (report: (s: FooterSave | null) => void) => React.ReactNode }) {
  const [save, setSave] = React.useState<FooterSave | null>(null);
  return (
    <>
      <div data-testid="reconcile-scroll-body">{body(setSave)}</div>
      <ReconcileFooter amount={amount} save={save} hint="fill in the form — its save shows here" onClose={() => {}} />
    </>
  );
}
const body = () => screen.getByTestId("reconcile-scroll-body");
const footer = () => screen.getByTestId("reconcile-footer");
const isPrimary = (b: HTMLElement) => b.className.split(/\s+/).includes("bg-amber");
const primaries = () => screen.getAllByRole("button").filter(isPrimary);

const line = (p: Partial<BankTransactionRow>) => ({
  id: "t1", bank_account_id: "ca", txn_date: "2026-09-30", description: "INT.PD 01-07-26 TO 30-09-26",
  debit: 0, credit: 1234, reference: null, category: null, ...p,
}) as unknown as BankTransactionRow;

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [s.book, s.bookInterest, s.post, s.create, s.reconcileLoan, s.rzp]) fn.mockReset().mockResolvedValue({});
  s.rzp.mockResolvedValue({ payments: 2, fee: 71, fee_booked_now: 71, fee_gst_now: 11 });
  s.loans = [];
  s.rzpData = undefined;
});

describe("R-2354 Own transfer — Post as transfer in the footer", () => {
  it("disabled until the other account is picked, then posts the same args; no Save in the body", async () => {
    const done = vi.fn();
    render(<InSheet amount={50000} render={(r) => <OwnTransferSection transaction={line({ description: "SWEEP IN", credit: 50000 })} onDone={done} onFooterSave={r} />} />);
    expect(within(body()).queryByRole("button", { name: /as transfer/ })).toBeNull();
    const btn = () => within(footer()).getByRole("button", { name: "Post ₹50,000 as transfer" }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Other account"), { target: { value: "fd1" } });
    await vi.waitFor(() => expect(btn().disabled).toBe(false));
    expect(footer().textContent).toContain("Bank ₹50,000 = ₹50,000 ✓");
    expect(primaries()).toEqual([btn()]);
    fireEvent.click(btn());
    await vi.waitFor(() => expect(s.post).toHaveBeenCalledWith({ transactionId: "t1", otherAccountId: "fd1" }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
  it("while a new FD is being added the footer Save stays off (the inline form hid it the same way)", async () => {
    render(<InSheet amount={50000} render={(r) => <OwnTransferSection transaction={line({ description: "SWEEP IN", credit: 50000 })} onDone={() => {}} onFooterSave={r} />} />);
    fireEvent.change(screen.getByLabelText("Other account"), { target: { value: "fd1" } });
    fireEvent.change(screen.getByLabelText("Other account"), { target: { value: "__new" } });
    await vi.waitFor(() => expect((within(footer()).getByRole("button", { name: /as transfer/ }) as HTMLButtonElement).disabled).toBe(true));
  });
  it("outside the sheet the inline button stays", () => {
    render(<OwnTransferSection transaction={line({ credit: 50000 })} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: /Post ₹50,000 as transfer/ })).toBeTruthy();
  });
});

describe("R-2354 Other income — Book as interest received in the footer", () => {
  it("the footer label follows the head picked and books the same args", async () => {
    const done = vi.fn();
    render(<InSheet amount={1234} render={(r) => <OtherIncomeSection transaction={line({})} onDone={done} onFooterSave={r} />} />);
    expect(within(body()).queryByRole("button", { name: /Book ₹1,234/ })).toBeNull();
    await vi.waitFor(() => within(footer()).getByRole("button", { name: "Book ₹1,234 as interest received" }));
    fireEvent.click(screen.getByRole("button", { name: "Other income" }));
    const btn = await vi.waitFor(() => within(footer()).getByRole("button", { name: "Book ₹1,234 as other income" }));
    expect(primaries()).toEqual([btn]);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "t1", head: "other" }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
  it("outside the sheet the inline button stays", () => {
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: /Book ₹1,234 as interest received/ })).toBeTruthy();
  });
});

const vinodRow = {
  id: "loan-v", tenant_id: "t", borrower_name: "Vinod Hem Raj", borrower_type: "person", customer_id: null, vendor_id: null,
  principal: 350000, given_on: "2026-09-05", interest_rate: 12, repayment_plan: "emi", due_on: "2026-10-05", instalments: 24,
  emi_amount: 16476, paid_from_account_id: null, bank_txn_id: null, notes: null, status: "open", closed_on: null,
  created_by: null, created_at: "", updated_at: "",
} as unknown as LoanGivenRow;
const receipt1 = {
  id: "r1", tenant_id: "t", loan_id: "loan-v", repaid_on: "2026-10-05", amount: 16476, principal_part: 12976, interest_part: 3500,
  mode: "bank", reference: null, bank_account_id: "acc-1", bank_txn_id: "t1", notes: null, created_by: null, created_at: "",
};
const line2 = { id: "t2", credit: 16476, txn_date: "2026-11-05", description: "NEFT CR VINOD HEM RAJ" };

describe("R-2354 Loan given receipt — Reconcile as receipt N in the footer", () => {
  it("receipt 2 of Vinod Hem Raj reconciles from the footer with the same args; no Save in the body", async () => {
    s.loans = [buildLoan(vinodRow, [receipt1 as never], "2026-11-05")];
    const done = vi.fn();
    render(<InSheet amount={16476} render={(r) => <LoanGivenReceiptSection transaction={line2} onDone={done} onFooterSave={r} />} />);
    expect(within(body()).queryByRole("button", { name: /Reconcile as receipt/ })).toBeNull();
    const btn = await vi.waitFor(() => within(footer()).getByRole("button", { name: "Reconcile as receipt 2" }) as HTMLButtonElement);
    expect(btn.disabled).toBe(false);
    expect(primaries()).toEqual([btn]);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(s.reconcileLoan).toHaveBeenCalledWith({ txnId: "t2", loanId: "loan-v", interestPart: null }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
  it("more than is owed keeps the footer Save off (the inline rule)", async () => {
    s.loans = [buildLoan(vinodRow, [receipt1 as never], "2026-11-05")];
    render(<InSheet amount={900000} render={(r) => <LoanGivenReceiptSection transaction={{ ...line2, credit: 900000 }} onDone={() => {}} onFooterSave={r} />} />);
    expect(screen.getByText(/More than is owed/)).toBeTruthy();
    const btn = await vi.waitFor(() => within(footer()).getByRole("button", { name: "Reconcile as receipt 2" }) as HTMLButtonElement);
    expect(btn.disabled).toBe(true);
  });
  it("no loan given yet → nothing in the footer; 'Set up loan given' is not a second primary", () => {
    render(<InSheet amount={16476} render={(r) => <LoanGivenReceiptSection transaction={line2} onDone={() => {}} onFooterSave={r} />} />);
    expect(within(footer()).queryByRole("button", { name: /receipt/ })).toBeNull();
    const setUp = screen.getByRole("button", { name: /Set up loan given/ });
    expect(isPrimary(setUp)).toBe(false);
  });
  it("outside the sheet the inline button stays", () => {
    s.loans = [buildLoan(vinodRow, [receipt1 as never], "2026-11-05")];
    render(<LoanGivenReceiptSection transaction={line2} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: /Reconcile as receipt 2/ })).toBeTruthy();
  });
});

const unmatchedProblem = "Razorpay payment pay_2 (₹2,360) is not in the app. Pick the app payment it is, or record it first on its quote with reference pay_2, then fetch again.";
const plan: SettlementPlan = {
  settlement: { id: "setl_A", utr: "AXIS1", amount: 9251, createdAt: 1792474200 },
  payments: [
    { rzpId: "pay_1", amount: 1180, fee: 24, tax: 4, orderId: null, createdAt: null, paymentIds: ["a1"], matchedBy: "reference", customer: "Acme", quoteId: "Q-1", candidates: [], problem: null },
    { rzpId: "pay_2", amount: 2360, fee: 47, tax: 7, orderId: null, createdAt: null, paymentIds: [], matchedBy: null, customer: null, quoteId: null,
      candidates: [{ id: "p9", amount: 2360, received_at: "2026-10-18T10:00:00Z", customer_name: "Beta", quote_id: "Q-9", reference: null }], problem: unmatchedProblem },
  ],
  refunds: [],
  totals: { gross: 3540, refunds: 0, fee: 71, feeGst: 11, other: 0, net: 3469, bank: 3469 },
  blockers: [unmatchedProblem],
  ready: false,
  rpcArg: null,
};

describe("R-2354 Razorpay settlement — Reconcile settlement in the footer", () => {
  it("nothing in the footer until fetched; off while a payment is unmatched; then the same RPC args", async () => {
    s.rzpData = { state: "plan", plan };
    const done = vi.fn();
    render(<InSheet amount={3469} render={(r) => <RazorpaySettlementSection line={{ id: "L1", credit: 3469 }} onDone={done} onFooterSave={r} />} />);
    expect(within(footer()).queryByRole("button", { name: /Reconcile settlement/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Fetch settlement/ }));
    const btn = () => within(footer()).getByRole("button", { name: "Reconcile settlement" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(btn().disabled).toBe(true));
    fireEvent.change(screen.getByLabelText("App payment for pay_2"), { target: { value: "p9" } });
    await vi.waitFor(() => expect(btn().disabled).toBe(false));
    expect(within(body()).queryByRole("button", { name: /Reconcile settlement/ })).toBeNull();
    expect(primaries()).toEqual([btn()]);
    fireEvent.click(btn());
    await vi.waitFor(() => expect(s.rzp).toHaveBeenCalledWith({ txnId: "L1", settlementId: "setl_A", picks: { pay_2: "p9" } }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
  it("outside the sheet the inline button stays", () => {
    s.rzpData = { state: "plan", plan: { ...plan, blockers: [], payments: [plan.payments[0]] } };
    render(<RazorpaySettlementSection line={{ id: "L1", credit: 3469 }} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Fetch settlement/ }));
    expect(screen.getByRole("button", { name: /Reconcile settlement/ })).toBeTruthy();
  });
});
