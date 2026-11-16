// @vitest-environment jsdom
//
// R-2683 (12 Nov 2026). Staging: 9 Zoho bills "Emp Prashant (Salary)" sit in "Unmapped — review";
// Pardeep decided they stay a Salary expense (Prashant is not in Payroll), but Edit expense hid
// Salaries. And saving Edit expense on an UNPAID row with only the category changed wrote
// "bank_transfer" as its payment method (list showed "bank_transfer · …").
//   given "Zoho row, unpaid, Edit → category Salaries → Save"
//   then  "saved as Salaries; payment method, GST split, amount stay as stored"
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const updateSpy = vi.fn(async (_: unknown) => ({}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/expenses", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/expenses")>();
  return {
    ...real,
    useCreateExpense: () => ({ mutateAsync: vi.fn() }),
    useUpdateExpense: () => ({ mutateAsync: updateSpy }),
    useExpenseDupList: () => ({ data: [] }),
    useCommissionToPayeeThisFy: () => ({ data: undefined }),
    useVendorTdsThisFy: () => ({ data: undefined }),
  };
});
vi.mock("@/lib/queries/marketing-campaigns", () => ({ useCampaignOptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
vi.mock("@/components/features/accounting/owner-pay-caution", () => ({ OwnerPayCautionBox: () => null }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import type { Expense } from "@/lib/queries/expenses";
import { keepUntouchedOnEdit, salariesOffered, SALARY_OUTSIDE_PAYROLL_HELP } from "./expense-form";
import { isPayrollExpense } from "./expense-badges";

/** An imported Zoho bill as import_zoho_fy_purchases writes it: unpaid, no method, items, GST split. */
const zohoRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "EXP-Z-abc-1", tenant_id: "t1", category: "Unmapped — review",
  vendor_name: "Emp Prashant (Salary)", vendor_id: null, expense_date: "2025-05-20", due_date: "2025-05-20",
  amount: 1180, gst_paid: 0, igst: null, cgst: null, sgst: null, bill_type: "none", bill_no: "B-12",
  paid: false, paid_date: null, payment_method: null, bank_account_id: null,
  description: "Salary May", notes: "Imported from Zoho Books (bill B-12).",
  line_items: [{ name: "Salary May", qty: 1, amount: 1180 }],
  tds_section: null, tds_amount: 0, rcm: false, rcm_tax: 0, currency: "INR", fx_rate: 1,
  project_id: null, channel: null, campaign_id: null, prepaid_advance_id: null, attachment_url: null,
  reconciled_txn_id: null, zoho_doc_id: "bills:123", zoho_leg: 1,
  ...over,
}) as unknown as Expense;

const handMade = (over: Partial<Record<string, unknown>> = {}) =>
  zohoRow({ id: "EXP-1", zoho_doc_id: null, zoho_leg: null, line_items: [], category: "Staff Welfare", notes: null, ...over });

const lineCategory = () => screen.getByLabelText("Category", { selector: "select" }) as HTMLSelectElement;
const save = () => fireEvent.submit(document.querySelector("form") as HTMLFormElement);
const lastPatch = () => (updateSpy.mock.calls.at(-1)?.[0] as { patch: Record<string, unknown> }).patch;

beforeEach(() => { updateSpy.mockClear(); });
afterEach(cleanup);

describe("R-2683 — Salaries for a Zoho-imported row", () => {
  it("offers Salaries with the help line on a Zoho row and saves it, nothing else changed", async () => {
    render(<AddExpenseDialog onClose={() => {}} expense={zohoRow()} />);
    const sel = lineCategory();
    expect([...sel.options].map((o) => o.value)).toContain("Salaries");
    fireEvent.change(sel, { target: { value: "Salaries" } });
    expect(screen.getByText(SALARY_OUTSIDE_PAYROLL_HELP)).toBeTruthy();
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPatch();
    expect(p.category).toBe("Salaries");
    expect(p.paid).toBe(false);
    expect(p.payment_method).toBeNull();
    expect(p.amount).toBe(1180);
    expect(p.expense_date).toBe("2025-05-20");
    expect(p.vendor_name).toBe("Emp Prashant (Salary)");
    expect(p.tds_amount).toBe(0);
  });

  it("a Zoho row already on Salaries keeps its items editor (can be moved back)", () => {
    render(<AddExpenseDialog onClose={() => {}} expense={zohoRow({ category: "Salaries" })} />);
    expect(lineCategory().value).toBe("Salaries");
  });

  it("a hand-made expense still does not offer Salaries", () => {
    render(<AddExpenseDialog onClose={() => {}} expense={handMade({ line_items: [{ name: "Cake", qty: 1, amount: 1180 }] })} />);
    expect([...lineCategory().options].map((o) => o.value)).not.toContain("Salaries");
  });
});

describe("R-2683 — Edit on an unpaid row writes no payment method", () => {
  it("hand-made unpaid row, saved with nothing changed → payment method stays empty, still unpaid", async () => {
    render(<AddExpenseDialog onClose={() => {}} expense={handMade()} />);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPatch();
    expect(p.category).toBe("Staff Welfare");
    expect(p.paid).toBe(false);
    expect(p.payment_method).toBeNull();
    expect(p.bank_account_id).toBeNull();
  });

  it("hand-made unpaid row (itemised): change only the category → payment method stays empty", async () => {
    render(<AddExpenseDialog onClose={() => {}} expense={handMade({ line_items: [{ name: "Cake", qty: 1, amount: 1180 }] })} />);
    fireEvent.change(lineCategory(), { target: { value: "Office Supplies" } });
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPatch();
    expect(p.category).toBe("Office Supplies");
    expect(p.paid).toBe(false);
    expect(p.payment_method).toBeNull();
    expect(p.bank_account_id).toBeNull();
  });

  it("Zoho row: GST split and amount (with GST Zoho could not claim) are kept", async () => {
    render(<AddExpenseDialog onClose={() => {}} expense={zohoRow({
      category: "Software", bill_type: "gst", amount: 1298, gst_paid: 180, igst: 180, cgst: 0, sgst: 0,
      line_items: [{ name: "Tool", qty: 1, amount: 1000 }],   // + 118 GST not claimable kept in cost
    })} />);
    fireEvent.change(lineCategory(), { target: { value: "Office Supplies" } });
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPatch();
    expect(p.category).toBe("Office Supplies");
    expect(p.igst).toBe(180);
    expect(p.cgst).toBe(0);
    expect(p.amount).toBe(1298);
    expect(p.gst_paid).toBe(180);
    expect(p.payment_method).toBeNull();
  });
});

describe("R-2683 — pure helpers", () => {
  it("salariesOffered: only Zoho rows or a row already on Salaries", () => {
    expect(salariesOffered(null)).toBe(false);
    expect(salariesOffered({ category: "Staff Welfare" })).toBe(false);
    expect(salariesOffered({ category: "Staff Welfare", zoho_doc_id: "  " })).toBe(false);
    expect(salariesOffered({ category: "Unmapped — review", zoho_doc_id: "bills:1" })).toBe(true);
    expect(salariesOffered({ category: "Salaries" })).toBe(true);
  });

  it("keepUntouchedOnEdit: a paid row keeps its paid date while the bill date is unchanged", () => {
    const stored = { paid: true, paid_date: "2025-06-02", expense_date: "2025-05-20", payment_method: "upi", gst_paid: 0, bill_type: "none" };
    const p = keepUntouchedOnEdit(stored, { paid: true, paid_date: "2025-05-20", expense_date: "2025-05-20", payment_method: "upi", gst_paid: 0, bill_type: "none" }, { gstHeadsFromBill: false, itemised: false });
    expect(p.paid_date).toBe("2025-06-02");
    const moved = keepUntouchedOnEdit(stored, { paid: true, paid_date: "2025-05-21", expense_date: "2025-05-21", gst_paid: 0, bill_type: "none" }, { gstHeadsFromBill: false, itemised: false });
    expect(moved.paid_date).toBe("2025-05-21");
  });

  it("keepUntouchedOnEdit: a newly read bill's GST split, or changed GST, is not overwritten", () => {
    const stored = { igst: 180, cgst: 0, sgst: 0, gst_paid: 180, bill_type: "gst" };
    expect(keepUntouchedOnEdit(stored, { igst: null, cgst: 90, sgst: 90, gst_paid: 180, bill_type: "gst" }, { gstHeadsFromBill: true, itemised: false }).cgst).toBe(90);
    expect(keepUntouchedOnEdit(stored, { igst: null, cgst: null, sgst: null, gst_paid: 200, bill_type: "gst" }, { gstHeadsFromBill: false, itemised: false }).igst).toBeNull();
  });

  it("isPayrollExpense: a Zoho bill on Salaries is a bill (opens, can be paid); a Payroll one is not", () => {
    expect(isPayrollExpense({ category: "Salaries", zoho_doc_id: "bills:1" })).toBe(false);
    expect(isPayrollExpense({ category: "Salaries", payment_method: "payroll" })).toBe(true);
    expect(isPayrollExpense({ category: "Salaries" })).toBe(true);
  });

  it("keepUntouchedOnEdit (review F1): paid → unpaid clears the method and bank; staying unpaid keeps them", () => {
    const ctx = { gstHeadsFromBill: false, itemised: false };
    const flipped = keepUntouchedOnEdit({ paid: true, payment_method: "upi", bank_account_id: "B1" }, { paid: false, payment_method: "upi", bank_account_id: null }, ctx);
    expect(flipped.payment_method).toBeNull();
    expect(flipped.bank_account_id).toBeNull();
    const stays = keepUntouchedOnEdit({ paid: false, payment_method: "statutory", bank_account_id: null }, { paid: false, payment_method: "bank_transfer", bank_account_id: null }, ctx);
    expect(stays.payment_method).toBe("statutory");
  });

  it("keepUntouchedOnEdit (review F2): another vendor re-works the GST split even with the same GST total", () => {
    const ctx = { gstHeadsFromBill: false, itemised: false };
    const stored = { vendor_id: "V-DL", vendor_name: "Delhi Vendor", igst: 0, cgst: 90, sgst: 90, gst_paid: 180, bill_type: "gst" };
    const same = keepUntouchedOnEdit(stored, { vendor_id: "V-DL", vendor_name: " delhi vendor ", igst: null, cgst: null, sgst: null, gst_paid: 180, bill_type: "gst" }, ctx);
    expect([same.igst, same.cgst, same.sgst]).toEqual([0, 90, 90]);
    const other = keepUntouchedOnEdit(stored, { vendor_id: "V-MH", vendor_name: "Mumbai Vendor", igst: null, cgst: null, sgst: null, gst_paid: 180, bill_type: "gst" }, ctx);
    expect([other.igst, other.cgst, other.sgst]).toEqual([null, null, null]);
  });

  it("keepUntouchedOnEdit: a paid row's method is the user's (paying is a real change)", () => {
    const p = keepUntouchedOnEdit({ paid: false, payment_method: null }, { paid: true, payment_method: "upi" }, { gstHeadsFromBill: false, itemised: false });
    expect(p.payment_method).toBe("upi");
  });
});
