// @vitest-environment jsdom
//
// R-1767 (Pardeep, 22 Oct 2026). The AI read is mocked (/api/ai/extract-bill) — no real AI call.
// Owner's examples, synthetic GSTINs in the real shape (the real PDF never enters the repo):
//   1. Acme Digital uploads Net2secure's Invoice-4426 — a PROFORMA, Bill To BETA
//      TECHNOLOGIES, items "Google Workspace (1 September – 30 September, 2026)" ₹5,62,110 +
//      "Service Charges" ₹2,810, total ₹6,66,606 incl GST ₹1,01,686 → red "addressed to BETA
//      TECHNOLOGIES, not Acme Digital", the proforma warning, a confirm on Save.
//   2. The same bill in Beta Technologies' own books → no buyer warning, but it is a RESALE
//      bill (Google Workspace) → "Record as COGS bill" opens Add COGS Bill already filled, with
//      the file attached and no second AI read.
//   3. A tax invoice addressed to us → no warning, no confirm.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createSpy = vi.fn(async (_v: Record<string, unknown>) => ({}));
const createBillSpy = vi.fn(async (_v: Record<string, unknown>) => ({ id: "bill-1" }));
const uploadSpy = vi.fn(async (_f: File) => "bills/x.pdf");
const confirmSpy = vi.fn(async (_o: { title: string; body?: string }) => true);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
/* R-1846: the owner-salary caution reads the business type / partners — not part of these tests. */
vi.mock("@/components/features/accounting/owner-pay-caution", () => ({ OwnerPayCautionBox: () => null }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({
  uploadBillAttachment: (f: File) => uploadSpy(f),
  useCreateVendorBill: () => ({ mutateAsync: createBillSpy }),
  useOwnStateCode: () => ({ data: "09" }),
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirmSpy }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const pdf = () => new File(["%PDF-1.4 bill"], "Invoice-4426.pdf", { type: "application/pdf" });
const BETA_GSTIN = "09AAFCE2222B1Z7";

const NET2_PROFORMA = {
  vendor_name: "Net2Secure Private Limited",
  vendor_gstin: "09AAICN3949G1Z3",
  bill_no: "Invoice-4426",
  bill_date: "2026-10-01",
  currency: "INR",
  subtotal: 564920, cgst: 50843, sgst: 50843, igst: 0, total: 666606,
  line_items: [
    { description: "Google Workspace ( 1 September - 30 September , 2026 )", qty: null, unit_price: null, amount: 562110 },
    { description: "Service Charges", qty: null, unit_price: null, amount: 2810 },
  ],
  category_guess: "COGS-Workspace",
  expense_category: "Software",
  document_type: "proforma",
  item_short: "Workspace",
  paid_status: null, payment_mode: null,
  buyer_name: "BETA TECHNOLOGIES", buyer_gstin: BETA_GSTIN,
};
const IN_ACME = { ...NET2_PROFORMA, buyer_mismatch: { buyer_name: "BETA TECHNOLOGIES", buyer_gstin: BETA_GSTIN, own_name: "Acme Digital" } };
const IN_BETA = { ...NET2_PROFORMA, buyer_mismatch: null };
const OWN_TAX_INVOICE = {
  vendor_name: "Office Mart", vendor_gstin: "09AAACO1234C1Z2", bill_no: "OM-77", bill_date: "2026-10-03",
  currency: "INR", subtotal: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180,
  line_items: [{ description: "Printer paper", qty: 2, unit_price: 500, amount: 1000 }],
  category_guess: "COGS-Other", expense_category: "Office Supplies", document_type: "tax_invoice",
  item_short: "Paper", paid_status: null, payment_mode: null,
  buyer_name: "Acme Digital Pvt Ltd", buyer_gstin: "09AAKCA1111A1Z5", buyer_mismatch: null,
};

const BUYER_TEXT = `This bill is addressed to BETA TECHNOLOGIES (GSTIN ${BETA_GSTIN}), not Acme Digital. Add it here only if Acme Digital really paid it.`;
const PROFORMA_TEXT = /This is a proforma, not a tax invoice — no GST input credit\. Save it when the tax invoice comes, or save it without credit\./;

let fetchMock: ReturnType<typeof vi.fn>;
function answer(fields: unknown) {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ fields, mode: "gemini" }) }));
  vi.stubGlobal("fetch", fetchMock);
}
async function upload() {
  fireEvent.change(el("bill-file"), { target: { files: [pdf()] } });
  await screen.findByText(/AI read this — is it right\?/);
}

beforeEach(() => {
  createSpy.mockClear(); createBillSpy.mockClear(); uploadSpy.mockClear();
  confirmSpy.mockReset(); confirmSpy.mockImplementation(async () => true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-1767 owner example 1 — Beta Technologies' proforma uploaded in Acme Digital", () => {
  it("preview shows the red buyer warning and the proforma warning", async () => {
    answer(IN_ACME);
    render(<AddExpenseDialog onClose={() => {}} />);
    await upload();
    const warn = screen.getByText(BUYER_TEXT);
    expect(warn.closest("[role=alert]")).toBeTruthy();
    expect(screen.getByText(PROFORMA_TEXT)).toBeTruthy();
  });

  it("Save asks first; 'No' saves nothing; 'Yes' saves with GST credit off and the note", async () => {
    answer(IN_ACME);
    render(<AddExpenseDialog onClose={() => {}} />);
    await upload();
    fireEvent.click(screen.getByRole("button", { name: /Add as expense anyway/ }));
    // The warnings stay on screen after the form is filled.
    expect(screen.getByText(BUYER_TEXT)).toBeTruthy();
    expect(screen.getByText(PROFORMA_TEXT)).toBeTruthy();

    confirmSpy.mockImplementationOnce(async () => false);
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0].body).toContain("BETA TECHNOLOGIES");
    await new Promise((r) => setTimeout(r, 20));
    expect(createSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const saved = createSpy.mock.calls[0][0];
    // A proforma gives no GST input credit: saved as a non-GST bill, GST stays inside the cost.
    expect(saved).toMatchObject({ bill_type: "kaccha", gst_paid: 0, amount: 666606 });
    expect(String(saved.notes)).toMatch(/addressed to BETA TECHNOLOGIES .*confirmed Acme Digital paid it/);
  });
});

describe("R-1767 owner example 2 — the same bill in Beta Technologies (a resale bill)", () => {
  it("no buyer warning; 'Record as COGS bill' opens Add COGS Bill filled in, file attached, no second read", async () => {
    answer(IN_BETA);
    const onClose = vi.fn();
    render(<AddExpenseDialog onClose={onClose} />);
    await upload();
    expect(screen.queryByText(/This bill is addressed to/)).toBeNull();
    expect(screen.getByText(PROFORMA_TEXT)).toBeTruthy();
    expect(screen.getByText("This looks like a bill for products you resell (Google Workspace) — record it as a COGS bill.")).toBeTruthy();
    const cogsBtn = screen.getByRole("button", { name: "Record as COGS bill" });
    expect(screen.getByRole("button", { name: "Add as expense anyway" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Yes, fill it in/ })).toBeNull();

    fireEvent.click(cogsBtn);
    await screen.findByText("Add COGS Bill");
    expect(el("vendor_name").value).toBe("Net2Secure Private Limited");
    expect(el("vendor_gstin").value).toBe("09AAICN3949G1Z3");
    expect(el("bill_no").value).toBe("Invoice-4426");
    expect(el("bill_date").value).toBe("2026-10-01");
    expect(Number(el("total").value)).toBe(666606);
    expect(el("document_type").textContent).toMatch(/Proforma invoice/);
    expect((screen.getAllByDisplayValue(/Google Workspace|Service Charges/)).length).toBe(2);
    expect(screen.getAllByText(/Invoice-4426\.pdf/).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);   // no second AI read

    // Proforma GST → the dialog's own "no credit" second press, then it saves with the file.
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save — GST as cost" }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalledTimes(1));
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0].name).toBe("Invoice-4426.pdf");
    expect(createBillSpy.mock.calls[0][0]).toMatchObject({ document_type: "proforma", attachment_url: "bills/x.pdf", category: "COGS-Workspace", total: 666606 });
    expect(createSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("R-1767 owner example 3 — a tax invoice addressed to us", () => {
  it("no buyer, proforma or resale warning; Save asks nothing", async () => {
    answer(OWN_TAX_INVOICE);
    render(<AddExpenseDialog onClose={() => {}} />);
    await upload();
    expect(screen.queryByText(/This bill is addressed to/)).toBeNull();
    expect(screen.queryByText(PROFORMA_TEXT)).toBeNull();
    expect(screen.queryByText(/products you resell/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Yes, fill it in/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(createSpy.mock.calls[0][0]).toMatchObject({ bill_type: "gst", gst_paid: 180 });
  });
});

describe("R-1767 — Add COGS Bill, uploaded directly", () => {
  it("another company's bill → red warning; Save asks; 'No' saves nothing; 'Yes' saves with the note", async () => {
    answer({ ...IN_ACME, document_type: "tax_invoice" });
    render(<AddVendorBillDialog onClose={() => {}} />);
    fireEvent.change(el("vendor-bill-file"), { target: { files: [pdf()] } });
    const warn = await screen.findByText(BUYER_TEXT);
    expect(warn.closest("[role=alert]")).toBeTruthy();

    confirmSpy.mockImplementationOnce(async () => false);
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(createBillSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalledTimes(1));
    expect(String(createBillSpy.mock.calls[0][0].notes)).toMatch(/addressed to BETA TECHNOLOGIES/);
  });

  it("no buyer read → no warning, no confirm", async () => {
    answer({ ...OWN_TAX_INVOICE, buyer_name: null, buyer_gstin: null, buyer_mismatch: null, category_guess: "COGS-Workspace" });
    render(<AddVendorBillDialog onClose={() => {}} />);
    fireEvent.change(el("vendor-bill-file"), { target: { files: [pdf()] } });
    await screen.findByText(/Filled by AI/);
    expect(screen.queryByText(/This bill is addressed to/)).toBeNull();
  });
});
