// @vitest-environment jsdom
/* R-1866 — "Paying a vendor? This payment is for:" on a money-out bank line. One test per path
   Pardeep named: two bills in one payment net of 194J TDS, part payment, a new bill on the spot
   with GST input, an advance to a new vendor, a bank charge, and a mismatch that cannot be saved.
   Each pins what reaches the server (one RPC per save) — the money work itself is proven by the
   SQL test supabase/tests/r1866_bank_debit_vendor.test.sql. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { VendorOpenItem, VendorPayResult } from "@/lib/banking/debit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  items: {} as Record<string, unknown[]>,
  fy: { base: 0, baseWithoutTds: 0 },
  pay: vi.fn(),
  q194: {} as Record<string, unknown[]>,
  setBuyer: vi.fn(),
  advances: [] as unknown[],
  applyAdvance: vi.fn(),
}));

vi.mock("@/lib/queries/vendors", () => ({
  useVendors: () => ({
    data: [
      { id: "v1", name: "Sharma Associates", pan: "AAKFS1866A", gstin: "07AAKFS1866A1Z5", default_tds_section: "194J", default_category: "Professional Services" },
      { id: "v2", name: "Google Cloud India", gstin: "29AACCG1866B1Z9", default_category: "COGS-Workspace" },
      { id: "v3", name: "Ingram Micro India", pan: "AAACI1891A", default_tds_section: "194Q", default_category: "COGS-Hardware" },
    ],
  }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Advertising", "Bank Charges", "Salaries", "Other"],
  useVendorTdsThisFy: (_v: string | null, _n: string, section: string) => ({ data: section ? state.fy : undefined }),
}));
vi.mock("@/lib/queries/vendor-bills", () => ({ VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-Other"] }));
vi.mock("@/lib/queries/bank-debit-pay-for", () => ({
  useVendorOpenItems: (id: string | null) => ({ data: id ? state.items[id] ?? [] : undefined, isLoading: false }),
  usePayVendorFromBankDebit: () => ({ mutateAsync: state.pay, isPending: false }),
  useVendor194q: (id: string | null) => ({ data: id ? state.q194[id] ?? [] : undefined }),
  useSet194qBuyer: () => ({ mutate: state.setBuyer, isPending: false }),
}));

/* R-1913: the vendor's advance (Prepaid) and "Apply advance". */
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: state.advances }) }));
vi.mock("@/lib/queries/vendor-advance", () => ({ useApplyVendorAdvance: () => ({ mutate: state.applyAdvance, isPending: false }) }));

import { DebitPayForSection } from "./debit-pay-for-section";

afterEach(cleanup);
beforeEach(() => {
  state.pay.mockReset();
  state.setBuyer.mockReset();
  state.applyAdvance.mockReset();
  state.advances = [];
  state.fy = { base: 70800 - 10800, baseWithoutTds: 60000 };   // the two unpaid bills ARE the year so far
  state.items = {};
  state.q194 = {};
});

const txn = (debit: number, description: string): BankTransactionRow => ({
  id: `t-${debit}`, bank_account_id: "b1", txn_date: "2026-10-11", description, debit, credit: 0, reference: null,
} as unknown as BankTransactionRow);

const exp = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "expense", doc_id: "E1", bill_no: "PS-101", doc_date: "2026-09-01", due_date: null, category: "Professional Services",
  total: 59000, amount_due: 59000, gst: 9000, tds_base: 50000, tds_amount: 0, tds_section: null, can_part: false, in_run: null, ...o,
});
const G2: VendorOpenItem = {
  source: "vendor_bill", doc_id: "B2", bill_no: "G-2", doc_date: "2026-09-20", due_date: "2026-10-20", category: "COGS-Workspace",
  total: 23600, amount_due: 23600, gst: 3600, tds_base: 20000, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
};
const result = (o: Partial<VendorPayResult>): VendorPayResult => ({
  vendor_id: "v1", vendor_name: "Sharma Associates", vendor_created: false, bank_amount: 0, paid: [], new_bill: null,
  advance: null, bank_charge: null, tds_total: 0, tds_section: null, ...o,
});
const saveButton = () => screen.getByRole("button", { name: /^Record payment/ }) as HTMLButtonElement;

describe("R-1866 DebitPayForSection", () => {
  it("two bills in one payment net of 194J: vendor guessed, both ticked, maths shown, one RPC, result names bill + TDS", async () => {
    state.items.v1 = [exp({}), exp({ doc_id: "E2", bill_no: "PS-102", doc_date: "2026-09-15", total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000 })];
    state.pay.mockResolvedValue(result({
      bank_amount: 64800, tds_total: 6000, tds_section: "194J",
      paid: [{ source: "expense", doc_id: "E1", bill_no: "PS-101", settled: 59000, cash: 54000, tds: 5000, tds_section: "194J", status: "paid", still_due: 0 }],
    }));
    render(<DebitPayForSection transaction={txn(64800, "IMPS SHARMA ASSOCIATES FEES")} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v1");
    expect(screen.getByText(/Guessed from the bank line says/)).toBeTruthy();
    expect((screen.getByLabelText(/^Pay Bill PS-101 · /) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Pay Bill PS-102 · /) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Bills ₹70,800/).textContent).toContain("TDS ₹6,000");
    expect(screen.getByText(/= ₹64,800 paid from the bank/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    const arg = state.pay.mock.calls[0][0];
    expect(arg).toMatchObject({ transactionId: "t-64800", vendorId: "v1", advance: 0, bankCharge: 0, newBill: null });
    expect(arg.items.map((x: { item: VendorOpenItem; cash: number; tds: number; section: string }) => [x.item.doc_id, x.cash, x.tds, x.section]))
      .toEqual([["E1", 54000, 5000, "194J"], ["E2", 10800, 1000, "194J"]]);
    expect(screen.getByText("Paid Bill #PS-101 (₹59,000) to Sharma Associates · TDS ₹5,000 deducted (194J) · Bill now Paid")).toBeTruthy();
  });

  it("part payment: ₹10,000 on a ₹23,600 COGS bill stays part due", async () => {
    state.items.v2 = [G2];
    state.pay.mockResolvedValue(result({ vendor_name: "Google Cloud India" }));
    render(<DebitPayForSection transaction={txn(10000, "NEFT GOOGLE PART")} onDone={() => {}} />);
    const box = screen.getByLabelText(/^Pay Bill G-2 · /) as HTMLInputElement;
    expect(box.checked).toBe(false);          // 10,000 ≠ 23,600 — nothing pre-ticked
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(box);
    expect(screen.getByText(/part payment — ₹13,600 stays due/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    const arg = state.pay.mock.calls[0][0];
    expect(arg.items.map((x: { item: VendorOpenItem; cash: number; tds: number }) => [x.item.doc_id, x.cash, x.tds])).toEqual([["B2", 10000, 0]]);
    expect(arg.advance).toBe(0);
  });

  it("new bill on the spot with GST input + 194J TDS: bank = bill − TDS", async () => {
    state.fy = { base: 60000, baseWithoutTds: 0 };
    state.pay.mockResolvedValue(result({}));
    render(<DebitPayForSection transaction={txn(21600, "UPI SHARMA ASSOC AUDIT")} onDone={() => {}} />);
    fireEvent.click(screen.getByLabelText(/The bill is not in the books yet/));
    fireEvent.change(screen.getByLabelText("Bill number"), { target: { value: "PS-130" } });
    fireEvent.change(screen.getByLabelText("Value before GST"), { target: { value: "20000" } });
    fireEvent.change(screen.getByLabelText("GST on the bill"), { target: { value: "3600" } });
    expect(screen.getByText(/Bill ₹23,600/).textContent).toContain("TDS ₹2,000 (194J) = ₹21,600 from bank");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newBill).toMatchObject({
      kind: "expense", billNo: "PS-130", category: "Professional Services", taxable: 20000, gst: 3600, itc: true, pay: 23600, tds: 2000, tdsSection: "194J",
    });
  });

  it("advance to a vendor added on the spot (nothing billed yet)", async () => {
    state.pay.mockResolvedValue(result({ vendor_name: "Meta Ads India", vendor_created: true, advance: { id: "a1", amount: 15000, category: "Advertising" } }));
    render(<DebitPayForSection transaction={txn(15000, "CARD META ADS")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "__new_vendor__" } });
    fireEvent.change(screen.getByLabelText("New vendor name"), { target: { value: "Meta Ads India" } });
    fireEvent.change(screen.getByLabelText("PAN (optional)"), { target: { value: "aagcm1866c" } });
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("15000");
    fireEvent.change(screen.getByLabelText("Advance category"), { target: { value: "Advertising" } });
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0]).toMatchObject({
      vendorId: null, newVendor: { name: "Meta Ads India", pan: "AAGCM1866C" }, items: [], advance: 15000, advanceCategory: "Advertising",
    });
    expect(screen.getByText(/New vendor Meta Ads India added/)).toBeTruthy();
  });

  it("bank charge on the line is its own part; the rest pays the bill", async () => {
    state.items.v2 = [G2];
    state.pay.mockResolvedValue(result({ vendor_name: "Google Cloud India" }));
    render(<DebitPayForSection transaction={txn(23625, "NEFT GOOGLE G-2")} onDone={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Pay Bill G-2 · /));
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("25");   // extra before the charge is typed
    fireEvent.change(screen.getByLabelText("Bank charge"), { target: { value: "25" } });
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("0");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0]).toMatchObject({ bankCharge: 25, advance: 0 });
    expect(state.pay.mock.calls[0][0].items[0].cash).toBe(23600);
  });

  /* R-1891: a goods bill over ₹50 lakh this year, vendor's usual section 194Q. */
  const IM2: VendorOpenItem = { ...G2, doc_id: "B9", bill_no: "IM-2", total: 2360000, amount_due: 2360000, gst: 360000, tds_base: 2000000 };
  const q = (buyer: boolean | null) => [{ doc_id: "B9", fy_start: "2026-04-01", fy_before: 4000000, base: 1000000, rate_pct: 0.1, no_pan: false, tds_total: 1000, tds_already: 0, tds_due: 1000, buyer }];

  it("R-1891: 194Q on a goods bill — asks the ₹10 crore question once, then takes the database's TDS", async () => {
    state.items.v3 = [IM2];
    state.q194.v3 = q(null);
    const { rerender } = render(<DebitPayForSection transaction={txn(2359000, "NEFT INGRAM MICRO IM-2")} onDone={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Pay Bill IM-2 · /));
    expect(screen.getByText(/turnover last financial year was/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Yes, above ₹10 crore/ }));
    expect(state.setBuyer).toHaveBeenCalledWith(true);

    state.q194.v3 = q(true);
    state.pay.mockResolvedValue(result({ vendor_name: "Ingram Micro India" }));
    rerender(<DebitPayForSection transaction={txn(2359000, "NEFT INGRAM MICRO IM-2")} onDone={() => {}} />);
    expect(screen.getByText(/0.1% on ₹10,00,000 above ₹50 lakh = ₹1,000/)).toBeTruthy();
    expect(screen.getByText(/\+ TDS ₹1,000 \(194Q\)/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].items.map((x: { item: VendorOpenItem; cash: number; tds: number; section: string }) => [x.item.doc_id, x.cash, x.tds, x.section]))
      .toEqual([["B9", 2359000, 1000, "194Q"]]);
  });

  it("parts that do not make the bank amount cannot be saved", () => {
    state.items.v2 = [G2];
    render(<DebitPayForSection transaction={txn(10000, "NEFT GOOGLE")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Advance to vendor"), { target: { value: "4000" } });
    expect(screen.getByText(/₹6,000 of the ₹10,000 is not placed yet/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
});

/* R-1911 (R-1906 audit B1): a payment already recorded on the Bills / Expenses page + the real
   bank line must count ONCE — the sheet offers "match this bank line to it" first and pre-ticks it,
   never the bill as a second payment, never the whole line as an advance. The money is proven by
   supabase/tests/r1911_match_recorded_vendor_payment.test.sql. */
describe("R-1911 DebitPayForSection — match a payment already recorded", () => {
  const recordedBill: VendorOpenItem = {
    source: "recorded_payment", doc_id: "11111111-aaaa-bbbb-cccc-000000000001", bill_no: "G-10", doc_date: "2026-10-10", due_date: null,
    category: "COGS-Workspace", total: 10000, amount_due: 5000, gst: 0, tds_base: 0, tds_amount: 0, tds_section: null, can_part: false,
    in_run: null, paid_on: "2026-10-10", pays_source: "vendor_bill", pays_doc_id: "B10",
  };
  const billHalfPaid: VendorOpenItem = { ...G2, doc_id: "B10", bill_no: "G-10", doc_date: "2026-09-05", total: 10000, amount_due: 5000 };
  const matchButton = () => screen.getByRole("button", { name: /^Match ₹5,000 to the payment already recorded/ }) as HTMLButtonElement;

  it("Bills-page payment of ₹5,000 + the real ₹5,000 line: listed first, pre-ticked, the bill NOT ticked, one match sent", async () => {
    state.items.v2 = [recordedBill, billHalfPaid];
    state.pay.mockResolvedValue(result({
      vendor_name: "Google Cloud India", bank_amount: 5000,
      paid: [{ source: "recorded_payment", pays_source: "vendor_bill", paid_on: "2026-10-10", doc_id: "B10", bill_no: "G-10", settled: 5000, cash: 5000, tds: 0, tds_section: null, status: "partial", still_due: 5000 }],
    }));
    render(<DebitPayForSection transaction={txn(5000, "NEFT DR-HDFC0001-GOOGLE CLOUD INDIA-N283")} onDone={() => {}} />);
    const boxes = screen.getAllByRole("checkbox").filter((b) => /Match this bank line|^Pay Bill/.test(b.getAttribute("aria-label") ?? ""));
    expect(boxes[0].getAttribute("aria-label")).toMatch(/^Match this bank line to the payment Already paid on .* from the Bills page · Bill G-10$/);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Pay Bill G-10 · /) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/from the Bills page · Bill G-10 — match this bank line to it/)).toBeTruthy();
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("0");
    expect(matchButton().disabled).toBe(false);
    fireEvent.click(matchButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    const arg = state.pay.mock.calls[0][0];
    expect(arg.advance).toBe(0);
    expect(arg.items.map((x: { item: VendorOpenItem; cash: number; tds: number }) => [x.item.source, x.item.doc_id, x.cash, x.tds]))
      .toEqual([["recorded_payment", recordedBill.doc_id, 5000, 0]]);
    expect(screen.getByText(/Matched to the ₹5,000 already paid to Google Cloud India on .* from the Bills page for Bill #G-10 — counted once, not paid again/)).toBeTruthy();
  });

  it("Expenses → Mark paid, then the real line: matched, NOT pre-filled as a whole-line advance", () => {
    state.items.v1 = [{
      ...recordedBill, doc_id: "EXP-9", bill_no: "PS-9", category: "Professional Services", total: 11800, amount_due: 10800,
      paid_on: "2026-10-14", pays_source: "expense", pays_doc_id: "EXP-9",
    }];
    render(<DebitPayForSection transaction={txn(10800, "UPI SHARMA ASSOCIATES PS9")} onDone={() => {}} />);
    expect((screen.getByLabelText(/^Match this bank line to the payment Already paid on .* from the Expenses page · Bill PS-9$/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("0");
    expect(screen.queryByText(/has no unpaid bills/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Match ₹10,800 to the payment already recorded/ })).toBeTruthy();
  });

  it("a recorded payment of another amount is listed but not ticked; the exact bill still is", () => {
    state.items.v2 = [{ ...recordedBill, amount_due: 3000 }, { ...billHalfPaid, amount_due: 7000 }];
    render(<DebitPayForSection transaction={txn(7000, "NEFT GOOGLE CLOUD INDIA")} onDone={() => {}} />);
    expect((screen.getByLabelText(/^Match this bank line to the payment/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/^Pay Bill G-10 · /) as HTMLInputElement).checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });
});

/* R-1913 (R-1906 audit B2): Verma's ₹30,000 advance, ₹50,000 bill on Expenses, the ₹20,000 bank
   line — the advance is applied to the bill first, so the line pays only the rest. */
describe("R-1913 DebitPayForSection — the vendor's advance on an expense bill", () => {
  it("shows 'Advance with vendor ₹30,000' on the bill and applies at most what the bill owes", () => {
    state.items.v1 = [exp({ doc_id: "EV1", bill_no: "VC-1", total: 50000, amount_due: 50000, gst: 0, tds_base: 50000 })];
    state.advances = [{ vendor_id: "v1", vendor_name: "Sharma Associates", total_amount: 30000, consumed_amount: 0, closed_at: null, category: "Professional Services" }];
    render(<DebitPayForSection transaction={txn(20000, "IMPS SHARMA ASSOCIATES VC-1")} onDone={() => {}} />);
    expect(screen.getByText("Advance with vendor ₹30,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply ₹30,000 to this bill" }));
    expect(state.applyAdvance).toHaveBeenCalledWith({ expenseId: "EV1" });
  });

  it("no advance with the vendor, or a COGS bill: nothing offered", () => {
    state.items.v1 = [exp({})];
    render(<DebitPayForSection transaction={txn(59000, "IMPS SHARMA ASSOCIATES")} onDone={() => {}} />);
    expect(screen.queryByText(/Advance with vendor/)).toBeNull();
    cleanup();
    state.items.v2 = [G2];
    state.advances = [{ vendor_id: "v2", vendor_name: "Google Cloud India", total_amount: 5000, consumed_amount: 0, closed_at: null, category: "Other" }];
    render(<DebitPayForSection transaction={txn(23600, "NEFT GOOGLE")} onDone={() => {}} />);
    expect(screen.queryByText(/Advance with vendor/)).toBeNull();
  });
});

/* R-1915 (R-1906 audit B5): Sharma's ₹59,000 expense bill paid in two bank lines. */
describe("R-1915 — expense bill part payment", () => {
  it("₹25,000 line: tick the ₹59,000 bill → 'Pays ₹25,000', ₹34,000 stays due; one RPC with the part", async () => {
    state.items.v1 = [exp({ bill_no: "PS-1", can_part: true })];
    state.pay.mockResolvedValue(result({
      bank_amount: 25000,
      paid: [{ source: "expense", doc_id: "E1", bill_no: "PS-1", settled: 25000, cash: 25000, tds: 0, tds_section: null, status: "partial", still_due: 34000 }],
    }));
    render(<DebitPayForSection transaction={txn(25000, "UPI SHARMA ASSOCIATES PART")} onDone={() => {}} />);
    const box = screen.getByLabelText(/^Pay Bill PS-1 · /) as HTMLInputElement;
    if (!box.checked) fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("TDS section"), { target: { value: "" } });   // Sharma takes no TDS here
    expect((screen.getByLabelText(/^Amount paid on Bill PS-1/) as HTMLInputElement).value).toBe("25000");
    expect(screen.getByText(/part payment — ₹34,000 stays due/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    const arg = state.pay.mock.calls[0][0];
    expect(arg.items.map((x: { item: VendorOpenItem; cash: number; tds: number }) => [x.item.doc_id, x.cash, x.tds])).toEqual([["E1", 25000, 0]]);
    expect(arg.advance).toBe(0);
    expect(screen.getByText("Paid Bill #PS-1 (₹25,000) to Sharma Associates · Bill now part paid, ₹34,000 still due")).toBeTruthy();
  });

  it("second line ₹34,000: the part-paid bill (TDS already taken, base 0) is ticked and takes no new TDS", () => {
    state.items.v1 = [exp({ bill_no: "PS-1", can_part: true, amount_due: 34000, tds_base: 0, tds_amount: 0, tds_section: "194J" })];
    render(<DebitPayForSection transaction={txn(34000, "UPI SHARMA ASSOCIATES REST")} onDone={() => {}} />);
    expect((screen.getByLabelText(/^Pay Bill PS-1 · /) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Amount paid on Bill PS-1/) as HTMLInputElement).value).toBe("34000");
    expect(screen.queryByText(/stays due/)).toBeNull();
    expect(screen.queryByText(/\+ TDS/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

describe("R-1918 — new vendor from the bank line", () => {
  it("UPI line from an unknown payee: one click adds it with name, IFSC and UPI id pre-filled; all reach the server", async () => {
    state.pay.mockResolvedValue(result({ vendor_name: "Kapoor Legal", vendor_created: true, advance: { id: "a1", amount: 3000, category: "Other" } }));
    render(<DebitPayForSection transaction={txn(3000, "UPI-KAPOOR LEGAL-kapoorlegal@okhdfcbank-HDFC0001234-529912345680-FEES")} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Add “Kapoor Legal” as a new vendor" }));
    expect((screen.getByLabelText("New vendor name") as HTMLInputElement).value).toBe("Kapoor Legal");
    expect((screen.getByLabelText("IFSC (optional)") as HTMLInputElement).value).toBe("HDFC0001234");
    expect((screen.getByLabelText("UPI ID (optional)") as HTMLInputElement).value).toBe("kapoorlegal@okhdfcbank");
    expect(screen.getByText(/Filled from the bank line: name, IFSC, UPI ID/)).toBeTruthy();
    expect(screen.getByText(/Saved together with the account number/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newVendor).toMatchObject({ name: "Kapoor Legal", ifsc: "HDFC0001234", upi: "kapoorlegal@okhdfcbank", accountNo: null });
  });

  it("card example — NEFT DR with a masked tail: '＋ New vendor' pre-fills name + IFSC, the account box asks for the full number ending 4521", async () => {
    state.pay.mockResolvedValue(result({ vendor_name: "Sharma Traders", vendor_created: true }));
    render(<DebitPayForSection transaction={txn(4000, "NEFT DR-HDFC0001234-SHARMA TRADERS-XXXXXX4521")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "__new_vendor__" } });
    expect((screen.getByLabelText("New vendor name") as HTMLInputElement).value).toBe("Sharma Traders");
    expect((screen.getByLabelText("IFSC (optional)") as HTMLInputElement).value).toBe("HDFC0001234");
    const acc = screen.getByLabelText("Account number (optional)") as HTMLInputElement;
    expect(acc.value).toBe("");
    expect(acc.placeholder).toBe("Account number (ends 4521)");
    fireEvent.change(acc, { target: { value: "50100123459999" } });
    expect(screen.getByText(/ends with 4521 — check this number/)).toBeTruthy();
    fireEvent.change(acc, { target: { value: "50100123454521" } });
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newVendor).toMatchObject({ name: "Sharma Traders", accountNo: "50100123454521", ifsc: "HDFC0001234" });
  });

  it("a wrong UPI id or account number blocks the save with the field's own words", () => {
    render(<DebitPayForSection transaction={txn(4000, "CARD SOMETHING")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "__new_vendor__" } });
    fireEvent.change(screen.getByLabelText("New vendor name"), { target: { value: "Some Vendor" } });
    fireEvent.change(screen.getByLabelText("UPI ID (optional)"), { target: { value: "not-a-upi" } });
    expect(screen.getByText(/This UPI ID looks wrong/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("UPI ID (optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Account number (optional)"), { target: { value: "12AB" } });
    expect(screen.getByText(/digits only/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
});
