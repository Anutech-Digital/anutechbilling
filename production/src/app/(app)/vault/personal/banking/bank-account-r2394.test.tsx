// @vitest-environment jsdom
//
// R-2394 — Private Vault → Banking works like the business Banking (Pardeep, 3 Nov: "isko bhi
// poora vaisa hi banao … par bank ko asset ke roop me hi show karo"):
//  1. Banking list keeps the ASSETS heading; each account is a link to its own page; the form
//     saves an OPENING balance + as-of date (never the old typed balance).
//  2. Account page: computed balance, lines with the running balance, statement check
//     ("Matches the statement" / difference), unmatched count as the next step.
//  3. Filters: unmatched / matched / typed, in / out, search.
//  4. Side sheet: Expense + "always put SWIGGY here" → ONE reconcile call; Loan EMI → the loan;
//     Already entered → the typed LIC entry; a matched line offers Undo.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });
const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ tx_id: "x", suggested: 0 }), isPending: false });
const m = { saveAccount: mk(), delAccount: mk(), reconcile: mk(), undo: mk(), commit: mk(), other: mk() };

const state = {
  accounts: q<unknown[]>([]),
  lines: q<unknown[]>([]),
  matchable: q<unknown[]>([]),
  loans: q<unknown[]>([]),
};

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "a1" }), useRouter: () => ({ push: vi.fn() }), usePathname: () => "/vault/personal/banking/a1" }));
vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  useSavePersonalAccount: () => m.saveAccount,
  useDeletePersonalAccount: () => m.delAccount,
  usePersonalCategories: () => q([]),
  usePersonalCategoryRules: () => q([]),
  useCommitPersonalImport: () => m.commit,
}));
vi.mock("@/lib/queries/personal-banking", () => ({
  useAccountTransactions: (id: string | null) => (id === "a1" ? state.lines : q([])),
  useMatchableEntries: () => state.matchable,
  useReconcileLine: () => m.reconcile,
  useUnreconcileLine: () => m.undo,
}));
vi.mock("@/lib/queries/personal-loans", () => ({ usePersonalLoans: () => state.loans }));
vi.mock("@/lib/queries/personal-owe-hold", () => ({ usePersonalOweHold: () => q([]) }));
vi.mock("@/components/features/vault/owe-hold-section", () => ({ OweHoldSection: () => null }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// Radix Select does not open in jsdom — a native <select> keeps the choices readable.
vi.mock("@/components/ui/select", async () => {
  const R = await import("react");
  type Kids = { children?: React.ReactNode };
  const SelectTrigger = (_p: { id?: string; "aria-label"?: string } & Kids) => null;
  const SelectValue = (_p: { placeholder?: string }) => null;
  const SelectContent = ({ children }: Kids) => R.createElement(R.Fragment, null, children);
  const SelectItem = ({ value, children }: { value: string } & Kids) => R.createElement("option", { value }, children);
  const Select = ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void } & Kids) => {
    const kids = R.Children.toArray(children) as React.ReactElement<{ id?: string; "aria-label"?: string }>[];
    const trig = kids.find((k) => k.type === SelectTrigger)?.props;
    return R.createElement("select", { id: trig?.id, "aria-label": trig?.["aria-label"], value: value ?? "", onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(e.target.value) },
      R.createElement("option", { value: "" }, ""), children);
  };
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

import BankingPage from "./page";
import AccountPage from "./[id]/page";

const SAV = { id: "a1", kind: "savings", label: "Demo Savings", institution: "HDFC", account_last4: "4321", balance: 1_34_550, opening_balance: 50_000, opening_as_of: "2026-03-31", is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };
const CUR = { id: "a2", kind: "current", label: "Demo Current", institution: null, account_last4: null, balance: 0, opening_balance: 0, opening_as_of: null, is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };

const line = (p: Record<string, unknown>) => ({
  account_id: "a1", category: null, note: null, party: null, income_source: null, source: "import",
  reference: null, dedupe_hash: "h", reconciled_at: null, pair_tx_id: null, owe_hold_id: null,
  created_at: "2026-11-03T01:00:00Z", balance_after: null, line_no: null, ...p,
});
const SALARY = line({ id: "t1", kind: "salary", amount: 85_000, occurred_on: "2026-04-01", raw_description: "SALARY APR ACME", balance_after: 1_35_000, line_no: 1, reconciled_at: "2026-11-03T01:05:00Z", income_source: "salary" });
const SWIGGY = line({ id: "t2", kind: "expense", amount: 450, occurred_on: "2026-04-02", raw_description: "UPI-SWIGGY-SWIGGY@ICICI-ORDER", balance_after: 1_34_550, line_no: 2 });

beforeEach(() => {
  state.accounts = q([SAV, CUR]);
  state.lines = q([SALARY, SWIGGY]);
  state.matchable = q([]);
  state.loans = q([]);
  for (const k of Object.values(m)) k.mutateAsync.mockClear();
});
afterEach(cleanup);

const select = (id: string, v: string) => fireEvent.change(document.getElementById(id)!, { target: { value: v } });

describe("R-2394 Banking list — still Assets, each account opens its page", () => {
  it("ASSETS heading, account name links to the account page, balance shown is the computed one", () => {
    render(<BankingPage />);
    expect(screen.getByRole("heading", { name: "Assets" })).toBeDefined();
    const link = screen.getByRole("link", { name: "Demo Savings" });
    expect(link.getAttribute("href")).toBe("/vault/personal/banking/a1");
    expect(screen.getByRole("link", { name: "Open Demo Savings" }).getAttribute("href")).toBe("/vault/personal/banking/a1");
    expect(screen.getAllByText(/1,34,550/).length).toBeGreaterThan(0);
  });

  it("the form saves an opening balance + as-of date, not the old typed balance", async () => {
    render(<BankingPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect((document.getElementById("vb-balance") as HTMLInputElement).value).toBe("50000");
    fireEvent.change(document.getElementById("vb-balance")!, { target: { value: "60000" } });
    fireEvent.change(document.getElementById("vb-as-of")!, { target: { value: "2026-04-01" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update" })); });
    const arg = m.saveAccount.mutateAsync.mock.calls[0][0];
    expect(arg).toMatchObject({ id: "a1", opening_balance: 60_000, opening_as_of: "2026-04-01" });
    expect(arg).not.toHaveProperty("balance");
  });
});

describe("R-2394 account page", () => {
  it("computed balance, running balance per line, statement check matches, next step = Match 1 line", () => {
    render(<AccountPage />);
    expect(screen.getByRole("heading", { name: "Demo Savings" })).toBeDefined();
    expect(within(screen.getByTestId("vba-balance")).getByText(/1,34,550/)).toBeDefined();
    const rows = screen.getAllByTestId("vba-line");
    expect(rows).toHaveLength(2);
    // newest first, each with its running balance
    expect(within(rows[0]).getByText("₹1,34,550")).toBeDefined();
    expect(within(rows[1]).getByText("₹1,35,000")).toBeDefined();
    expect(within(screen.getByTestId("vba-check")).getByText("Matches the statement")).toBeDefined();
    expect(screen.getByRole("button", { name: "Match 1 line" })).toBeDefined();
  });

  it("a wrong opening shows the difference against the statement", () => {
    state.accounts = q([{ ...SAV, opening_balance: 40_000 }, CUR]);
    render(<AccountPage />);
    expect(within(screen.getByTestId("vba-check")).getByText("Difference ₹10,000")).toBeDefined();
  });

  it("filters: unmatched, money in, search", () => {
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "Unmatched" }));
    expect(screen.getAllByTestId("vba-line")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Money in or out"), { target: { value: "in" } });
    expect(screen.getAllByTestId("vba-line")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Money in or out"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search lines"), { target: { value: "swiggy" } });
    expect(screen.getAllByTestId("vba-line")).toHaveLength(1);
  });

  it("sheet: Expense + 'always put SWIGGY here' is ONE reconcile call", async () => {
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    expect(screen.getByRole("button", { name: "Expense" }).getAttribute("aria-pressed")).toBe("true");
    select("vbr-category", "Food / Dining");
    fireEvent.click(screen.getByLabelText("Always put lines with this text here"));
    expect((screen.getByLabelText("Rule text") as HTMLInputElement).value).toBe("SWIGGY");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save match" })); });
    expect(m.reconcile.mutateAsync).toHaveBeenCalledTimes(1);
    expect(m.reconcile.mutateAsync.mock.calls[0][0]).toEqual({
      txId: "t2", action: "expense", payload: { category: "Food / Dining", party: "", rule_text: "SWIGGY" },
    });
  });

  it("sheet: Loan EMI goes to the picked loan (scheduled split when interest is empty)", async () => {
    state.loans = q([{ id: "l1", direction: "taken", status: "open", party: "SBI Home Loan" }, { id: "l2", direction: "given", status: "open", party: "Brother" }]);
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    fireEvent.click(screen.getByRole("button", { name: "Loan EMI / repayment" }));
    expect(screen.queryByText("Brother")).toBeNull();   // a loan you gave is not paid by money out
    select("vbr-loan", "l1");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save match" })); });
    expect(m.reconcile.mutateAsync.mock.calls[0][0]).toMatchObject({ txId: "t2", action: "loan", payload: { loan_id: "l1", interest: undefined } });
  });

  it("sheet: Already entered offers the typed entry of the same amount and merges into it", async () => {
    state.matchable = q([line({ id: "lic", source: "manual", dedupe_hash: null, kind: "expense", amount: 450, occurred_on: "2026-04-01", category: "Food / Dining", note: "Lunch" })]);
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    fireEvent.click(screen.getByRole("button", { name: "Already entered (1)" }));
    fireEvent.click(screen.getByRole("radio"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save match" })); });
    expect(m.reconcile.mutateAsync.mock.calls[0][0]).toEqual({ txId: "t2", action: "match", payload: { match_tx_id: "lic" } });
  });

  it("sheet: Transfer needs the other account and creates its line", async () => {
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    fireEvent.click(screen.getByRole("button", { name: "Transfer between my accounts" }));
    select("vbr-other", "a2");
    expect(screen.getByText("Add the line on Demo Current")).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save match" })); });
    expect(m.reconcile.mutateAsync.mock.calls[0][0]).toEqual({ txId: "t2", action: "transfer", payload: { other_account_id: "a2", pair_tx_id: undefined } });
  });

  it("a matched line opens with Undo", async () => {
    render(<AccountPage />);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByTestId("vbr-matched-as").textContent).toMatch(/Salary/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo match" })); });
    expect(m.undo.mutateAsync).toHaveBeenCalledWith("t1");
  });
});
