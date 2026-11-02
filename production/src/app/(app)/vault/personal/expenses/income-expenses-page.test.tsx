// @vitest-environment jsdom
//
// R-2387 — Private Vault → Income & Expenses, the screen wiring. Owner's own path first
// (card howToCheck): + Income → Rent ₹20,000 → it shows in the Income tile with ITR head
// House property; add an expense → Saved = Income − Spend.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = { accounts: q<unknown[]>([]), transactions: q<unknown[]>([]) };
const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
const m = { saveTx: mk(), delTx: mk() };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalTransactions: () => state.transactions,
  useSavePersonalTransaction: () => m.saveTx,
  useDeletePersonalTransaction: () => m.delTx,
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
const csvMock = vi.hoisted(() => ({ downloadCSV: vi.fn() }));
vi.mock("@/lib/csv", async (orig) => ({ ...(await orig<typeof import("@/lib/csv")>()), downloadCSV: csvMock.downloadCSV }));

// Radix Select does not open in jsdom — a native <select> keeps the options readable.
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

import Expenses from "./page";

const SAVINGS = { id: "a1", kind: "savings", label: "HDFC Salary", balance: 0, is_active: true };
const RENT = { id: "t1", kind: "other_income", income_source: "rent", amount: 20_000, occurred_on: "2026-10-05", category: null, account_id: "a1", party: "Tenant Sharma", note: null, repeat_monthly: true };
const SALARY = { id: "t2", kind: "salary", income_source: "salary", amount: 90_000, occurred_on: "2026-11-01", category: null, account_id: "a1", party: "Acme", note: null, repeat_monthly: true };
const HOUSE = { id: "t3", kind: "expense", income_source: null, amount: 7_500, occurred_on: "2026-11-02", category: "Household", account_id: null, party: null, note: null, repeat_monthly: false };
const TRANSFER = { id: "t4", kind: "transfer_in", income_source: null, amount: 50_000, occurred_on: "2026-11-02", category: null, account_id: "a1", party: null, note: null, repeat_monthly: false };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-02T06:00:00Z"));   // 2 Nov 2026 IST, FY 2026-27
  state.accounts = q([SAVINGS]);
  state.transactions = q([]);
  m.saveTx = mk(); m.delTx = mk();
  csvMock.downloadCSV.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
const click = async (name: RegExp | string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const tile = (label: RegExp) => screen.getByText(label).nextElementSibling!.textContent!.replace(/[^0-9]/g, "");

describe("buttons", () => {
  it("offers + Income, + Expense and Drawing (from company)", () => {
    render(<Expenses />);
    expect(screen.getByRole("button", { name: /^Income$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Expense$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Drawing \(from company\)/ })).toBeTruthy();
  });
});

describe("owner's path: + Income → Rent ₹20,000", () => {
  it("saves kind other_income with income_source rent, party and repeat monthly", async () => {
    render(<Expenses />);
    await click(/^Income$/);
    type("ve-source", "rent");
    expect(screen.getByText(/ITR head: House property/)).toBeTruthy();
    type("ve-amount", "20,000");
    type("ve-party", "Tenant Sharma");
    fireEvent.change(document.getElementById("ve-account")!, { target: { value: "a1" } });
    await click(/^Add$/);
    expect(m.saveTx.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      kind: "other_income", income_source: "rent", amount: 20_000, party: "Tenant Sharma",
      account_id: "a1", category: null, repeat_monthly: true,
    }));
  });

  it("an expense saves with its category and no income source", async () => {
    render(<Expenses />);
    await click(/^Expense$/);
    type("ve-category", "Loan EMI");
    type("ve-amount", "12000");
    await click(/^Add$/);
    expect(m.saveTx.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      kind: "expense", category: "Loan EMI", income_source: null, repeat_monthly: false,
    }));
  });
});

describe("tiles and summaries", () => {
  beforeEach(() => { state.transactions = q([HOUSE, TRANSFER, SALARY, RENT]); });

  it("Income, Spent and Saved = Income − Spent; a transfer is neither", () => {
    render(<Expenses />);
    expect(tile(/^Income ·/)).toBe("110000");   // salary 90,000 + rent 20,000 (transfer left out)
    expect(tile(/^Spent$/)).toBe("7500");
    expect(tile(/^Saved/)).toBe("102500");
  });

  it("shows income by source and the FY split by ITR head", () => {
    render(<Expenses />);
    const heads = screen.getByText(/income by ITR head/).closest("div")!;
    expect(within(heads).getByText("House property")).toBeTruthy();
    expect(within(heads).getByText("Salary")).toBeTruthy();
    expect(screen.getByText(/Income by source/)).toBeTruthy();
  });

  it("the month filter narrows the tiles to that month", () => {
    render(<Expenses />);
    type("ve-month", "2026-10");
    expect(screen.getByText(/^Income · October 2026$/)).toBeTruthy();
    expect(tile(/^Income ·/)).toBe("20000");
    expect(tile(/^Spent$/)).toBe("0");
  });

  it("CSV export hands the period's rows to downloadCSV", async () => {
    render(<Expenses />);
    await click(/Export CSV/);
    const [file, headers, rows] = csvMock.downloadCSV.mock.calls[0];
    expect(file).toBe("personal-income-expenses-fy-2026.csv");
    expect(headers).toContain("ITR head");
    expect(rows).toHaveLength(4);
  });
});

describe("repeat monthly — Add this month's", () => {
  it("offers last month's rent for this month and pre-fills it", async () => {
    state.transactions = q([RENT]);
    render(<Expenses />);
    expect(screen.getByText(/Monthly entries not added for November 2026/)).toBeTruthy();
    await click(/Add this month/);
    expect((document.getElementById("ve-date") as HTMLInputElement).value).toBe("2026-11-05");
    expect((document.getElementById("ve-amount") as HTMLInputElement).value).toBe("20000");
    await click(/^Add$/);
    expect(m.saveTx.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      id: undefined, kind: "other_income", income_source: "rent", occurred_on: "2026-11-05", repeat_monthly: true,
    }));
  });

  it("nothing is offered once this month's salary is in", () => {
    state.transactions = q([SALARY]);
    render(<Expenses />);
    expect(screen.queryByText(/Monthly entries not added/)).toBeNull();
  });
});

describe("old and imported rows", () => {
  it("an imported transfer keeps its kind when edited", async () => {
    state.transactions = q([TRANSFER]);
    render(<Expenses />);
    await click("Edit");
    type("ve-note", "moved from FD");
    await click(/^Update$/);
    expect(m.saveTx.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ id: "t4", kind: "transfer_in", income_source: null }));
  });
});
