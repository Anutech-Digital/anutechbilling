// @vitest-environment jsdom
//
// R-1744 (Pardeep, 22 Oct 2026): "agar koi gst pdf bill de to sab kuch AI hi fill kare".
// Owner's examples (the AI read is mocked — /api/ai/extract-bill):
//   1. Google Cloud India GST invoice, ₹1,180 (₹1,000 + IGST ₹180), one line "Workspace Business
//      Starter" → after "Yes, fill it in": total ₹1,180 incl GST, vendor Google Cloud India
//      (existing), GSTIN, bill no, IGST 180, line category Software, note
//      "Google Cloud India — Workspace — Oct 2026".
//   2. AWS (US) bill $20, no GST → currency USD and a chip "Foreign vendor, no GST — reverse
//      charge?" — reverse charge NOT ticked.
//   (R-1767: a Workspace bill is read as COGS-Workspace, so the preview also offers "Record as COGS
//   bill"; "Add as expense anyway" is the same fill as "Yes, fill it in".)
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createSpy = vi.fn(async () => ({}));
const toastError = vi.fn();
const state: { vendors: { id: string; name: string; gstin: string | null }[] } = { vendors: [] };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock("@/lib/queries/expenses", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/expenses")>();
  return {
    ...real,
    useCreateExpense: () => ({ mutateAsync: createSpy }),
    useUpdateExpense: () => ({ mutateAsync: vi.fn() }),
    useExpenseDupList: () => ({ data: [] }),
    useCommissionToPayeeThisFy: () => ({ data: undefined }),
    useVendorTdsThisFy: () => ({ data: undefined }),
  };
});
vi.mock("@/lib/queries/marketing-campaigns", () => ({ useCampaignOptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: state.vendors }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn(async () => "bills/x.pdf") }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const mark = (field: string) => document.querySelector(`[data-ai-mark="${field}"]`);
const pdf = () => new File(["%PDF-1.4 bill"], "bill.pdf", { type: "application/pdf" });

const GOOGLE = {
  vendor_name: "Google Cloud India Pvt Ltd",
  vendor_gstin: "29AAGCG1234F1Z5",
  bill_no: "GCI-2026-1001",
  bill_date: "2026-10-05",
  currency: "INR",
  subtotal: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180,
  line_items: [{ description: "Workspace Business Starter", qty: 1, unit_price: 1000, amount: 1000, category: "Software" }],
  category_guess: "COGS-Workspace",
  expense_category: "Software",
  document_type: "tax_invoice",
  item_short: "Workspace",
  paid_status: "paid",
  payment_mode: "card",
};
const AWS = {
  vendor_name: "Amazon Web Services, Inc.", vendor_gstin: null, bill_no: "AWS-778", bill_date: "2026-10-02",
  currency: "USD", subtotal: 20, cgst: 0, sgst: 0, igst: 0, total: 20,
  line_items: [{ description: "Amazon EC2", qty: null, unit_price: null, amount: 20 }],
  expense_category: "Hosting", item_short: "EC2", paid_status: null, payment_mode: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
function answer(status: number, body: unknown) {
  fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
}
async function uploadAndConfirm() {
  fireEvent.change(el("bill-file"), { target: { files: [pdf()] } });
  const yes = await screen.findByRole("button", { name: /Yes, fill it in|Add as expense anyway/ });
  fireEvent.click(yes);
}

beforeEach(() => { createSpy.mockClear(); toastError.mockClear(); state.vendors = []; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-1744 — the bill comes first", () => {
  it("the 'Have a bill?' band is at the very top, before Amount, even on 'No bill / cash'", () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    const band = screen.getByText(/Have a bill\? Drop the PDF or photo here/);
    expect(band.compareDocumentPosition(el("amount")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: /Upload bill/ })).toBeTruthy();
  });

  it("dropping a PDF anywhere on the dialog sends it to the AI reader", async () => {
    answer(200, { fields: GOOGLE, mode: "gemini" });
    render(<AddExpenseDialog onClose={() => {}} />);
    const zone = document.querySelector("[data-bill-dropzone]") as HTMLElement;
    expect(zone).toBeTruthy();
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [pdf()] } });
    await screen.findByRole("button", { name: /Yes, fill it in|Add as expense anyway/ });
    expect(fetchMock).toHaveBeenCalledWith("/api/ai/extract-bill", expect.anything());
  });
});

describe("R-1744 owner example 1 — Google Cloud India GST invoice", () => {
  it("after confirm every field is filled — line category, note, paid by card — and saves as ₹1,180", async () => {
    state.vendors = [{ id: "v-g", name: "Google Cloud India", gstin: "29AAGCG1234F1Z5" }];
    answer(200, { fields: GOOGLE, mode: "gemini" });
    render(<AddExpenseDialog onClose={() => {}} />);
    await uploadAndConfirm();

    expect(el("vendor_name").value).toBe("Google Cloud India");          // the existing vendor
    expect(screen.getByText(/Existing vendor found/)).toBeTruthy();
    expect(el("bill_no").value).toBe("GCI-2026-1001");
    expect(Number(el("gst_paid").value)).toBe(180);
    expect(el("expense_date").value).toBe("2026-10-05");
    expect(screen.getByText(/₹1,180 incl GST/)).toBeTruthy();
    const lineCat = screen.getByRole("combobox", { name: "Category" }) as HTMLSelectElement;
    expect(lineCat.value).toBe("Software");
    expect(el("description").value).toBe("Google Cloud India — Workspace — Oct 2026");
    expect(el("payment_method").textContent).toMatch(/card/);

    // A small "AI" marker next to what the AI filled …
    for (const f of ["amount", "expense_date", "vendor_name", "description", "bill_no", "gst_paid", "payment_method", "line-0-category"]) {
      expect(mark(f), f).toBeTruthy();
    }
    // … cleared when the operator edits that field.
    fireEvent.change(el("description"), { target: { value: "Workspace for the team" } });
    expect(mark("description")).toBeNull();
    fireEvent.change(el("description"), { target: { value: "Google Cloud India — Workspace — Oct 2026" } });

    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const saved = (createSpy.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(saved).toMatchObject({
      category: "Software", amount: 1180, gst_paid: 180, igst: 180, vendor_id: "v-g",
      bill_no: "GCI-2026-1001", bill_type: "gst", payment_method: "card", paid: true,
      description: "Google Cloud India — Workspace — Oct 2026", rcm: false,
    });
  });
});

describe("R-1744 owner example 2 — AWS (US) $20, no GST", () => {
  it("currency USD and a reverse-charge SUGGESTION — never ticked by itself", async () => {
    answer(200, { fields: AWS, mode: "gemini" });
    render(<AddExpenseDialog onClose={() => {}} />);
    await uploadAndConfirm();

    expect(el("currency").textContent).toMatch(/USD/);
    const chip = screen.getByRole("button", { name: /Foreign vendor, no GST — reverse charge\?/ });
    const rcmBox = screen.getByRole("checkbox", { name: /Reverse charge/ }) as HTMLInputElement;
    expect(rcmBox.checked).toBe(false);
    expect(el("description").value).toBe("Amazon Web Services — EC2 — Oct 2026");
    fireEvent.click(chip);
    expect(rcmBox.checked).toBe(true);
    expect(screen.queryByRole("button", { name: /Foreign vendor, no GST/ })).toBeNull();
  });
});

describe("R-1744 — AI not available", () => {
  it("no Gemini key → a clear English message, the form stays manual and the bill stays attached", async () => {
    answer(400, { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or fill the bill by hand.", code: "ai_not_configured" });
    render(<AddExpenseDialog onClose={() => {}} />);
    fireEvent.change(el("bill-file"), { target: { files: [pdf()] } });
    await screen.findByText(/AI bill reading is not set up for your company/);
    expect(screen.queryByRole("button", { name: /Yes, fill it in|Add as expense anyway/ })).toBeNull();
    expect(screen.getByText(/bill\.pdf/)).toBeTruthy();
    expect(Number(el("amount").value)).toBe(0);
    expect(document.querySelector("[data-ai-mark]")).toBeNull();
  });
});
