// @vitest-environment jsdom
//
// R-2392 — Private Vault → People. Owner's case: Ramesh lent me ₹2,00,000 (₹50,000 paid
// back), I lent him ₹30,000, and he paid a ₹1,00,000 byana for the plot → "I owe them"
// ₹2,20,000, with each part shown; ₹1,000 received from and ₹700 paid to him.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const RAMESH = { id: "c1", name: "Ramesh", relation: "family", phone: "9810000000", email: null, pan: "ABCDE1234F", note: null, archived: false };
const ANITA = { id: "c2", name: "Anita", relation: "friend", phone: null, email: null, pan: null, note: null, archived: false };
const OLD = { id: "c3", name: "Old Friend", relation: "friend", phone: null, email: null, pan: null, note: null, archived: true };
const loan = (id: string, direction: string, principal: number, contact_id: string | null, status = "open") => ({
  id, direction, loan_kind: "person", party: "x", principal, start_date: "2026-10-01", annual_rate: null,
  repay_type: "no_interest", tenure_months: null, emi_amount: null, first_due_on: null, account_id: null,
  note: null, status, closed_on: status === "closed" ? "2026-10-20" : null, contact_id,
});

const state = {
  contacts: q<unknown[]>([RAMESH, ANITA, OLD]),
  loans: q<unknown[]>([loan("L1", "taken", 200000, "c1"), loan("L2", "given", 30000, "c1"), loan("L3", "given", 5000, "c2")]),
  payments: q<unknown[]>([{ id: "p1", loan_id: "L1", kind: "prepayment", paid_on: "2026-11-01", principal_part: 50000, interest_part: 0 }]),
  oweHold: q<unknown[]>([{ id: "o1", kind: "advance_received", party: "Ramesh", occurred_on: "2026-11-01", amount: 100000, note: "Plot byana", account_id: null, status: "open", settled_on: null, settled_how: null, settle_note: null, contact_id: "c1" }]),
  txs: q<unknown[]>([
    { id: "t1", kind: "other_income", income_source: "gift", category: null, amount: 1000, occurred_on: "2026-11-01", note: null },
    { id: "t2", kind: "expense", income_source: null, category: "Gifts", amount: 700, occurred_on: "2026-11-02", note: null },
  ]),
};
const mk = (v: unknown = undefined) => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(v), isPending: false });
const m = { save: mk({ id: "c9" }), archive: mk() };

vi.mock("@/lib/queries/personal-contacts", () => ({
  usePersonalContacts: () => state.contacts,
  useSavePersonalContact: () => m.save,
  useArchivePersonalContact: () => m.archive,
  usePersonalContactTransactions: (id: string | null) => (id === "c1" ? state.txs : q([])),
}));
vi.mock("@/lib/queries/personal-loans", () => ({
  usePersonalLoans: () => state.loans,
  usePersonalLoanPayments: () => state.payments,
}));
vi.mock("@/lib/queries/personal-owe-hold", () => ({ usePersonalOweHold: () => state.oweHold }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

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

import PeoplePage from "./page";

beforeEach(() => {
  state.contacts = q([RAMESH, ANITA, OLD]);
  for (const k of Object.values(m)) k.mutateAsync.mockClear();
});
afterEach(cleanup);

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, v: string) => fireEvent.change(el(id), { target: { value: v } });

describe("R-2392 People page", () => {
  it("the list shows each person's net; archived people are hidden", () => {
    render(<PeoplePage />);
    const list = screen.getByRole("list", { name: "People" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent?.split(/Family|Friend/)[0])).toEqual(["Anita", "Ramesh"]);
    expect(rows[0].textContent).toMatch(/They owe me.*5,000/);
    expect(rows[1].textContent).toMatch(/I owe them.*2,20,000/);
    expect(within(list).queryByText("Old Friend")).toBeNull();
  });

  it("Ramesh: I owe them ₹2,20,000 = lent 30k − borrowed 1.5L − byana 1L; income and paid totals", () => {
    render(<PeoplePage />);
    fireEvent.click(screen.getByRole("button", { name: /Ramesh/ }));
    const card = screen.getByRole("heading", { name: "Ramesh" }).closest("[aria-labelledby=person-name]") as HTMLElement;
    expect(card.textContent).toContain("PAN ABCDE1234F");
    expect(card.textContent).toMatch(/I owe them₹2,20,000/);
    expect(card.textContent).toMatch(/Lent to them₹30,000/);
    expect(card.textContent).toMatch(/Borrowed from them₹1,50,000/);
    expect(card.textContent).toMatch(/I owe \/ hold for them₹1,00,000/);
    expect(card.textContent).toMatch(/Received from them₹1,000/);
    expect(card.textContent).toMatch(/Paid to them₹700/);
    expect(card.textContent).toContain("Plot byana");
  });

  it("Add person: a duplicate name is refused under the form; a good one saves without owner fields", async () => {
    render(<PeoplePage />);
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const dlg = screen.getByRole("dialog");
    type("pc-name", "ramesh");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add person" })); });
    expect(m.save.mutateAsync).not.toHaveBeenCalled();
    expect(within(dlg).getByRole("alert").textContent).toMatch(/already in your people/);
    type("pc-name", "Suresh Uncle");
    type("pc-relation", "family");
    type("pc-pan", "abcde1234f");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Add person" })); });
    const sent = m.save.mutateAsync.mock.calls[0][0];
    expect(sent).toEqual({ id: undefined, name: "Suresh Uncle", relation: "family", phone: null, email: null, pan: "ABCDE1234F", note: null });
    expect(sent).not.toHaveProperty("owner_user_id");
  });

  it("Archive hides the person from the picker (one click, no delete)", async () => {
    render(<PeoplePage />);
    fireEvent.click(screen.getByRole("button", { name: /Ramesh/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Archive" })); });
    expect(m.archive.mutateAsync).toHaveBeenCalledWith({ id: "c1", archived: true });
  });

  it("no people yet → an empty state with Add person", () => {
    state.contacts = q([]);
    render(<PeoplePage />);
    expect(screen.getByText("No people yet")).toBeDefined();
    expect(screen.getByRole("button", { name: "Add person" })).toBeDefined();
  });
});
