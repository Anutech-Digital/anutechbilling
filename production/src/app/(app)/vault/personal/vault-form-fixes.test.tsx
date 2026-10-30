// @vitest-environment jsdom
//
// R-2111 (GP-02a) — the vault forms' small holes, each pinned by the owner's real path:
//  1. A 25-digit or negative amount must stop in the form (inline error), never reach the DB
//     as "1e+24" / "-5" and come back as a Postgres error.
//  2. An owner who has only added an expense must see the FY card on the Overview, not
//     "Your vault is empty".
//  3. "Today" in the date fields is the IST day, not the browser's — a laptop on another
//     timezone used to pre-fill yesterday.
//  4. A closed account is not offered in the expense's account picker (an old entry linked to
//     it still shows its name when edited).
//  5. A failed delete does not leave an unhandled promise rejection or a false "removed" toast.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = {
  accounts: q<unknown[]>([]),
  holdings: q<unknown[]>([]),
  transactions: q<unknown[]>([]),
};

const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
const m = {
  saveAccount: mk(), delAccount: mk(),
  saveTx: mk(), delTx: mk(),
  saveHolding: mk(), delHolding: mk(),
  other: mk(),
};

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalHoldings: () => state.holdings,
  usePersonalTransactions: () => state.transactions,
  useSavePersonalAccount: () => m.saveAccount,
  useDeletePersonalAccount: () => m.delAccount,
  useSavePersonalTransaction: () => m.saveTx,
  useDeletePersonalTransaction: () => m.delTx,
  useSavePersonalHolding: () => m.saveHolding,
  useDeletePersonalHolding: () => m.delHolding,
  usePinStatus: () => q<{ isSet: boolean }>({ isSet: false }),
  useSetPin: () => m.other,
  useRemovePin: () => m.other,
  useVerifyPin: () => m.other,
}));

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

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

import Overview from "./page";
import Banking from "./banking/page";
import Expenses from "./expenses/page";
import Wealth from "./wealth/page";

const SAVINGS = { id: "a1", kind: "savings", label: "HDFC Salary", institution: "HDFC", account_last4: "4321", balance: 8_50_000, is_active: true, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };
const CLOSED = { id: "a4", kind: "savings", label: "Old Axis", institution: null, account_last4: null, balance: 0, is_active: false, credit_limit: null, interest_rate: null, maturity_date: null, notes: null };
const GROCERIES = { id: "t3", kind: "expense", amount: 4_000, occurred_on: "2026-08-05", category: "Groceries", account_id: null, note: null };
const PETROL = { id: "t5", kind: "expense", amount: 2_000, occurred_on: "2026-08-06", category: null, account_id: null, note: null };
const RENT = { id: "t6", kind: "expense", amount: 25_000, occurred_on: "2026-08-01", category: null, account_id: null, note: null };
const ON_CLOSED = { id: "t7", kind: "expense", amount: 1_500, occurred_on: "2026-07-01", category: null, account_id: "a4", note: null };

const realTZ = process.env.TZ;
let unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => { unhandled.push(r); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-19T06:00:00Z"));
  state.accounts = q([]);
  state.holdings = q([]);
  state.transactions = q([]);
  for (const k of Object.keys(m) as (keyof typeof m)[]) m[k] = mk();
  for (const fn of Object.values(toastMock)) fn.mockClear();
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.off("unhandledRejection", onUnhandled);
  if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ;
});

const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
const click = async (name: RegExp | string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };

describe("R-2111 amounts are checked before any DB call", () => {
  for (const bad of ["-5", "1".repeat(25)]) {
    it(`Banking refuses balance ${bad.length > 5 ? "25 digits" : bad} with an inline error`, async () => {
      render(<Banking />);
      await click(/Add first account/);
      type("vb-name", "HDFC Salary");
      type("vb-balance", bad);
      await click(/^Add$/);
      expect(m.saveAccount.mutateAsync).not.toHaveBeenCalled();
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(bad.startsWith("-") ? /minus|digits/i : /too large/i);
      expect(document.getElementById("vb-balance")!.getAttribute("aria-invalid")).toBe("true");
    });

    it(`Expenses refuses amount ${bad.length > 5 ? "25 digits" : bad} with an inline error`, async () => {
      render(<Expenses />);
      await click(/Add first entry/);
      type("ve-amount", bad);
      await click(/^Add$/);
      expect(m.saveTx.mutateAsync).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toMatch(bad.startsWith("-") ? /minus|digits/i : /too large/i);
    });
  }

  it("Banking credit limit of 25 digits is refused too", async () => {
    render(<Banking />);
    await click(/Add first account/);
    type("vb-name", "ICICI card");
    fireEvent.change(document.getElementById("vb-type")!, { target: { value: "credit_card" } });
    type("vb-credit-limit", "9".repeat(25));
    await click(/^Add$/);
    expect(m.saveAccount.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/too large/i);
  });

  it("a good amount still saves as whole rupees", async () => {
    render(<Expenses />);
    await click(/Add first entry/);
    type("ve-amount", "1,250");
    await click(/^Add$/);
    expect(m.saveTx.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ amount: 1250 }));
  });
});

describe("R-2111 Overview counts transactions", () => {
  it("0 accounts + 3 transactions shows the FY card, not the empty vault", () => {
    state.transactions = q([GROCERIES, PETROL, RENT]);
    render(<Overview />);
    expect(screen.queryByText(/Your vault is empty/)).toBeNull();
    expect(screen.getByText(/This financial year/)).toBeDefined();
  });
});

describe("R-2111 today is the IST day", () => {
  // 03:00 UTC on 20 Aug = 08:30 IST on 20 Aug, but still 19 Aug on a Los Angeles laptop.
  beforeEach(() => {
    process.env.TZ = "America/Los_Angeles";
    vi.setSystemTime(new Date("2026-08-20T03:00:00Z"));
  });

  it("Expenses pre-fills the IST date", async () => {
    render(<Expenses />);
    await click(/Add first entry/);
    expect((document.getElementById("ve-date") as HTMLInputElement).value).toBe("2026-08-20");
  });

  it("Wealth pre-fills the IST date", async () => {
    render(<Wealth />);
    await click(/Add first investment/);
    expect((document.getElementById("vw-value-date") as HTMLInputElement).value).toBe("2026-08-20");
  });
});

describe("R-2111 closed accounts are not offered", () => {
  it("a new expense's picker leaves the closed account out", async () => {
    state.accounts = q([SAVINGS, CLOSED]);
    render(<Expenses />);
    await click(/Add first entry/);
    const opts = Array.from((document.getElementById("ve-account") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opts).toContain("HDFC Salary");
    expect(opts).not.toContain("Old Axis");
  });

  it("an old entry linked to a closed account still shows that account when edited", async () => {
    state.accounts = q([SAVINGS, CLOSED]);
    state.transactions = q([ON_CLOSED]);
    render(<Expenses />);
    await click("Edit");
    const sel = document.getElementById("ve-account") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toContain("Old Axis");
    expect(sel.value).toBe("a4");
  });
});

describe("R-2111 a failed delete is caught", () => {
  it("Banking: no unhandled rejection, no false 'removed' toast", async () => {
    state.accounts = q([SAVINGS]);
    m.delAccount.mutateAsync = vi.fn().mockRejectedValue(new Error("RLS said no"));
    render(<Banking />);
    await click("Delete");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(m.delAccount.mutateAsync).toHaveBeenCalledWith("a1");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("Expenses: no unhandled rejection, no false 'removed' toast", async () => {
    state.transactions = q([GROCERIES]);
    m.delTx.mutateAsync = vi.fn().mockRejectedValue(new Error("network"));
    render(<Expenses />);
    await click("Delete");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(m.delTx.mutateAsync).toHaveBeenCalledWith("t3");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
