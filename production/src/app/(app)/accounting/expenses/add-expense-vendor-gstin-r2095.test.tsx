// @vitest-environment jsdom
//
// R-2095 (staging, 30 Oct 2026): a NEW vendor made from an expense (GST invoice) had no GSTIN until
// edited on the Vendors page. The form asks for it and the vendor gets it (state from the GSTIN).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createSpy = vi.fn(async () => ({}));
const toastError = vi.fn();
const state: { dup: { id: string; vendor_id: string | null; vendor_name: string | null; bill_no: string | null; expense_date: string; amount: number; currency: string; category: string }[] } = { dup: [] };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock("@/lib/queries/expenses", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/expenses")>();
  return {
    ...real,
    useCreateExpense: () => ({ mutateAsync: createSpy }),
    useUpdateExpense: () => ({ mutateAsync: vi.fn() }),
    useExpenseDupList: () => ({ data: state.dup }),
    useCommissionToPayeeThisFy: () => ({ data: undefined }),
    useVendorTdsThisFy: () => ({ data: undefined }),
  };
});
vi.mock("@/lib/queries/marketing-campaigns", () => ({ useCampaignOptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
/* R-1846: the owner-salary caution reads the business type / partners — not part of these tests. */
vi.mock("@/components/features/accounting/owner-pay-caution", () => ({ OwnerPayCautionBox: () => null }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
const ensureVendorSpy = vi.fn(async (_v: Record<string, unknown>) => "v-1");
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: (v: Record<string, unknown>) => ensureVendorSpy(v) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";

const el = (id: string) => document.getElementById(id) as HTMLElement;

/* Radix Select scrolls the picked option into view — jsdom has no scrollIntoView. */
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;

beforeEach(() => { createSpy.mockClear(); ensureVendorSpy.mockClear(); state.dup = []; });
afterEach(cleanup);

describe("R-2095 expense — GSTIN on a new vendor", () => {
  it("a new GST-invoice payee asks the GSTIN, names the state, and saves it on the vendor", async () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "GST invoice" }));
    fireEvent.change(el("amount"), { target: { value: "1180" } });
    fireEvent.change(el("vendor_name"), { target: { value: "Acme Hosting LLP" } });
    const g = await waitFor(() => { const x = el("new_vendor_gstin") as HTMLInputElement; expect(x).toBeTruthy(); return x; });
    fireEvent.change(g, { target: { value: "27aaacn1234f1z5" } });
    expect(screen.getByText(/State: Maharashtra/)).toBeTruthy();
    fireEvent.change(el("gst_paid"), { target: { value: "180" } });
    /* "Hosting" in the payee picks the category by itself. */
    await waitFor(() => expect(el("category").textContent).toMatch(/Hosting/));
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(ensureVendorSpy).toHaveBeenCalled());
    expect(ensureVendorSpy.mock.calls[0][0]).toMatchObject({ name: "Acme Hosting LLP", gstin: "27AAACN1234F1Z5" });
  });
});
