// @vitest-environment jsdom
//
// R-2386 — Private Vault, Pardeep's real case (2 Nov): ₹5 lakh byana received for his
// daughter's property sale, kept as cash with his brother.
//  1. Overview: cash ₹5 L + open advance ₹5 L → Net worth does NOT grow by ₹5 L; the
//     "I owe / hold for others" line shows ₹5,00,000.
//  2. Banking: the account's saved note shows under its name.
//  3. Banking → "Money I owe / hold for others": add the byana (party, amount, where the cash
//     is) → saved with the session's identity (no owner in the payload).
//  4. An advance offers "Convert into sale" (first) + "Refund"; held money only "Hand over";
//     Convert opens a settle step pre-filled with the sale note.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = {
  accounts: q<unknown[]>([]),
  holdings: q<unknown[]>([]),
  transactions: q<unknown[]>([]),
  oweHold: q<unknown[]>([]),
};
const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
const m = { saveAccount: mk(), delAccount: mk(), saveOH: mk(), settleOH: mk(), delOH: mk(), other: mk() };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalHoldings: () => state.holdings,
  usePersonalTransactions: () => state.transactions,
  useSavePersonalAccount: () => m.saveAccount,
  useDeletePersonalAccount: () => m.delAccount,
  usePinStatus: () => q({ configured: false }),
  useSetPin: () => m.other,
  useRemovePin: () => m.other,
  useVerifyPin: () => m.other,
}));
vi.mock("@/lib/queries/personal-owe-hold", () => ({
  usePersonalOweHold: () => state.oweHold,
  useSavePersonalOweHold: () => m.saveOH,
  useSettlePersonalOweHold: () => m.settleOH,
  useDeletePersonalOweHold: () => m.delOH,
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

import Overview from "./page";
import Banking from "./banking/page";
import { istToday } from "@/lib/dates/ist";

const TODAY = istToday();

const CASH = { id: "a1", kind: "cash", label: "Cash with Deepak (held)", institution: null, account_last4: null, balance: 5_00_000, is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: "Byana for the plot sale — kept with my brother" };
const SAVINGS = { id: "a2", kind: "savings", label: "HDFC Salary", institution: "HDFC", account_last4: "4321", balance: 2_00_000, is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };
const BYANA = { id: "o1", kind: "advance_received", party: "Plot buyer", occurred_on: "2026-11-01", amount: 5_00_000, note: "Daughter's property sale", account_id: "a1", status: "open", settled_on: null, settled_how: null, settle_note: null };
const HELD = { id: "o2", kind: "held_for_other", party: "Daughter", occurred_on: "2026-10-15", amount: 50_000, note: null, account_id: null, status: "open", settled_on: null, settled_how: null, settle_note: null };
const DONE = { ...HELD, id: "o3", party: "Son", status: "settled", settled_on: "2026-10-20", settled_how: "handed_over" };

beforeEach(() => {
  state.accounts = q([]); state.holdings = q([]); state.transactions = q([]); state.oweHold = q([]);
  for (const k of Object.values(m)) { k.mutateAsync.mockClear(); }
});
afterEach(() => cleanup());

const moneyOnScreen = () =>
  Array.from(document.querySelectorAll("body *")).map((n) => n.textContent ?? "").filter((t) => t.startsWith("₹")).map((t) => t.replace(/[^0-9]/g, ""));
const hasRupees = (n: number) => moneyOnScreen().includes(String(n));

describe("Overview — Net worth takes off money I owe / hold (R-2386)", () => {
  it("₹5 L cash held + ₹5 L open byana: Net worth is the savings only, and the line shows ₹5 L", () => {
    state.accounts = q([CASH, SAVINGS]);
    state.oweHold = q([BYANA]);
    render(<Overview />);
    expect(screen.getByText("I owe / hold for others")).toBeDefined();
    // 5,00,000 + 2,00,000 − 5,00,000 = 2,00,000. Without the entry it read 7,00,000.
    const net = screen.getByText("Net worth").parentElement!;
    expect(within(net).getAllByText(/₹/)[0].textContent?.replace(/[^0-9]/g, "")).toBe("200000");
    expect(hasRupees(5_00_000)).toBe(true);
  });

  it("a settled entry no longer comes off", () => {
    state.accounts = q([SAVINGS]);
    state.oweHold = q([DONE]);
    render(<Overview />);
    const net = screen.getByText("Net worth").parentElement!;
    expect(within(net).getAllByText(/₹/)[0].textContent?.replace(/[^0-9]/g, "")).toBe("200000");
  });

  it("an owner who has only an owe/hold entry is not shown 'Your vault is empty'", () => {
    state.oweHold = q([HELD]);
    render(<Overview />);
    expect(screen.queryByText(/Your vault is empty/)).toBeNull();
  });
});

describe("Overview — this FY uses the Income & Expenses rules (R-2386 / R-2387)", () => {
  it("a card payment, transfer or ATM cash is not 'spent'; a refund is income", () => {
    state.accounts = q([SAVINGS]);
    state.transactions = q([
      { id: "t1", kind: "expense", amount: 1_000, occurred_on: TODAY, category: "Groceries" },
      { id: "t2", kind: "card_payment", amount: 50_000, occurred_on: TODAY },
      { id: "t3", kind: "atm_cash", amount: 5_000, occurred_on: TODAY },
      { id: "t4", kind: "salary", amount: 80_000, occurred_on: TODAY },
      { id: "t5", kind: "refund", amount: 300, occurred_on: TODAY },
    ]);
    render(<Overview />);
    const spent = screen.getByText("Total spent").parentElement!;
    expect(within(spent).getByText(/₹/).textContent?.replace(/[^0-9]/g, "")).toBe("1000");
    const inn = screen.getByText("Total in").parentElement!;
    expect(within(inn).getByText(/₹/).textContent?.replace(/[^0-9]/g, "")).toBe("80300");
  });
});

describe("Banking — the account note and the owe/hold list (R-2386)", () => {
  it("shows the saved note under the account name", () => {
    state.accounts = q([CASH, SAVINGS]);
    render(<Banking />);
    expect(screen.getByText("Byana for the plot sale — kept with my brother")).toBeDefined();
  });

  it("adds the byana with where the cash sits; no owner in the payload", async () => {
    state.accounts = q([CASH, SAVINGS]);
    render(<Banking />);
    expect(screen.getByText("Money I owe / hold for others")).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Add entry/ })); });
    fireEvent.change(screen.getByLabelText("Received from (buyer)"), { target: { value: "Plot buyer" } });
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "5,00,000" } });
    fireEvent.change(screen.getByLabelText("Where the money is"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Daughter's property sale" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
    expect(m.saveOH.mutateAsync).toHaveBeenCalledTimes(1);
    const payload = m.saveOH.mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({ kind: "advance_received", party: "Plot buyer", amount: 5_00_000, account_id: "a1", note: "Daughter's property sale" });
    expect(payload).not.toHaveProperty("owner_user_id");
    expect(payload).not.toHaveProperty("tenant_id");
  });

  it("refuses an amount of 0 under the field, nothing saved", async () => {
    render(<Banking />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Add entry/ })); });
    fireEvent.change(screen.getByLabelText("Received from (buyer)"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "0" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
    expect(screen.getByRole("alert").textContent).toMatch(/more than 0/);
    expect(m.saveOH.mutateAsync).not.toHaveBeenCalled();
  });

  it("advance: Convert into sale + Refund; held money: Hand over only; open total shown", () => {
    state.accounts = q([CASH]);
    state.oweHold = q([BYANA, HELD, DONE]);
    render(<Banking />);
    expect(screen.getAllByRole("button", { name: "Convert into sale" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Refund" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Hand over" })).toHaveLength(1); // the settled one has none
    expect(screen.getByText(/kept in Cash with Deepak \(held\)/)).toBeDefined();
    expect(hasRupees(5_50_000)).toBe(true); // open total: byana + held, not the settled one
  });

  it("Convert into sale settles the advance with the sale note", async () => {
    state.oweHold = q([BYANA]);
    render(<Banking />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Convert into sale" })); });
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Note") as HTMLInputElement).value).toBe("Advance became part of the sale price");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Convert into sale" })); });
    expect(m.settleOH.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      id: "o1", settled_how: "converted_to_sale", settle_note: "Advance became part of the sale price",
    }));
  });
});
