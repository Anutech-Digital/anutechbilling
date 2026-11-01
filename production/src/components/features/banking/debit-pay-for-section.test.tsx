// @vitest-environment jsdom
/* R-1866 — "Paying a vendor? This payment is for:" on a money-out bank line. One test per path
   Pardeep named: two bills in one payment net of 194J TDS, part payment, a new bill on the spot
   with GST input, an advance to a new vendor, a bank charge, and a mismatch that cannot be saved.
   Each pins what reaches the server (one RPC per save) — the money work itself is proven by the
   SQL test supabase/tests/r1866_bank_debit_vendor.test.sql. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
  aliases: [] as Array<{ narration_key: string; vendor_id: string }>,
  rules: [] as unknown[],
  role: "owner" as string,
}));

vi.mock("@/lib/queries/vendors", () => ({
  useVendors: () => ({
    data: [
      { id: "v1", name: "Sharma Associates", pan: "AAKFS1866A", gstin: "07AAKFS1866A1Z5", default_tds_section: "194J", default_category: "Professional Services" },
      { id: "v2", name: "Google Cloud India", gstin: "29AACCG1866B1Z9", default_category: "COGS-Workspace" },
      { id: "v3", name: "Ingram Micro India", pan: "AAACI1891A", default_tds_section: "194Q", default_category: "COGS-Hardware" },
      { id: "v4", name: "Sidhshree Infotech", pan: "AAKFS2320A", default_tds_section: "194C", default_category: "COGS-Other" },
      { id: "v5", name: "Pankaj Kumar CA", pan: "ABCPK2320A", default_tds_section: "194J", default_category: "Professional Services" },
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
  useVendorNarrationAliases: () => ({ data: state.aliases }),
}));
/* R-1919: the one guess order reads the Category Rules and the learned aliases too. */
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: state.rules }) }));

/* R-1913: the vendor's advance (Prepaid) and "Apply advance". */
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: state.advances }) }));
vi.mock("@/lib/queries/vendor-advance", () => ({ useApplyVendorAdvance: () => ({ mutate: state.applyAdvance, isPending: false }) }));
/* R-2320: only the owner may take TDS below the threshold. */
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: state.role } }) }));

import { DebitPayForSection } from "./debit-pay-for-section";
import { ReconcileFooter, type FooterSave } from "./reconcile-who-tiles";

afterEach(cleanup);
beforeEach(() => {
  state.pay.mockReset();
  state.setBuyer.mockReset();
  state.applyAdvance.mockReset();
  state.advances = [];
  state.fy = { base: 70800 - 10800, baseWithoutTds: 60000 };   // the two unpaid bills ARE the year so far
  state.items = {};
  state.q194 = {};
  state.aliases = [];
  state.rules = [];
  state.role = "owner";
});

/* R-2320 (staging money-out reconcile, 31 Oct): Zoho's 2% 194C on a COGS bill, and the owner's
   override of "below the threshold" (Pankaj CA ₹14,580 net of 10% 194J). */
describe("R-2320 DebitPayForSection — TDS on a COGS bill, owner override below the threshold", () => {
  const S1: VendorOpenItem = {
    source: "vendor_bill", doc_id: "S1", bill_no: "SI-77", doc_date: "2026-10-02", due_date: null, category: "COGS-Other",
    total: 118000, amount_due: 118000, gst: 18000, tds_base: 100000, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
  };
  const PK: VendorOpenItem = {
    source: "expense", doc_id: "PK1", bill_no: "PK-9", doc_date: "2026-10-03", due_date: null, category: "Professional Services",
    total: 16200, amount_due: 16200, gst: 0, tds_base: 16200, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
  };

  it("Sidhshree ₹1,16,000 line: the COGS bill is ticked net of 194C ₹2,000 and the TDS reaches the server", async () => {
    state.fy = { base: 0, baseWithoutTds: 0 };
    state.items.v4 = [S1];
    state.pay.mockResolvedValue(result({ vendor_id: "v4", vendor_name: "Sidhshree Infotech" }));
    render(<DebitPayForSection transaction={txn(116000, "NEFT SIDHSHREE INFOTECH")} onDone={() => {}} />);
    expect((screen.getByLabelText(/^Pay Bill SI-77 · /) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("TDS section") as HTMLSelectElement).value).toBe("194C");
    expect(screen.getByText(/Bills ₹1,18,000/).textContent).toContain("TDS ₹2,000");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    const arg = state.pay.mock.calls[0][0];
    expect(arg.items.map((x: { item: VendorOpenItem; cash: number; tds: number; section: string }) => [x.item.doc_id, x.cash, x.tds, x.section]))
      .toEqual([["S1", 116000, 2000, "194C"]]);
  });

  it("Pankaj CA ₹14,580: below the 194J limit — the owner deducts anyway with a reason; it is sent", async () => {
    state.fy = { base: 0, baseWithoutTds: 0 };
    state.items.v5 = [PK];
    state.pay.mockResolvedValue(result({ vendor_id: "v5", vendor_name: "Pankaj Kumar CA" }));
    render(<DebitPayForSection transaction={txn(14580, "IMPS PANKAJ KUMAR CA")} onDone={() => {}} />);
    /* Without TDS the line is only a part of the bill — ₹1,620 (the TDS Zoho deducted) would stay due. */
    expect((screen.getByLabelText(/^Pay Bill PK-9 · /) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/part payment — ₹1,620 stays due/)).toBeTruthy();
    expect(screen.getByText(/within the limit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deduct TDS anyway (owner)" }));
    fireEvent.change(screen.getByLabelText("Reason for deducting TDS below the threshold"), { target: { value: "Deducted in Zoho, CA advised" } });
    expect(screen.getByText(/Owner override: TDS taken anyway — Deducted in Zoho, CA advised/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    const it0 = state.pay.mock.calls[0][0].items[0];
    expect([it0.item.doc_id, it0.cash, it0.tds, it0.section, it0.override]).toEqual(["PK1", 14580, 1620, "194JB", "Deducted in Zoho, CA advised"]);   // R-2338: old "194J" = 194J(b)
  });

  it("an accountant is told only the owner can deduct below the threshold — no override offered", () => {
    state.role = "accountant";
    state.fy = { base: 0, baseWithoutTds: 0 };
    state.items.v5 = [PK];
    render(<DebitPayForSection transaction={txn(14580, "IMPS PANKAJ KUMAR CA")} onDone={() => {}} />);
    expect((screen.getByLabelText(/^Pay Bill PK-9 · /) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Only the owner can deduct TDS below the threshold.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deduct TDS anyway (owner)" })).toBeNull();
  });
});

describe("R-1919 DebitPayForSection — one vendor guess, learned from the last payment", () => {
  it("a payee picked by hand once is chosen on the next line, and says so", () => {
    const line = txn(25000, "IMPS-612256082222-RK INFRA-FINO-XXXX6722-RENT OCT");
    render(<DebitPayForSection transaction={line} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("");   // nobody guessed yet
    cleanup();
    state.aliases = [{ narration_key: "rk infra", vendor_id: "v1" }];                    // what the save taught
    render(<DebitPayForSection transaction={line} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v1");
    expect(screen.getByText(/Learned from your last payment to this vendor — change it if wrong./)).toBeTruthy();
  });

  it("a Category Rule names the vendor before a learned alias (the order auto-reconcile uses)", () => {
    state.rules = [{ id: "r1", pattern: "PAYUGOOGLE", category: "Advertising", direction: "debit" }];
    state.aliases = [{ narration_key: "payugoogle", vendor_id: "v1" }];
    render(<DebitPayForSection transaction={txn(5000, "K4UHU5ENAJ52FPOTCU/PAYUGOOGLE")} onDone={() => {}} />);
    expect((screen.getByLabelText("Vendor paid") as HTMLSelectElement).value).toBe("v2");
    expect(screen.getByText(/Guessed from your Category Rule “PAYUGOOGLE”/)).toBeTruthy();
  });
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
      .toEqual([["E1", 54000, 5000, "194JB"], ["E2", 10800, 1000, "194JB"]]);   // R-2338: the vendor's old "194J" = 194J(b) professional
    expect(screen.getByText("Paid Bill #PS-101 (₹59,000) to Sharma Associates · TDS ₹5,000 deducted (194J(b)) · Bill now Paid")).toBeTruthy();
  });

  it("part payment: ₹10,000 on a ₹23,600 COGS bill stays part due", async () => {
    state.items.v2 = [G2];
    state.pay.mockResolvedValue(result({ vendor_name: "Google Cloud India" }));
    render(<DebitPayForSection transaction={txn(10000, "NEFT GOOGLE PART")} onDone={() => {}} />);
    const box = screen.getByLabelText(/^Pay Bill G-2 · /) as HTMLInputElement;
    /* R-2007: the vendor's ONLY open bill and less money than it needs → pre-ticked as a part payment. */
    expect(box.checked).toBe(true);
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
    expect(screen.getByText(/Bill ₹23,600/).textContent).toContain("TDS ₹2,000 (194J(b)) = ₹21,600 from bank");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].newBill).toMatchObject({
      kind: "expense", billNo: "PS-130", category: "Professional Services", taxable: 20000, gst: 3600, itc: true, pay: 23600, tds: 2000, tdsSection: "194JB",
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
    /* R-2007: the only open bill, bank less than it → already ticked (part payment until the TDS is known). */
    expect((screen.getByLabelText(/^Pay Bill IM-2 · /) as HTMLInputElement).checked).toBe(true);
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
    fireEvent.click(screen.getByLabelText(/^Pay Bill G-2 · /));   // untick the pre-ticked part payment (R-2007)
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

  it("no advance with the vendor: nothing offered", () => {
    state.items.v1 = [exp({})];
    render(<DebitPayForSection transaction={txn(59000, "IMPS SHARMA ASSOCIATES")} onDone={() => {}} />);
    expect(screen.queryByText(/Advance with vendor/)).toBeNull();
  });
});

/* R-1914 (R-1906 audit B4): Google Cloud India (COGS-Workspace) — its advance keeps the COGS
   head and is applied to its COGS bill (vendor_bills), not booked as an 'Other' expense. */
describe("R-1914 DebitPayForSection — a COGS vendor's advance", () => {
  it("Google's advance is offered on Google's COGS bill and applied to the bill (vendor_bill)", () => {
    state.items.v2 = [G2];
    state.advances = [{ vendor_id: "v2", vendor_name: "Google Cloud India", total_amount: 5000, consumed_amount: 0, closed_at: null, category: "COGS-Workspace" }];
    render(<DebitPayForSection transaction={txn(18600, "NEFT GOOGLE")} onDone={() => {}} />);
    expect(screen.getByText("Advance with vendor ₹5,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply ₹5,000 to this bill" }));
    expect(state.applyAdvance).toHaveBeenCalledWith({ billId: "B2" });
  });

  it("₹11,800 to Google with no bill yet → advance saved under COGS-Workspace (was 'Other')", async () => {
    state.pay.mockResolvedValue(result({ vendor_name: "Google Cloud India", advance: { id: "a1", amount: 11800, category: "COGS-Workspace" } }));
    render(<DebitPayForSection transaction={txn(11800, "NEFT GOOGLE CLOUD INDIA ADV")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "v2" } });
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("11800");
    const head = screen.getByLabelText("Advance category") as HTMLSelectElement;
    expect(head.value).toBe("COGS-Workspace");
    expect(Array.from(head.options).map((o) => o.value)).toContain("COGS-Other");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0]).toMatchObject({ vendorId: "v2", advance: 11800, advanceCategory: "COGS-Workspace" });
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

/* R-2321 (staging money-out reconcile, 31 Oct): Shri Balaji was paid ₹67,500 against a ₹71,500
   bill. "Record it now" → Expense bill had no "Paying now", so the line could not be booked —
   neither for an existing vendor nor in the new-vendor form. The money work is proven by
   supabase/tests/r2321_new_expense_part_pay.test.sql. */
describe("R-2321 — part-pay a new expense bill from Reconcile", () => {
  const fillBill = (taxable: string, gst: string) => {
    fireEvent.click(screen.getByLabelText(/The bill is not in the books yet/));
    fireEvent.click(screen.getByRole("button", { name: "Expense bill" }));
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Other" } });
    fireEvent.change(screen.getByLabelText("Value before GST"), { target: { value: taxable } });
    fireEvent.change(screen.getByLabelText("GST on the bill"), { target: { value: gst } });
  };

  it("new-vendor form, owner's case: Paying now = the ₹67,500 line, ₹4,000 stays due; only ₹67,500 reaches the bill", async () => {
    state.pay.mockResolvedValue(result({
      vendor_name: "Shri Balaji Traders", vendor_created: true,
      new_bill: { source: "expense", doc_id: "EXP-1", bill_no: "SB-71", settled: 67500, cash: 67500, tds: 0, tds_section: null, status: "partial", still_due: 4000, total: 71500 },
    }));
    render(<DebitPayForSection transaction={txn(67500, "NEFT DR-SBIN0001234-SHRI BALAJI TRADERS")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "__new_vendor__" } });
    fireEvent.change(screen.getByLabelText("New vendor name"), { target: { value: "Shri Balaji Traders" } });
    fillBill("60594", "10906");
    expect((screen.getByLabelText("Amount paid on the new bill") as HTMLInputElement).value).toBe("67500");
    expect(screen.getByText(/part payment — ₹4,000 stays due on the bill/)).toBeTruthy();
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("0");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    const arg = state.pay.mock.calls[0][0];
    expect(arg.newBill).toMatchObject({ kind: "expense", taxable: 60594, gst: 10906, pay: 67500, tds: 0 });
    expect(arg.advance).toBe(0);
    expect(screen.getByText(/Bill now part paid, ₹4,000 still due/)).toBeTruthy();
  });

  it("existing vendor: paying less than the line keeps the difference as an advance (the existing rule)", async () => {
    state.pay.mockResolvedValue(result({ vendor_id: "v2", vendor_name: "Google Cloud India" }));
    render(<DebitPayForSection transaction={txn(67500, "CARD SOMETHING")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "v2" } });
    fillBill("60594", "10906");
    fireEvent.change(screen.getByLabelText("Amount paid on the new bill"), { target: { value: "60000" } });
    expect(screen.getByText(/part payment — ₹11,500 stays due on the bill/)).toBeTruthy();
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("7500");
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0]).toMatchObject({ newBill: { kind: "expense", pay: 60000 }, advance: 7500 });
  });

  it("Paying now cannot go above the bill: a bill smaller than the line is paid in full, the rest is an advance", () => {
    render(<DebitPayForSection transaction={txn(67500, "CARD SOMETHING")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "v2" } });
    fillBill("50000", "0");
    fireEvent.change(screen.getByLabelText("Amount paid on the new bill"), { target: { value: "90000" } });
    expect((screen.getByLabelText("Amount paid on the new bill") as HTMLInputElement).value).toBe("50000");
    expect(screen.queryByText(/stays due on the bill/)).toBeNull();
    expect((screen.getByLabelText("Advance to vendor") as HTMLInputElement).value).toBe("17500");
  });
});

/* R-2325 (staging money-out reconcile, 31 Oct): Zoho booked a bill with GST ₹23.58. Typing that
   in "GST ₹" turned the box into 24 at once (and "23.5" + "8" became 248). The books keep whole
   rupees (expenses / vendor_bills money columns are integers — production/CLAUDE.md), so the
   save still sends ₹24; the box now keeps what was typed and says how it is booked. */
describe("R-2325 — inline new bill: typed paise stay in the box, booked as whole rupees", () => {
  const openExpenseBill = () => {
    fireEvent.click(screen.getByLabelText(/The bill is not in the books yet/));
    fireEvent.click(screen.getByRole("button", { name: "Expense bill" }));
  };

  it("GST 23.58 stays 23.58 in the box; the note and the save say ₹24", async () => {
    const { payArgs } = await import("@/lib/banking/debit-pay-for");
    state.pay.mockResolvedValue(result({}));
    render(<DebitPayForSection transaction={txn(155, "UPI ZOHO AUTOPAY")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "v1" } });
    openExpenseBill();
    fireEvent.change(screen.getByLabelText("TDS section"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Value before GST"), { target: { value: "131" } });
    fireEvent.change(screen.getByLabelText("GST on the bill"), { target: { value: "23.58" } });
    expect((screen.getByLabelText("GST on the bill") as HTMLInputElement).value).toBe("23.58");
    expect(screen.getByText("GST ₹23.58 is booked as ₹24 — the books keep whole rupees.")).toBeTruthy();
    expect(screen.getByText(/Bill ₹155/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    const sent = payArgs(state.pay.mock.calls[0][0]);
    expect(sent.p_new_bill).toMatchObject({ taxable: 131, gst: 24 });
  });

  it("whole rupees typed → no note", () => {
    render(<DebitPayForSection transaction={txn(23600, "UPI SHARMA ASSOC")} onDone={() => {}} />);
    openExpenseBill();
    fireEvent.change(screen.getByLabelText("Value before GST"), { target: { value: "20000" } });
    fireEvent.change(screen.getByLabelText("GST on the bill"), { target: { value: "3600" } });
    expect(screen.queryByText(/the books keep whole rupees/)).toBeNull();
  });
});

/* R-2325: an Expense bill recorded on the line offers the same categories as Expenses → Add
   expense (EXPENSE_CATEGORIES less Salaries) — also for a vendor whose usual head is COGS. */
describe("R-2325 — inline Expense bill categories = the Expenses page list", () => {
  it("Google (usual head COGS-Workspace) → Expense bill → the full expense list, no COGS heads", () => {
    render(<DebitPayForSection transaction={txn(2566, "NEFT GOOGLE CLOUD INDIA")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "v2" } });
    fireEvent.click(screen.getByLabelText(/The bill is not in the books yet/));
    fireEvent.click(screen.getByRole("button", { name: "Expense bill" }));
    const opts = [...(screen.getByLabelText("Category") as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);
    expect(opts).toEqual(["Professional Services", "Advertising", "Bank Charges", "Other"]);
  });
});

/* R-2338 (owner + CA, 1 Nov 2026): 194J split; the vendor's section is remembered only on the
   owner's tick. Sidhshree's saved section here is 194C (an old guess) — the owner switches to
   194J(a) technical services 2%. */
describe("R-2338 DebitPayForSection — 194J(a) 2% and 'Remember for this vendor'", () => {
  const SB: VendorOpenItem = {
    source: "expense", doc_id: "SB1", bill_no: "SW-1", doc_date: "2026-10-02", due_date: null, category: "Software",
    total: 100000, amount_due: 100000, gst: 0, tds_base: 100000, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
  };

  it("the picker offers the three 194J choices with the Act 2025 number; 194J(a) → 2%; Remember is unticked and sent only when ticked", async () => {
    state.fy = { base: 0, baseWithoutTds: 0 };
    state.items.v4 = [SB];
    state.pay.mockResolvedValue(result({ vendor_id: "v4", vendor_name: "Sidhshree Infotech" }));
    render(<DebitPayForSection transaction={txn(98000, "NEFT SIDHSHREE INFOTECH")} onDone={() => {}} />);
    const sel = screen.getByLabelText("TDS section") as HTMLSelectElement;
    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels).toContain("194J(a) Technical services · 2% — s.393(1) Sl. 6(iii)(a)");
    expect(labels).toContain("194J(b) Professional fees · 10% — s.393(1) Sl. 6(iii)(b)");
    expect(labels).toContain("194J Royalty – software licence · 10% — s.393(1) Sl. 6(iii)(d)");
    expect(Array.from(sel.options).map((o) => o.value)).not.toContain("194J");
    expect(sel.value).toBe("194C");   // the vendor's saved section, pre-picked
    expect(screen.queryByLabelText("Remember for this vendor")).toBeNull();   // already its section
    fireEvent.change(sel, { target: { value: "194JA" } });
    const remember = screen.getByLabelText("Remember for this vendor") as HTMLInputElement;
    expect(remember.checked).toBe(false);
    expect(screen.getByText(/Bills ₹1,00,000/).textContent).toContain("TDS ₹2,000");
    fireEvent.click(remember);
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    const arg = state.pay.mock.calls[0][0];
    expect([arg.items[0].tds, arg.items[0].section, arg.rememberSection]).toEqual([2000, "194JA", true]);
  });

  it("not ticked → the section is used for this payment only", async () => {
    state.fy = { base: 0, baseWithoutTds: 0 };
    state.items.v4 = [SB];
    state.pay.mockResolvedValue(result({ vendor_id: "v4", vendor_name: "Sidhshree Infotech" }));
    render(<DebitPayForSection transaction={txn(98000, "NEFT SIDHSHREE INFOTECH")} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("TDS section"), { target: { value: "194JA" } });
    fireEvent.click(saveButton());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay.mock.calls[0][0].rememberSection).toBe(false);
  });
});

/* R-2348: in the Reconcile sheet the section hands its Save to the sticky footer (onFooterSave) —
   the same label, the same disabled rule (canSave) and the same save(); no button in the form. */
function InSheet({ line }: { line: BankTransactionRow }) {
  const [save, setSave] = React.useState<FooterSave | null>(null);
  return (
    <>
      <div data-testid="reconcile-scroll-body"><DebitPayForSection transaction={line} onDone={() => {}} onFooterSave={setSave} /></div>
      <ReconcileFooter amount={line.debit ?? 0} save={save} hint="pick the vendor" onClose={() => {}} />
    </>
  );
}
describe("R-2348 DebitPayForSection — Record payment in the sticky footer", () => {
  it("the Sharma two-bill payment saves from the footer with the same RPC call", async () => {
    state.items.v1 = [exp({}), exp({ doc_id: "E2", bill_no: "PS-102", doc_date: "2026-09-15", total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000 })];
    state.pay.mockResolvedValue(result({ bank_amount: 64800 }));
    render(<InSheet line={txn(64800, "IMPS SHARMA ASSOCIATES FEES")} />);
    const body = screen.getByTestId("reconcile-scroll-body");
    const footer = screen.getByTestId("reconcile-footer");
    expect(within(body).queryByRole("button", { name: /^Record payment/ })).toBeNull();
    const btn = within(footer).getByRole("button", { name: "Record payment ₹64,800 to Sharma Associates & reconcile" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(footer.textContent).toContain("Bank ₹64,800 = ₹64,800 ✓");
    fireEvent.click(btn);
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    expect(state.pay.mock.calls[0][0]).toMatchObject({ transactionId: "t-64800", vendorId: "v1", advance: 0, bankCharge: 0, newBill: null });
    // booked → the footer has no Save any more (the section shows its Done panel)
    await vi.waitFor(() => expect(within(footer).queryByRole("button", { name: /^Record payment/ })).toBeNull());
  });

  it("the disabled rule is unchanged: amounts that do not add up keep the footer button disabled", () => {
    state.items.v1 = [exp({}), exp({ doc_id: "E2", bill_no: "PS-102", doc_date: "2026-09-15", total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000 })];
    render(<InSheet line={txn(64800, "IMPS SHARMA ASSOCIATES FEES")} />);
    fireEvent.change(screen.getByLabelText("Bank charge"), { target: { value: "500" } });
    const footer = screen.getByTestId("reconcile-footer");
    const btn = within(footer).getByRole("button", { name: /^Record payment/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(state.pay).not.toHaveBeenCalled();
  });

  it("no vendor picked yet: no Save in the footer", () => {
    render(<InSheet line={txn(5000, "UPI 9876@okhdfc")} />);
    expect(within(screen.getByTestId("reconcile-footer")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });
});
