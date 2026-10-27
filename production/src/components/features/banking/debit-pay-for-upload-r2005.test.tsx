// @vitest-environment jsdom
/* R-2005 — Banking → Reconcile → a money-out line → "The bill is not in the books yet — record it
   now" → "Upload bill (photo / PDF)": the same reader as Add COGS Bill / Add expense fills the
   bill, says when the bill is from another vendor, and the file is attached to the bill the save
   creates (Pardeep, 27 Oct: ₹7,080 BANSAL PRINT HOUSE). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { VendorPayResult } from "@/lib/banking/debit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ pay: vi.fn(), attach: vi.fn() }));

vi.mock("@/lib/queries/vendors", () => ({
  useVendors: () => ({
    data: [
      { id: "v1", name: "Sharma Associates", pan: "AAKFS1866A", gstin: "07AAKFS1866A1Z5", default_tds_section: "194J", default_category: "Professional Services" },
      { id: "v4", name: "Bansal Print House", gstin: "07AABCB2005A1Z1", default_category: "Advertising" },
    ],
  }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Advertising", "Bank Charges", "Salaries", "Other"],
  useVendorTdsThisFy: () => ({ data: { base: 0, baseWithoutTds: 0 } }),
}));
vi.mock("@/lib/queries/vendor-bills", () => ({
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-Other"],
  attachBillFile: state.attach,
}));
vi.mock("@/lib/queries/bank-debit-pay-for", () => ({
  useVendorOpenItems: (id: string | null) => ({ data: id ? [] : undefined, isLoading: false }),
  usePayVendorFromBankDebit: () => ({ mutateAsync: state.pay, isPending: false }),
  useVendor194q: (id: string | null) => ({ data: id ? [] : undefined }),
  useSet194qBuyer: () => ({ mutate: vi.fn(), isPending: false }),
  useVendorNarrationAliases: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendor-advance", () => ({ useApplyVendorAdvance: () => ({ mutate: vi.fn(), isPending: false }) }));

import { DebitPayForSection } from "./debit-pay-for-section";

const BANSAL = {
  vendor_name: "Bansal Print House", vendor_gstin: "07AABCB2005A1Z1", bill_no: "BPH-77", bill_date: "2026-10-09",
  currency: "INR", subtotal: 6000, cgst: 540, sgst: 540, igst: 0, total: 7080,
  category_guess: "COGS-Other", expense_category: "Advertising", document_type: "tax_invoice", buyer_mismatch: null,
};
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (status: number, body: unknown) => {
  fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  state.pay.mockReset();
  state.attach.mockReset();
  answer(200, { fields: BANSAL, mode: "gemini" });
});

const txn = (debit: number, description: string): BankTransactionRow => ({
  id: `t-${debit}`, bank_account_id: "b1", txn_date: "2026-10-11", description, debit, credit: 0, reference: null,
} as unknown as BankTransactionRow);
const pdf = (size = 2000) => {
  const f = new File(["%PDF bill"], "bansal-bph-77.pdf", { type: "application/pdf" });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const openNewBill = () => fireEvent.click(screen.getByLabelText("The bill is not in the books yet — record it now"));
const upload = (f: File) => fireEvent.change(screen.getByLabelText("Bill file (photo or PDF)"), { target: { files: [f] } });
const val = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const saveButton = () => screen.getByRole("button", { name: /^Record payment/ }) as HTMLButtonElement;
const result = (o: Partial<VendorPayResult>): VendorPayResult => ({
  vendor_id: "v4", vendor_name: "Bansal Print House", vendor_created: false, bank_amount: 7080, paid: [], new_bill: null,
  advance: null, bank_charge: null, tds_total: 0, tds_section: null, ...o,
});

describe("R-2005 Reconcile money-out — Upload bill on 'The bill is not in the books yet'", () => {
  it("upload → the reader fills bill number, date, value before GST, GST and category; Save attaches the file to the new bill", async () => {
    const file = pdf();
    state.pay.mockResolvedValue(result({
      new_bill: { source: "expense", doc_id: "E9", bill_no: "BPH-77", settled: 7080, cash: 7080, tds: 0, tds_section: null, status: "paid", still_due: 0, total: 7080 },
    }));
    state.attach.mockResolvedValue("t/vendor-bills/x-bansal-bph-77.pdf");
    render(<DebitPayForSection transaction={txn(7080, "UPI-BANSAL PRINT HOUSE-BANSALPRINT@YBL")} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v4");
    openNewBill();
    expect(screen.getByRole("button", { name: "Upload bill (photo / PDF)" })).toBeTruthy();
    upload(file);
    await waitFor(() => expect(val("Bill number")).toBe("BPH-77"));
    expect(fetchMock).toHaveBeenCalledWith("/api/ai/extract-bill", expect.anything());
    expect(val("Bill date")).toBe("2026-10-09");
    expect(val("Value before GST")).toBe("6000");
    expect(val("GST on the bill")).toBe("1080");
    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("Advertising");
    expect(screen.getByRole("button", { name: "Expense bill" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/bansal-bph-77\.pdf.*will be attached to the bill/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();   // same vendor — no warning
    expect(screen.getByText(/= ₹7,080 paid from the bank/)).toBeTruthy();

    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    expect(state.pay.mock.calls[0][0].newBill).toMatchObject({ kind: "expense", billNo: "BPH-77", billDate: "2026-10-09", category: "Advertising", taxable: 6000, gst: 1080, itc: true });
    expect(state.attach).toHaveBeenCalledTimes(1);
    expect(state.attach).toHaveBeenCalledWith("expense", "E9", file);
    // the RPC ran first — the file is attached to the id it returned
    expect(state.pay.mock.invocationCallOrder[0]).toBeLessThan(state.attach.mock.invocationCallOrder[0]);
  });

  it("a bill for a product we resell fills a COGS bill; the attachment goes on the COGS bill", async () => {
    answer(200, { fields: { ...BANSAL, category_guess: "COGS-Workspace" } });
    state.pay.mockResolvedValue(result({
      new_bill: { source: "vendor_bill", doc_id: "B9", bill_no: "BPH-77", settled: 7080, cash: 7080, tds: 0, tds_section: null, status: "paid", still_due: 0, total: 7080 },
    }));
    state.attach.mockResolvedValue("p");
    render(<DebitPayForSection transaction={txn(7080, "UPI-BANSAL PRINT HOUSE-BANSALPRINT@YBL")} onDone={() => {}} />);
    openNewBill();
    const file = pdf();
    upload(file);
    await waitFor(() => expect(screen.getByRole("button", { name: "COGS bill (resale)" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("COGS-Workspace");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.attach).toHaveBeenCalledWith("vendor_bill", "B9", file);
  });

  it("the bill is from another vendor in the master → warning with a button that switches the line to it, the bill stays filled", async () => {
    render(<DebitPayForSection transaction={txn(7080, "IMPS SHARMA ASSOCIATES FEES")} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v1");
    openNewBill();
    upload(pdf());
    const warn = await screen.findByRole("alert");
    expect(warn.textContent).toContain("This bill is from Bansal Print House (GSTIN 07AABCB2005A1Z1), not Sharma Associates.");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Bansal Print House" }));
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v4");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(val("Bill number")).toBe("BPH-77");
    expect(val("Value before GST")).toBe("6000");
    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("Advertising");
  });

  it("the bill's vendor is not in the master → add it as a new vendor, name and GSTIN from the bill (R-1918 path)", async () => {
    answer(200, { fields: { ...BANSAL, vendor_name: "Bansal Traders", vendor_gstin: "07AAACB0000B1ZX" } });
    render(<DebitPayForSection transaction={txn(7080, "IMPS SHARMA ASSOCIATES FEES")} onDone={() => {}} />);
    openNewBill();
    upload(pdf());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Add Bansal Traders as a new vendor" }));
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("__new_vendor__");
    expect(val("New vendor name")).toBe("Bansal Traders");
    expect(val("GSTIN (optional)")).toBe("07AAACB0000B1ZX");
    expect(val("PAN (optional)")).toBe("AAACB0000B");
    expect(val("Bill number")).toBe("BPH-77");
  });

  it("over 8 MB → the error says so with the way out by hand; nothing is read", async () => {
    render(<DebitPayForSection transaction={txn(7080, "UPI-BANSAL PRINT HOUSE-BANSALPRINT@YBL")} onDone={() => {}} />);
    openNewBill();
    upload(pdf(8 * 1024 * 1024 + 1));
    expect(await screen.findByText("File is too big (max 8 MB) — try a smaller photo, or fill the fields by hand.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(val("Bill number")).toBe("");
  });

  it("a bill addressed to another company → red line; Save waits for 'yes, we paid it'", async () => {
    answer(200, { fields: { ...BANSAL, buyer_mismatch: { buyer_name: "Other Traders", buyer_gstin: null, own_name: "Our Company" } } });
    render(<DebitPayForSection transaction={txn(7080, "UPI-BANSAL PRINT HOUSE-BANSALPRINT@YBL")} onDone={() => {}} />);
    openNewBill();
    upload(pdf());
    expect((await screen.findByRole("alert")).textContent).toContain("This bill is addressed to Other Traders, not Our Company.");
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Yes, Our Company paid this bill"));
    expect(saveButton().disabled).toBe(false);
  });

  it("the file upload after save fails → the bill is still saved, and the result says to attach it from the bill", async () => {
    state.pay.mockResolvedValue(result({
      new_bill: { source: "expense", doc_id: "E9", bill_no: "BPH-77", settled: 7080, cash: 7080, tds: 0, tds_section: null, status: "paid", still_due: 0, total: 7080 },
    }));
    state.attach.mockRejectedValue(new Error("storage down"));
    render(<DebitPayForSection transaction={txn(7080, "UPI-BANSAL PRINT HOUSE-BANSALPRINT@YBL")} onDone={() => {}} />);
    openNewBill();
    upload(pdf());
    await waitFor(() => expect(val("Bill number")).toBe("BPH-77"));
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(await screen.findByText(/The file bansal-bph-77\.pdf could not be attached — open the bill and attach it there\./)).toBeTruthy();
  });
});

/* R-2005 follow-up (Pardeep, 27 Oct localhost 04:44Z): "Add Bansal Print House" as a new vendor →
   Upload bill → payment saved, but Vendors → Bansal Print House had no GSTIN. The bill's GSTIN
   (valid check digit only) fills the new vendor's empty GSTIN and PAN and goes in the save. */
describe("R-2005 new vendor — the bill's GSTIN is saved on it", () => {
  const PRESS = { ...BANSAL, vendor_name: "Bansal Press", vendor_gstin: "07AAHFB1234C1Z4" };
  const newVendor = (name: string) => {
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "__new_vendor__" } });
    fireEvent.change(screen.getByLabelText("New vendor name"), { target: { value: name } });
  };

  it("new vendor typed, then the bill uploaded → GSTIN and PAN filled from the bill; the save carries them", async () => {
    answer(200, { fields: PRESS });
    state.pay.mockResolvedValue(result({ vendor_id: "vn", vendor_name: "Bansal Press", vendor_created: true }));
    render(<DebitPayForSection transaction={txn(7080, "NEFT DR 7080 PAYMENT")} onDone={() => {}} />);
    newVendor("Bansal Press");
    openNewBill();
    upload(pdf());
    await waitFor(() => expect(val("GSTIN (optional)")).toBe("07AAHFB1234C1Z4"));
    expect(val("PAN (optional)")).toBe("AAHFB1234C");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newVendor).toMatchObject({ name: "Bansal Press", gstin: "07AAHFB1234C1Z4", pan: "AAHFB1234C" });
  });

  it("what the owner typed is never overwritten", async () => {
    answer(200, { fields: PRESS });
    render(<DebitPayForSection transaction={txn(7080, "NEFT DR 7080 PAYMENT")} onDone={() => {}} />);
    newVendor("Bansal Press");
    fireEvent.change(screen.getByLabelText("GSTIN (optional)"), { target: { value: "07ABDCA0298H1ZP" } });
    openNewBill();
    upload(pdf());
    await waitFor(() => expect(val("Bill number")).toBe("BPH-77"));
    expect(val("GSTIN (optional)")).toBe("07ABDCA0298H1ZP");
    expect(val("PAN (optional)")).toBe("");
  });

  it("a GSTIN whose check digit is wrong is not filled — the form says to type it from the bill", async () => {
    answer(200, { fields: { ...PRESS, vendor_gstin: "07AAHFB1234C1Z5" } });
    render(<DebitPayForSection transaction={txn(7080, "NEFT DR 7080 PAYMENT")} onDone={() => {}} />);
    newVendor("Bansal Press");
    openNewBill();
    upload(pdf());
    expect(await screen.findByText("The bill's GSTIN 07AAHFB1234C1Z5 fails the GSTIN check digit — type the GSTIN from the bill.")).toBeTruthy();
    expect(val("GSTIN (optional)")).toBe("");
  });

  it("'Add as a new vendor' from the mismatch warning → the save carries the bill's GSTIN", async () => {
    answer(200, { fields: { ...BANSAL, vendor_name: "Bansal Traders", vendor_gstin: "07AAACB0000B1ZX" } });
    state.pay.mockResolvedValue(result({ vendor_id: "vn", vendor_name: "Bansal Traders", vendor_created: true }));
    render(<DebitPayForSection transaction={txn(7080, "IMPS SHARMA ASSOCIATES FEES")} onDone={() => {}} />);
    openNewBill();
    upload(pdf());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Add Bansal Traders as a new vendor" }));
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newVendor).toMatchObject({ name: "Bansal Traders", gstin: "07AAACB0000B1ZX", pan: "AAACB0000B" });
  });
});
