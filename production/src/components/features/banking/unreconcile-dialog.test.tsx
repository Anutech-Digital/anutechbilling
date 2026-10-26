// @vitest-environment jsdom
/* R-1920 — Banking → a line paid to a vendor → Un-reconcile: the dialog lists what goes back
   (from the server's dry run, vendor_payment_undo_preview) before the click; a refusal (later
   payment, used advance, deposited TDS) shows instead of the confirm, with the page to fix it on. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { UnreconcileImpact, VendorUndoLeg, VendorUndoPreview } from "@/lib/queries/unreconcile";

const mutateAsync = vi.fn();
let impact: UnreconcileImpact | undefined;
vi.mock("@/lib/queries/unreconcile", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/unreconcile")>()),
  useUnreconcileImpact: () => ({ data: impact, isLoading: false }),
  useUnreconcileBankTxn: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
}));

import { UnreconcileDialog } from "./unreconcile-dialog";
import { vendorUndoLegLine } from "@/lib/queries/unreconcile";

const txn = {
  id: "t1", tenant_id: "x", bank_account_id: "acc-1", txn_date: "2026-10-05", description: "NEFT SHARMA ASSOCIATES",
  debit: 55020, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: "vendor_payment", matched_to_id: "v1", matched_at: null, matched_by: null, match_confidence: "manual",
  imported_at: "", created_at: "", updated_at: "",
} as unknown as BankTransactionRow;

const leg = (over: Partial<VendorUndoLeg>): VendorUndoLeg => ({
  id: "l1", kind: "expense", cash: 54000, tds_amount: 5000, tds_section: "194J", doc_type: "expense",
  doc_id: "EXP-1", doc_no: "PS-101", doc_total: 59000, before_paid: 54000, before_status: "paid",
  after_paid: 0, after_status: "unpaid", removed: false, href: "/accounting/expenses", ...over,
});
const preview = (over: Partial<VendorUndoPreview>): VendorUndoPreview => ({
  txn_id: "t1", debit: 55020, txn_date: "2026-10-05", vendor_name: "Sharma Associates",
  legs: [
    leg({}),
    leg({ id: "l2", kind: "advance", doc_type: "advance", doc_id: "a1", doc_no: null, cash: 1000, tds_amount: 0, tds_section: null, removed: true, href: "/accounting/prepaid" }),
    leg({ id: "l3", kind: "bank_charge", doc_id: "EXP-2", doc_no: null, cash: 20, tds_amount: 0, tds_section: null, removed: true }),
  ],
  blocked: false, block_message: null, block_href: null, ...over,
});

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({}); });

describe("R-1920 un-reconcile a vendor payment — preview first", () => {
  it("lists every leg: PS-101 back to Unpaid with ₹59,000 due and TDS off, advance and bank charge removed; confirm un-reconciles", async () => {
    impact = { kind: "vendor-payment", preview: preview({}) };
    const onClose = vi.fn();
    render(<UnreconcileDialog txn={txn} onClose={onClose} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Expense bill PS-101 goes back to Unpaid, ₹59,000 due again");
    expect(items[0]).toContain("TDS ₹5,000 (194J) taken off");
    expect(items[1]).toContain("Advance of ₹1,000 to the vendor is removed");
    expect(items[2]).toContain("Bank charge of ₹20 is removed");
    expect(screen.getByText(/This line paid/).textContent).toContain("Sharma Associates");
    fireEvent.click(screen.getByRole("button", { name: "Un-reconcile & reverse" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ txnId: "t1", undoSale: false });
  });

  it("a refusal (deposited TDS) shows the reason and the page to fix it on — no confirm", () => {
    impact = {
      kind: "vendor-payment",
      preview: preview({
        legs: [leg({ after_paid: undefined, after_status: undefined, removed: undefined })],
        blocked: true,
        block_message: "The ₹5,000 TDS this payment withheld on bill PS-101 is already deposited (TDS challan CIN0920 …).",
        block_href: "/accounting/banking/acc-2",
      }),
    };
    render(<UnreconcileDialog txn={txn} onClose={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("already deposited");
    expect(screen.queryByRole("button", { name: /Un-reconcile/ })).toBeNull();
    const open = screen.getByRole("link", { name: "Open Banking" });
    expect(open.getAttribute("href")).toBe("/accounting/banking/acc-2");
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("Expense bill PS-101: ₹54,000 from this line comes off; TDS ₹5,000 (194J) taken off");
  });
});

describe("R-1920 vendorUndoLegLine", () => {
  it("a bill created from the line is deleted; one kept (other payments on it) goes back to Part paid", () => {
    expect(vendorUndoLegLine(leg({ kind: "new_bill", doc_type: "vendor_bill", doc_no: "G-77", doc_total: 11800, cash: 11800, tds_amount: 0, removed: true })))
      .toBe("Bill G-77 (₹11,800), created from this line, is deleted");
    expect(vendorUndoLegLine(leg({ kind: "new_bill", doc_type: "vendor_bill", doc_no: "G-77", cash: 5000, tds_amount: 0, after_status: "partial", after_paid: 6800 })))
      .toBe("Bill G-77 goes back to Part paid (₹6,800 paid stays) — ₹5,000 from this line comes off");
  });
});
