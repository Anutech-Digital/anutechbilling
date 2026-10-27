// @vitest-environment jsdom
//
// R-1729 (owner journey audit, 21 Oct 2026): "Add expense" opened with Amount as the 6th
// field (bill type → category → date → note → itemise → amount) and Category already set to
// "Hosting" — an entry that skipped it went into the wrong account. Owner's example:
//   given "Add expense khola"  →  owner sees "first field Amount, Category 'Select…'".
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
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { lastUsedCategory, moreNeeded } from "./expense-form";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";

const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const row = (category: string, vendor_name: string | null, expense_date: string) =>
  ({ id: `${category}-${expense_date}`, vendor_id: null, vendor_name, bill_no: null, expense_date, amount: 500, currency: "INR", category });

beforeEach(() => { createSpy.mockClear(); toastError.mockClear(); state.dup = []; });
afterEach(cleanup);

describe("Add expense — the owner's order (R-1729)", () => {
  it("opens on Amount first, then Date, Paid to, Category, then bill type", () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    const amount = el("amount"), date = el("expense_date"), payee = el("vendor_name"), category = el("category");
    for (const x of [amount, date, payee, category]) expect(x).toBeTruthy();
    const firstInput = document.querySelector("form input:not([type=hidden]):not([type=file]), form button[role=combobox]");
    expect(firstInput).toBe(amount);
    expect(before(amount, date)).toBe(true);
    expect(before(date, payee)).toBe(true);
    expect(before(payee, category)).toBe(true);
    expect(before(category, screen.getByRole("button", { name: "GST invoice" }))).toBe(true);
  });

  it("Category starts empty ('Select…') — never 'Hosting'", () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    expect(el("category").textContent).toMatch(/Select…/);
    expect(el("category").textContent).not.toMatch(/Hosting/);
  });

  it("saving without a category stops with a message and saves nothing", async () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    fireEvent.change(el("amount"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("suggests the last-used category; one click picks it and the expense saves with it", async () => {
    state.dup = [row("Office Rent", "Landlord", "2026-10-20"), row("Software", "Anthropic", "2026-10-01")];
    render(<AddExpenseDialog onClose={() => {}} />);
    expect(el("category").textContent).toMatch(/Select…/);   // suggested, not pre-picked
    fireEvent.click(screen.getByRole("button", { name: /Use last: Office Rent/ }));
    expect(el("category").textContent).toMatch(/Office Rent/);
    fireEvent.change(el("amount"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const calls = createSpy.mock.calls as unknown as [{ category: string; amount: number; bill_type: string }][];
    expect(calls[0][0]).toMatchObject({ category: "Office Rent", amount: 500, bill_type: "none" });
  });

  it("GST, TDS and reverse charge sit under More — closed for a no-bill entry, open on GST invoice", () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    const more = screen.getByRole("button", { name: /More/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(el("tds_section")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "GST invoice" }));
    expect(screen.getByRole("button", { name: /More/ }).getAttribute("aria-expanded")).toBe("true");
    expect(el("gst_paid")).toBeTruthy();
    expect(el("tds_section")).toBeTruthy();
  });

  it("an edited expense that carries TDS opens with More open — a recorded TDS is never hidden", () => {
    const expense = {
      id: "e1", expense_date: "2026-10-10", category: "Professional Services", vendor_name: "CA Firm",
      amount: 10000, gst_paid: 0, currency: "INR", fx_rate: 1, bill_type: "kaccha", payment_method: "bank_transfer",
      tds_section: "194J", tds_amount: 1000, paid: true, line_items: [], rcm: false,
    };
    render(<AddExpenseDialog onClose={() => {}} expense={expense as never} />);
    expect(el("tds_section")).toBeTruthy();
    expect(el("category").textContent).toMatch(/Professional Services/);
  });
});

describe("Expenses page heading = breadcrumb (R-1729)", () => {
  it("the eyebrow over 'Expenses' is the breadcrumb head, not a second name", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getCrumb } = await import("@/lib/nav");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/expenses/page.tsx"), "utf8");
    const eyebrow = src.match(/font-semibold mb-1">([^<]+)<\/p>\s*<h1[^>]*>Expenses<\/h1>/)?.[1];
    expect(eyebrow).toBe(getCrumb("/accounting/expenses")[0]);
  });
});

describe("lastUsedCategory / moreNeeded (R-1729)", () => {
  const rows = [row("Office Rent", "Landlord", "2026-10-20"), row("Salaries", null, "2026-10-19"), row("Software", "Anthropic", "2026-10-01")];
  it("prefers the payee's own last category, else the newest one", () => {
    expect(lastUsedCategory(rows, EXPENSE_CATEGORIES, "anthropic ")).toBe("Software");
    expect(lastUsedCategory(rows, EXPENSE_CATEGORIES, "New Vendor")).toBe("Office Rent");
    expect(lastUsedCategory(rows, EXPENSE_CATEGORIES)).toBe("Office Rent");
  });
  it("never suggests Salaries or an unknown name; nothing when there is no history", () => {
    expect(lastUsedCategory([row("Salaries", null, "2026-10-19"), row("Old Name", null, "2026-10-18")], EXPENSE_CATEGORIES)).toBeNull();
    expect(lastUsedCategory([], EXPENSE_CATEGORIES)).toBeNull();
    expect(lastUsedCategory(undefined, EXPENSE_CATEGORIES)).toBeNull();
  });
  it("More is needed for a GST invoice, reverse charge, a foreign bill or TDS", () => {
    expect(moreNeeded({ billType: "none", rcm: false, tdsSection: "", foreign: false })).toBe(false);
    expect(moreNeeded({ billType: "gst", rcm: false, foreign: false })).toBe(true);
    expect(moreNeeded({ billType: "kaccha", rcm: true, foreign: false })).toBe(true);
    expect(moreNeeded({ billType: "none", rcm: false, tdsSection: "194C", foreign: false })).toBe(true);
  });
});
