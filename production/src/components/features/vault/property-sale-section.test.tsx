// @vitest-environment jsdom
//
// R-2393 — Pardeep's path: Wealth → property → Sell → byana ₹5 L in cash (warning) →
// registry ₹60 L → TDS 1% shown, capital-gains estimate shown, property out of net worth.
//  1. Wealth: a real-estate holding has "Sell"; a mutual fund does not. A sold property shows
//     "Sold <date>" and is out of the totals.
//  2. New sale: buyer + agreed price → saved with the holding id, cost defaults to invested.
//  3. Byana ₹5 L in cash → the cash warning (s.269SS / 269ST) shows before saving; the RPC is
//     called with the amount and mode. An open R-2386 advance can be MOVED in instead.
//  4. Registry pre-fills TDS 1% (₹60,000 on ₹60 L) and the remaining payment.
//  5. Capital-gains estimate: long term, 12.5% and 20%-indexed lines, "Confirm with your CA".
//  6. Overview: money received on an open deal is owed (I owe / hold for others).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = {
  accounts: q<unknown[]>([]),
  holdings: q<unknown[]>([]),
  oweHold: q<unknown[]>([]),
  sales: q<{ sales: unknown[]; receipts: unknown[] }>({ sales: [], receipts: [] }),
};
const mk = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
const m = { saveDeal: mk(), addReceipt: mk(), delReceipt: mk(), register: mk(), cancel: mk(), delDeal: mk(), other: mk() };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalHoldings: () => state.holdings,
  usePersonalTransactions: () => q([]),
  useSavePersonalHolding: () => m.other,
  useDeletePersonalHolding: () => m.other,
  usePinStatus: () => q({ configured: false }),
  useSetPin: () => m.other,
  useRemovePin: () => m.other,
  useVerifyPin: () => m.other,
}));
vi.mock("@/lib/queries/personal-owe-hold", () => ({ usePersonalOweHold: () => state.oweHold }));
vi.mock("@/lib/queries/personal-loans", () => ({
  usePersonalLoans: () => q([]),
  usePersonalLoanPayments: () => q([]),
}));
vi.mock("@/lib/queries/personal-contacts", () => ({ usePersonalContacts: () => q([]) }));
vi.mock("@/lib/queries/personal-property-sales", () => ({
  usePersonalPropertySales: () => state.sales,
  useSavePersonalPropertySale: () => m.saveDeal,
  useDeletePersonalPropertySale: () => m.delDeal,
  useAddPropertySaleReceipt: () => m.addReceipt,
  useDeletePropertySaleReceipt: () => m.delReceipt,
  useRegisterPropertySale: () => m.register,
  useCancelPropertySale: () => m.cancel,
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/features/vault/person-picker", async () => {
  const R = await import("react");
  return {
    PersonPicker: ({ id, value, onChange }: { id?: string; value: { contactId: string | null; name: string }; onChange: (v: { contactId: string | null; name: string }) => void }) =>
      R.createElement("input", { id, value: value.name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ contactId: null, name: e.target.value }) }),
  };
});
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

import Wealth from "@/app/(app)/vault/personal/wealth/page";
import Overview from "@/app/(app)/vault/personal/page";

const FLAT = { id: "h1", asset_class: "real_estate", name: "Daughter flat", invested: 25_00_000, current_value: 60_00_000, units: null, valued_on: "2026-10-01", notes: null, sold_on: null };
const MF = { id: "h2", asset_class: "mutual_fund", name: "PPFAS", invested: 1_00_000, current_value: 1_20_000, units: null, valued_on: "2026-10-01", notes: null };
const CASH = { id: "a1", kind: "cash", label: "Cash with brother", balance: 5_00_000, is_active: true };
const SALE = {
  id: "s1", holding_id: "h1", seller_contact_id: null, contact_id: null, party: "Buyer Ram",
  agreement_date: "2026-10-01", agreed_price: 60_00_000, stamp_value: null, acquired_on: "2015-06-10",
  cost_of_acquisition: 25_00_000, improvement_cost: 0, transfer_expenses: 0, status: "agreement",
  registry_date: null, tds_deducted: 0, cancelled_on: null, refunded: 0, forfeited: 0, note: null,
};
const BYANA = { id: "r1", sale_id: "s1", kind: "byana", received_on: "2026-10-01", amount: 5_00_000, mode: "cash", account_id: "a1", owe_hold_id: null, tx_id: null, note: null };

beforeEach(() => {
  state.accounts = q([CASH]); state.holdings = q([FLAT, MF]); state.oweHold = q([]);
  state.sales = q({ sales: [], receipts: [] });
  for (const k of Object.values(m)) k.mutateAsync.mockClear();
  for (const t of Object.values(toastMock)) t.mockClear();
});
afterEach(() => cleanup());

const change = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });

describe("R-2393 Wealth → Sell", () => {
  it("a property has Sell; a mutual fund does not", () => {
    render(<Wealth />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByRole("button", { name: "Sell" })).toBeDefined();
    expect(within(rows[1]).queryByRole("button", { name: "Sell" })).toBeNull();
  });

  it("new sale: buyer + agreed price saved for the holding; cost defaults to the amount invested", async () => {
    render(<Wealth />);
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(screen.getByText("Sell Daughter flat")).toBeDefined();
    expect((document.getElementById("ps-cost") as HTMLInputElement).value).toBe("2500000");
    change("ps-buyer", "Buyer Ram");
    change("ps-price", "6000000");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start sale" })); });
    expect(m.saveDeal.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      holding_id: "h1", party: "Buyer Ram", agreed_price: 60_00_000, cost_of_acquisition: 25_00_000, seller_contact_id: null,
    }));
  });

  it("no buyer → a clear error, nothing saved", async () => {
    render(<Wealth />);
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    change("ps-price", "6000000");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start sale" })); });
    expect(toastMock.error).toHaveBeenCalledWith("Pick the buyer", expect.anything());
    expect(m.saveDeal.mutateAsync).not.toHaveBeenCalled();
  });

  it("byana ₹5 L in cash shows the s.269SS / 269ST warning, then adds the payment", async () => {
    state.sales = q({ sales: [SALE], receipts: [] });
    m.addReceipt.mutateAsync.mockResolvedValueOnce({ receipt_id: "r1", received_total: 5_00_000, cash_warning: true });
    render(<Wealth />);
    fireEvent.click(screen.getByRole("button", { name: "Sale deal" }));
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    change("ps-pay-amount", "500000");
    change("ps-pay-mode", "cash");
    expect(screen.getByRole("alert").textContent).toContain("269SS");
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Add payment" }).at(-1)!); });
    expect(m.addReceipt.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      sale_id: "s1", kind: "byana", amount: 5_00_000, mode: "cash", owe_hold_id: null,
    }));
    expect(toastMock.warning).toHaveBeenCalled();
  });

  it("an open R-2386 advance is offered and moved in (no amount typed)", async () => {
    state.sales = q({ sales: [SALE], receipts: [] });
    state.oweHold = q([{ id: "o1", kind: "advance_received", party: "Buyer Ram", occurred_on: "2026-10-01", amount: 5_00_000, status: "open", account_id: "a1" }]);
    render(<Wealth />);
    fireEvent.click(screen.getByRole("button", { name: "Sale deal" }));
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    expect((document.getElementById("ps-pay-hold") as HTMLSelectElement).value).toBe("o1");
    expect(document.getElementById("ps-pay-amount")).toBeNull();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Add payment" }).at(-1)!); });
    expect(m.addReceipt.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ owe_hold_id: "o1", amount: null }));
  });

  it("registry pre-fills TDS 1% (₹60,000 on ₹60 L) and the rest of the price; capital gains estimate shows", async () => {
    state.sales = q({ sales: [SALE], receipts: [BYANA] });
    render(<Wealth />);
    fireEvent.click(screen.getByRole("button", { name: "Sale deal" }));
    expect(screen.getByText("TDS 194-IA (1%)")).toBeDefined();
    expect(screen.getByText("Cash ₹20,000+ — ask your CA")).toBeDefined();
    expect(screen.getByText("Capital gains — estimate")).toBeDefined();
    expect(screen.getByText("Confirm with your CA")).toBeDefined();
    expect(screen.getByText(/Tax at 12.5% without indexation/)).toBeDefined();
    // Sold today (FY 2026-27 or later): its Cost Inflation Index is not notified in the app yet — said, not guessed.
    expect(screen.getByText(/20% with indexation: Cost Inflation Index for FY /)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Record registry" }));
    expect((document.getElementById("ps-reg-tds") as HTMLInputElement).value).toBe("60000");
    expect((document.getElementById("ps-reg-final") as HTMLInputElement).value).toBe(String(60_00_000 - 5_00_000 - 60_000));
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Record registry" }).at(-1)!); });
    expect(m.register.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ sale_id: "s1", tds_deducted: 60_000, final_amount: 54_40_000 }));
  });

  it("a sold property shows 'Sold' and is out of the totals", () => {
    state.holdings = q([{ ...FLAT, sold_on: "2026-11-02" }, MF]);
    state.sales = q({ sales: [{ ...SALE, status: "registered", registry_date: "2026-11-02", tds_deducted: 60_000 }], receipts: [BYANA] });
    render(<Wealth />);
    expect(screen.getByText(/Sold/)).toBeDefined();
    const current = screen.getByText("Current value").parentElement!;
    expect(within(current).getAllByText(/₹/)[0].textContent?.replace(/[^0-9]/g, "")).toBe("120000");
  });
});

describe("R-2393 Overview — open deal money is owed to the buyer", () => {
  it("₹5 L byana received on an open deal does not raise net worth", () => {
    state.holdings = q([FLAT]);
    state.sales = q({ sales: [SALE], receipts: [BYANA] });
    render(<Overview />);
    const net = screen.getByText("Net worth").parentElement!;
    // cash 5 L + flat 60 L − owed 5 L = 60 L
    expect(within(net).getAllByText(/₹/)[0].textContent?.replace(/[^0-9]/g, "")).toBe("6000000");
  });
});
