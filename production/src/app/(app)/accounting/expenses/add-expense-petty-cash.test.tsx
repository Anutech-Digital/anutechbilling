// @vitest-environment jsdom
//
// R-1834 (Pardeep, 24 Oct 2026): "company me ek petty cash account bhi default hona chahiye".
// Every company now has a Petty Cash account (migration 20261024101339). Picking "Cash" as how
// an expense was paid used to start on "Don't deduct from petty cash", so cash in hand never
// went down unless someone remembered to pick the account. Now Cash starts on the company's
// cash account (the only one, or the auto Petty Cash among several) — and can still be changed.
//
// The Radix Select is swapped for a native <select> carrying the trigger's id, so the test can
// pick "cash" the way the owner does (jsdom cannot open a Radix popover).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createSpy = vi.fn(async (_v: Record<string, unknown>) => ({}));
const markPaidSpy = vi.fn(async (_v: Record<string, unknown>) => ({}));
const state: { accounts: Record<string, unknown>[] } = { accounts: [] };

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
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup: SelectContent, SelectLabel: SelectValue, SelectSeparator: SelectValue };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/expenses", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/expenses")>();
  return {
    ...real,
    useCreateExpense: () => ({ mutateAsync: createSpy }),
    useUpdateExpense: () => ({ mutateAsync: vi.fn() }),
    useMarkExpensePaid: () => ({ mutateAsync: markPaidSpy, isPending: false }),
    useExpenseDupList: () => ({ data: [] }),
    useCommissionToPayeeThisFy: () => ({ data: undefined }),
    useVendorTdsThisFy: () => ({ data: undefined }),
  };
});
vi.mock("@/lib/queries/marketing-campaigns", () => ({ useCampaignOptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
/* R-1846: the owner-salary caution reads the business type / partners — not part of these tests. */
vi.mock("@/components/features/accounting/owner-pay-caution", () => ({ OwnerPayCautionBox: () => null }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: state.accounts }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { MarkPaidDialog } from "@/components/features/accounting/mark-paid-dialog";

const acct = (id: string, name: string, account_type: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, bank_name: account_type === "cash" ? "Cash in hand" : "HDFC Bank", account_type, is_active: true,
     opening_balance: 0, current_balance: 0, account_number_last4: null, ...extra });
const HDFC   = acct("11111111-1111-4111-8111-111111111111", "HDFC Current", "current");
const PETTY  = acct("22222222-2222-4222-8222-222222222222", "Petty Cash", "cash", { is_default_petty_cash: true });
const BRANCH = acct("33333333-3333-4333-8333-333333333333", "Branch cash box", "cash");

const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

async function saveCashExpense() {
  render(<AddExpenseDialog onClose={() => {}} />);
  fireEvent.change(input("amount"), { target: { value: "300" } });
  fireEvent.change(sel("category"), { target: { value: "Office Supplies" } });
  fireEvent.change(sel("payment_method"), { target: { value: "cash" } });
}

beforeEach(() => { createSpy.mockClear(); markPaidSpy.mockClear(); state.accounts = [HDFC, BRANCH, PETTY]; });
afterEach(cleanup);

describe("Add expense — Cash starts on Petty Cash (R-1834)", () => {
  it("picking Cash pre-selects the company's Petty Cash, and saving takes it off cash in hand", async () => {
    await saveCashExpense();
    expect(sel("petty_cash").value).toBe(PETTY.id);
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ payment_method: "cash", pettyCashAccountId: PETTY.id });
  });

  it("the owner can still change it — another cash box, or not deduct at all", async () => {
    await saveCashExpense();
    fireEvent.change(sel("petty_cash"), { target: { value: "none" } });
    expect(sel("petty_cash").value).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ payment_method: "cash", pettyCashAccountId: null });
  });

  it("a company with one hand-made cash account (no auto one) starts on that one", async () => {
    state.accounts = [HDFC, BRANCH];
    await saveCashExpense();
    expect(sel("petty_cash").value).toBe(BRANCH.id);
  });

  it("a bank payment never touches petty cash", async () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    expect(document.getElementById("petty_cash")).toBeNull();
  });
});

describe("Mark paid — Cash starts on Petty Cash (R-1834)", () => {
  const expense = { id: "e1", amount: 500, vendor_name: "Chai wala", description: null, payment_method: "cash" } as never;

  it("pre-selects Petty Cash and deducts from it", async () => {
    render(<MarkPaidDialog expense={expense} onClose={() => {}} />);
    expect(sel("paid_petty").value).toBe(PETTY.id);
    fireEvent.click(screen.getByRole("button", { name: /Mark .* paid/ }));
    await waitFor(() => expect(markPaidSpy).toHaveBeenCalled());
    expect(markPaidSpy.mock.calls[0][0]).toMatchObject({ payment_method: "cash", pettyCashAccountId: PETTY.id });
  });

  it("'Don't deduct' stays possible", async () => {
    render(<MarkPaidDialog expense={expense} onClose={() => {}} />);
    fireEvent.change(sel("paid_petty"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: /Mark .* paid/ }));
    await waitFor(() => expect(markPaidSpy).toHaveBeenCalled());
    expect(markPaidSpy.mock.calls[0][0]).toMatchObject({ pettyCashAccountId: null });
  });
});
