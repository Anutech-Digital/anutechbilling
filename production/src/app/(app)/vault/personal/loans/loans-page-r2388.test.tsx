// @vitest-environment jsdom
//
// R-2388 — Private Vault → Loans, Pardeep's checks from the card:
//  1. Taken → home loan ₹20 L, 8.5%, 240 months → the EMI is calculated (₹17,356) and saved
//     with the session's identity (no owner in the payload).
//  2. The schedule shows EMI 1 due with interest ₹14,167 / principal ₹3,189; "Mark paid"
//     opens the payment step pre-filled with that split and books it through the RPC hook.
//  3. Given → ₹1 L lent to a brother → "Record repayment" pre-fills the outstanding as
//     principal, no interest.
//  4. Overview: Net worth counts the loan given as an asset and the loan taken as owed, and
//     shows the "Next EMI due" reminder.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = {
  accounts: q<unknown[]>([]),
  loans: q<unknown[]>([]),
  payments: q<unknown[]>([]),
};
const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ outstanding: 0, closed: false }), isPending: false });
const m = { saveLoan: mk(), setStatus: mk(), delLoan: mk(), record: mk(), undo: mk(), other: mk() };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalHoldings: () => q([]),
  usePersonalTransactions: () => q([]),
  usePinStatus: () => q({ configured: false }),
  useSetPin: () => m.other,
  useRemovePin: () => m.other,
  useVerifyPin: () => m.other,
}));
vi.mock("@/lib/queries/personal-owe-hold", () => ({ usePersonalOweHold: () => q([]) }));
vi.mock("@/lib/queries/personal-loans", () => ({
  usePersonalLoans: () => state.loans,
  usePersonalLoanPayments: () => state.payments,
  useSavePersonalLoan: () => m.saveLoan,
  useSetLoanStatus: () => m.setStatus,
  useDeletePersonalLoan: () => m.delLoan,
  useRecordLoanPayment: () => m.record,
  useUndoLoanPayment: () => m.undo,
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/features/vault/vault-pin-settings", () => ({ VaultPinSettings: () => null }));

// Radix Select does not open in jsdom — a native <select> keeps the choices readable.
vi.mock("@/components/ui/select", async () => {
  const R = await import("react");
  type Kids = { children?: React.ReactNode };
  const SelectTrigger = (_p: { id?: string } & Kids) => null;
  const SelectValue = (_p: { placeholder?: string }) => null;
  const SelectContent = ({ children }: Kids) => R.createElement(R.Fragment, null, children);
  const SelectItem = ({ value, children }: { value: string } & Kids) => R.createElement("option", { value }, children);
  const Select = ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void } & Kids) => {
    const kids = R.Children.toArray(children) as React.ReactElement<{ id?: string }>[];
    const id = kids.find((k) => k.type === SelectTrigger)?.props.id;
    return R.createElement("select", { id, value: value ?? "", onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(e.target.value) }, children);
  };
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

import LoansPage from "./page";
import Overview from "../page";

const SAVINGS = { id: "a1", kind: "savings", label: "HDFC Salary", institution: "HDFC", account_last4: "4321", balance: 5_00_000, is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };
const HOME = {
  id: "l1", direction: "taken", loan_kind: "home", party: "SBI Home Loan", principal: 20_00_000, start_date: "2026-04-01",
  annual_rate: 8.5, repay_type: "emi", tenure_months: 240, emi_amount: 17_356, first_due_on: null, account_id: "a1",
  note: null, status: "open", closed_on: null,
};
const BRO = {
  id: "l2", direction: "given", loan_kind: "person", party: "Brother", principal: 1_00_000, start_date: "2026-10-01",
  annual_rate: null, repay_type: "no_interest", tenure_months: null, emi_amount: null, first_due_on: null, account_id: "a1",
  note: null, status: "open", closed_on: null,
};

beforeEach(() => {
  state.accounts = q([SAVINGS]); state.loans = q([]); state.payments = q([]);
  for (const k of Object.values(m)) k.mutateAsync.mockClear();
  window.history.replaceState(null, "", "/vault/personal/loans");
});
afterEach(cleanup);

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, v: string) => fireEvent.change(input(id), { target: { value: v } });

describe("R-2388 Loans page", () => {
  it("adds a home loan with the EMI calculated (₹17,356), no owner in the payload", async () => {
    render(<LoansPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add loan" })[0]);
    type("ln-party", "SBI Home Loan");
    type("ln-principal", "2000000");
    type("ln-rate", "8.5");
    type("ln-tenure", "240");
    expect(input("ln-emi").value).toBe("17356");
    type("ln-account", "a1");
    const dlg = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add loan" })); });
    expect(m.saveLoan.mutateAsync).toHaveBeenCalledTimes(1);
    const sent = m.saveLoan.mutateAsync.mock.calls[0][0];
    expect(sent).toMatchObject({
      direction: "taken", loan_kind: "home", party: "SBI Home Loan", principal: 2000000, annual_rate: 8.5,
      repay_type: "emi", tenure_months: 240, emi_amount: 17356, account_id: "a1",
    });
    expect(sent).not.toHaveProperty("owner_user_id");
    expect(sent).not.toHaveProperty("tenant_id");
  });

  it("schedule: EMI 1 due 01 May with ₹14,167 interest + ₹3,189 principal; Mark paid books that split", async () => {
    state.loans = q([HOME]);
    render(<LoansPage />);
    fireEvent.click(screen.getByRole("button", { name: "SBI Home Loan" }));
    const sched = screen.getByRole("table", { name: "Repayment schedule" });
    const first = within(sched).getAllByRole("row")[1];
    expect(first.textContent).toContain("14,167");
    expect(first.textContent).toContain("3,189");
    fireEvent.click(within(first).getByRole("button", { name: "Mark paid" }));
    expect(input("lp-principal").value).toBe("3189");
    expect(input("lp-interest").value).toBe("14167");
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toMatch(/not spending/);
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Mark paid" })); });
    expect(m.record.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      loan_id: "l1", kind: "emi", principal: 3189, interest: 14167, account_id: "a1",
    }));
  });

  it("principal above the outstanding is stopped before the database", async () => {
    state.loans = q([{ ...BRO }]);
    render(<LoansPage />);
    fireEvent.click(screen.getByRole("button", { name: /given/i }));
    fireEvent.click(screen.getByRole("button", { name: "Record repayment" }));
    expect(input("lp-principal").value).toBe("100000");
    expect(input("lp-interest").value).toBe("0");
    type("lp-principal", "150000");
    const dlg = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Record" })); });
    expect(m.record.mutateAsync).not.toHaveBeenCalled();
    expect(within(dlg).getByRole("alert").textContent).toMatch(/more than/);
  });

  it("a home loan shows the FY interest (24b) and principal (80C) for the ITR", () => {
    state.loans = q([HOME]);
    state.payments = q([{ id: "p1", loan_id: "l1", kind: "emi", paid_on: "2026-05-01", principal_part: 3189, interest_part: 14167, account_id: "a1", note: null, created_at: "" }]);
    render(<LoansPage />);
    const itr = screen.getByLabelText(/Home loan · FY/);
    expect(itr.textContent).toMatch(/24\(b\)/);
    expect(itr.textContent).toContain("14,167");
    expect(itr.textContent).toContain("3,189");
  });
});

describe("R-2388 Overview — loans in Net worth + next EMI", () => {
  it("₹1 L lent is an asset; the home loan is owed; next EMI reminder shows", () => {
    state.loans = q([HOME, BRO]);
    render(<Overview />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Loans given/);
    expect(text).toMatch(/Loans taken/);
    expect(text).toMatch(/Next EMI due/);
    // 5,00,000 + 1,00,000 − 20,00,000 = −14,00,000
    expect(text).toMatch(/14,00,000/);
  });
});
