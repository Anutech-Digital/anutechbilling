// @vitest-environment jsdom
//
// R-2392 — the owner's path from the card (3 Nov screenshot): Loans → Add loan → Type
// "From a person" → the box is "Person" and opens the contact list; pick Ramesh, or
// "+ New contact" adds a new person and picks them. The loan is saved with contact_id and
// party = the name. A bank loan keeps a typed Lender with past lenders as suggestions.
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const RAMESH = { id: "c1", name: "Ramesh", relation: "family", phone: "9810000000", email: null, pan: null, note: null, archived: false };
const OLD = { id: "c2", name: "Old Friend", relation: "friend", phone: null, email: null, pan: null, note: null, archived: true };
const HOME = {
  id: "l1", direction: "taken", loan_kind: "home", party: "SBI Home Loan", principal: 20_00_000, start_date: "2026-04-01",
  annual_rate: 8.5, repay_type: "emi", tenure_months: 240, emi_amount: 17_356, first_due_on: null, account_id: null,
  note: null, status: "open", closed_on: null, contact_id: null,
};

const state = { loans: q<unknown[]>([]), contacts: q<unknown[]>([RAMESH, OLD]) };
const mk = (v: unknown = undefined) => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(v), isPending: false });
const m = { saveLoan: mk(), saveContact: mk({ ...RAMESH, id: "c9", name: "Suresh Uncle" }), other: mk() };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => q([]),
  usePinStatus: () => q({ configured: false }),
  useSetPin: () => m.other, useRemovePin: () => m.other, useVerifyPin: () => m.other,
}));
vi.mock("@/lib/queries/personal-loans", () => ({
  usePersonalLoans: () => state.loans,
  usePersonalLoanPayments: () => q([]),
  useSavePersonalLoan: () => m.saveLoan,
  useSetLoanStatus: () => m.other,
  useDeletePersonalLoan: () => m.other,
  useRecordLoanPayment: () => m.other,
  useUndoLoanPayment: () => m.other,
}));
vi.mock("@/lib/queries/personal-contacts", () => ({
  usePersonalContacts: () => state.contacts,
  useSavePersonalContact: () => m.saveContact,
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

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

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => {
  state.loans = q([]);
  for (const k of Object.values(m)) k.mutateAsync.mockClear();
  window.history.replaceState(null, "", "/vault/personal/loans");
});
afterEach(cleanup);

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, v: string) => fireEvent.change(el(id), { target: { value: v } });
const label = (forId: string) => document.querySelector(`label[for="${forId}"]`)?.textContent;

function openAddLoanFromPerson() {
  render(<LoansPage />);
  fireEvent.click(screen.getAllByRole("button", { name: "Add loan" })[0]);
  type("ln-kind", "person");
}

describe("R-2392 Loans → From a person picks from your People", () => {
  it("From a person → the box is 'Person' and opens the contact list (archived left out)", () => {
    openAddLoanFromPerson();
    expect(label("ln-party")).toBe("Person");
    fireEvent.click(el("ln-party"));
    const list = screen.getByRole("listbox", { name: "Your people" });
    expect(within(list).getByRole("option", { name: /Ramesh/ })).toBeDefined();
    expect(within(list).queryByRole("option", { name: /Old Friend/ })).toBeNull();
  });

  it("pick Ramesh → saved with contact_id and party = Ramesh", async () => {
    openAddLoanFromPerson();
    fireEvent.click(el("ln-party"));
    fireEvent.click(screen.getByRole("option", { name: /Ramesh/ }));
    type("ln-principal", "200000");
    type("ln-repay", "no_interest");
    const dlg = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add loan" })); });
    expect(m.saveLoan.mutateAsync).toHaveBeenCalledTimes(1);
    expect(m.saveLoan.mutateAsync.mock.calls[0][0]).toMatchObject({
      direction: "taken", loan_kind: "person", party: "Ramesh", contact_id: "c1", principal: 200000,
    });
  });

  it("+ New contact adds the typed person to People and picks them", async () => {
    openAddLoanFromPerson();
    fireEvent.click(el("ln-party"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search your people" }), { target: { value: "Suresh Uncle" } });
    // no "use as text" for a loan from a person — it must be one of your People
    expect(screen.queryByRole("option", { name: /without adding/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: '+ New contact "Suresh Uncle"' })); });
    expect(m.saveContact.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: "Suresh Uncle" }));
    expect(el("ln-party").textContent).toContain("Suresh Uncle");
    type("ln-principal", "50000");
    type("ln-repay", "no_interest");
    const dlg = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add loan" })); });
    expect(m.saveLoan.mutateAsync.mock.calls[0][0]).toMatchObject({ party: "Suresh Uncle", contact_id: "c9" });
  });

  it("no person picked → refused with a plain message, nothing saved", async () => {
    openAddLoanFromPerson();
    type("ln-principal", "50000");
    type("ln-repay", "no_interest");
    const dlg = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add loan" })); });
    expect(m.saveLoan.mutateAsync).not.toHaveBeenCalled();
    expect(within(dlg).getByRole("alert").textContent).toMatch(/Pick the person you borrowed from/);
  });

  it("a bank loan keeps a typed Lender, with past lenders as suggestions, and no contact", async () => {
    state.loans = q([HOME]);
    render(<LoansPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add loan" })[0]);
    expect(label("ln-party")).toBe("Lender");
    const box = el("ln-party");
    expect(box.tagName).toBe("INPUT");
    const list = document.getElementById(box.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["SBI Home Loan"]);
  });
});
