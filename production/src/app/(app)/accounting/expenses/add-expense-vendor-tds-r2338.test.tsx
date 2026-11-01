// @vitest-environment jsdom
//
// R-2338 (owner + CA, 1 Nov 2026): Expenses pre-pick the vendor's own TDS section (set by the owner
// on the vendor) — 194J(a) technical services 2% for a Sidhshree-like vendor — and pick NOTHING for
// a vendor without one (the app never suggests a section the owner did not set).
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
const VENDORS = [
  { id: "v-sid", name: "Sidhshree Infotech", pan: "AAKFS2338A", gstin: null, default_tds_section: "194JA" },
  { id: "v-plain", name: "Plain Traders", pan: "AAKFP2338A", gstin: null, default_tds_section: null },
];
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: VENDORS }), ensureVendor: (v: Record<string, unknown>) => ensureVendorSpy(v) }));
const saveTdsSpy = vi.fn(async () => null);
vi.mock("@/lib/accounting/vendor-tds-section", () => ({ saveVendorTdsSection: (...a: unknown[]) => saveTdsSpy(...(a as [])) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";

const el = (id: string) => document.getElementById(id) as HTMLElement;

Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;

beforeEach(() => { createSpy.mockClear(); ensureVendorSpy.mockClear(); saveTdsSpy.mockClear(); state.dup = []; });
afterEach(cleanup);

function pickVendor(name: string) {
  const box = el("vendor_name");
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: name.slice(0, 5) } });
  fireEvent.mouseDown(screen.getByRole("button", { name: new RegExp(name) }));
}

describe("R-2338 expense — the vendor's TDS section is pre-picked, never invented", () => {
  it("Sidhshree-like vendor (saved 194J(a)) → TDS shows 194J(a) Technical services · 2%, no Remember offer", async () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    pickVendor("Sidhshree Infotech");
    await waitFor(() => expect(el("tds_section")?.textContent ?? "").toContain("194J(a) Technical services · 2%"));
    expect(screen.queryByLabelText("Remember for this vendor")).toBeNull();
  });

  it("a vendor with no saved section → no TDS section is picked", async () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    pickVendor("Plain Traders");
    await new Promise((r) => setTimeout(r, 50));
    const trig = el("tds_section");
    expect(trig === null || /No TDS/.test(trig.textContent ?? "")).toBe(true);
    expect(saveTdsSpy).not.toHaveBeenCalled();
  });
});
