// @vitest-environment jsdom
/* R-2324 — Reconcile → money-out line → vendor with many open bills (R-2319: one distributor
   payment covers 40–54 COGS bills). Nothing is ticked when the bank amount is not exactly one bill
   or all of them; "Select bills oldest first, up to ₹…" ticks the oldest bills that cover it, the
   last one part-paid, and that is what reaches the server. Made-up vendor and bills. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { VendorOpenItem, VendorPayResult } from "@/lib/banking/debit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ items: [] as unknown[], pay: vi.fn() }));

vi.mock("@/lib/queries/vendors", () => ({
  useVendors: () => ({ data: [{ id: "vd", name: "T-Distributor Pvt Ltd", gstin: "27AAACT1111A1Z9", default_category: "COGS-M365" }] }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Other"],
  useVendorTdsThisFy: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/vendor-bills", () => ({ VENDOR_BILL_CATEGORIES: ["COGS-M365", "COGS-Other"] }));
vi.mock("@/lib/queries/bank-debit-pay-for", () => ({
  useVendorOpenItems: (id: string | null) => ({ data: id ? state.items : undefined, isLoading: false }),
  usePayVendorFromBankDebit: () => ({ mutateAsync: state.pay, isPending: false }),
  useVendor194q: (id: string | null) => ({ data: id ? [] : undefined }),
  useSet194qBuyer: () => ({ mutate: vi.fn(), isPending: false }),
  useVendorNarrationAliases: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendor-advance", () => ({ useApplyVendorAdvance: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));

import { DebitPayForSection } from "./debit-pay-for-section";

afterEach(cleanup);

const bill = (n: number): VendorOpenItem => ({
  source: "vendor_bill", doc_id: `B${n}`, bill_no: `RD-${100 + n}`, doc_date: new Date(Date.UTC(2026, 7, n)).toISOString().slice(0, 10),
  due_date: null, category: "COGS-M365", total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0,
  tds_section: null, can_part: true, in_run: null,
});
const txn = (debit: number): BankTransactionRow => ({
  id: `t-${debit}`, bank_account_id: "b1", txn_date: "2026-10-11", description: "NEFT T-DISTRIBUTOR PVT LTD", debit, credit: 0, reference: null,
} as unknown as BankTransactionRow);
const result = (): VendorPayResult => ({
  vendor_id: "vd", vendor_name: "T-Distributor Pvt Ltd", vendor_created: false, bank_amount: 0, paid: [], new_bill: null,
  advance: null, bank_charge: null, tds_total: 0, tds_section: null,
});

describe("R-2324 DebitPayForSection — select bills oldest first up to the bank amount", () => {
  it("12 open bills, ₹50,000 paid → the 5 oldest ticked, the 5th part-paid, sent to the server", async () => {
    state.items = Array.from({ length: 12 }, (_, i) => bill(12 - i)); // newest first, as a list may come
    state.pay.mockReset();
    state.pay.mockResolvedValue(result());
    render(<DebitPayForSection transaction={txn(50000)} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "vd" } });
    const ticked = () => screen.getAllByRole("checkbox", { name: /^Pay Bill RD-/ }).filter((c) => (c as HTMLInputElement).checked);
    expect(ticked()).toHaveLength(0); // the exact-sum guess finds nothing for ₹50,000

    fireEvent.click(screen.getByRole("button", { name: "Select bills oldest first, up to ₹50,000" }));
    expect(ticked().map((c) => /RD-[0-9]+/.exec(c.getAttribute("aria-label") ?? "")?.[0]).sort()).toEqual(["RD-101", "RD-102", "RD-103", "RD-104", "RD-105"]);
    expect(screen.getByText("12 open bills · 5 ticked")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Record payment/ }));
    await screen.findByText("Done — this bank line is reconciled");
    const sent = state.pay.mock.calls[0][0].items.map((x: { item: VendorOpenItem; cash: number }) => [x.item.bill_no, x.cash])
      .sort((a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]));
    expect(sent).toEqual([["RD-101", 11800], ["RD-102", 11800], ["RD-103", 11800], ["RD-104", 11800], ["RD-105", 2800]]);
  });

  it("one open bill → no bulk button", () => {
    state.items = [bill(1)];
    render(<DebitPayForSection transaction={txn(5000)} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor paid"), { target: { value: "vd" } });
    expect(screen.queryByRole("button", { name: /Select bills oldest first/ })).toBeNull();
  });
});
