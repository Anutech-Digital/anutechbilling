// @vitest-environment jsdom
/* R-1920 — Banking → a line paid to a vendor → Un-reconcile: the dialog lists what goes back
   (from the server's dry run, vendor_payment_undo_preview) before the click; a refusal (later
   payment, used advance, deposited TDS) shows instead of the confirm, with the page to fix it on. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { UnreconcileImpact, VendorUndoLeg, VendorUndoPreview, ProjectUndoRow, ProjectUndoPreview } from "@/lib/queries/unreconcile";

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
import { vendorUndoLegLine, projectUndoRowLine, projectUndoneToast } from "@/lib/queries/unreconcile";

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

/* R-1999 — Banking → a line booked to the WRONG project → Un-reconcile: the dialog lists every kist
   the line paid (R-1995 shares one line across several; R-1996 adds TDS), from the server's dry run
   (project_receipt_undo_preview). The whole booking goes back; each invoice stays, due again (D3). */
const kist = (over: Partial<ProjectUndoRow>): ProjectUndoRow => ({
  milestone_id: "m1", label: "Kist 1", project_id: "p1", project_title: "App build", customer_name: "Demo Client",
  total: 118000, bank: 106200, tds: 11800, before_paid: 118000, before_status: "paid",
  invoice_id: "INV-0001", invoice_status_before: "paid", after_paid: 0, after_status: "invoiced",
  invoice_status_after: "pending", href: "/projects/p1", ...over,
});
const projectPreview = (over: Partial<ProjectUndoPreview>): ProjectUndoPreview => ({
  txn_id: "t2", credit: 212400, txn_date: "2026-10-16", customer_name: "Demo Client", project_title: "App build",
  rows: [kist({}), kist({ milestone_id: "m2", label: "Kist 2", invoice_id: "INV-0002" })],
  bank_total: 212400, tds_total: 23600, blocked: false, block_message: null, block_href: null, ...over,
});
const projectTxn = { ...txn, id: "t2", debit: 0, credit: 212400, matched_to_type: "project", matched_to_id: "pp1" } as unknown as BankTransactionRow;

describe("R-1999 un-reconcile a project receipt — whole booking, invoices stay", () => {
  it("lists BOTH kists with TDS, each back to Invoiced and its invoice due again; confirm un-reconciles", async () => {
    impact = { kind: "project", preview: projectPreview({}) };
    const onClose = vi.fn();
    render(<UnreconcileDialog txn={projectTxn} onClose={onClose} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Kist 1 (App build): ₹1,06,200 payment + ₹11,800 TDS removed — back to Invoiced; invoice INV-0001 stays, ₹1,18,000 due again");
    expect(items[1]).toContain("invoice INV-0002 stays, ₹1,18,000 due again");
    expect(screen.getByText(/No credit note/)).toBeTruthy();
    expect(screen.queryByText(/remove it from the/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Un-reconcile & reverse" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ txnId: "t2", undoSale: false });
  });

  it("a refusal (TDS certificate already in) shows the reason and the TDS page — no confirm", () => {
    impact = {
      kind: "project",
      preview: projectPreview({
        rows: [kist({ after_paid: undefined, after_status: undefined, invoice_status_after: undefined })],
        blocked: true,
        block_message: "The ₹11800 TDS on this receipt (TDS-1) is already marked \"cert received\" on TDS receivable.",
        block_href: "/accounting/tds-receivable",
      }),
    };
    render(<UnreconcileDialog txn={projectTxn} onClose={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("cert received");
    expect(screen.queryByRole("button", { name: /Un-reconcile/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open TDS receivable" }).getAttribute("href")).toBe("/accounting/tds-receivable");
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("Kist 1 (App build): ₹1,06,200 payment + ₹11,800 TDS removed");
  });

  it("a refusal with no page (only an owner or accountant may remove payments) shows no button to go on", () => {
    impact = { kind: "project", preview: projectPreview({ blocked: true, block_message: "Only an owner or accountant can remove a payment — ask them to un-reconcile this line.", block_href: null }) };
    render(<UnreconcileDialog txn={projectTxn} onClose={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("owner or accountant");
    expect(screen.queryByRole("button", { name: /Un-reconcile/ })).toBeNull();
  });
});

describe("R-1999 projectUndoRowLine / projectUndoneToast", () => {
  it("a kist with no invoice goes back to Pending; a part-paid kist keeps the rest", () => {
    expect(projectUndoRowLine(kist({ tds: 0, bank: 5000, invoice_id: null, after_status: "pending" })))
      .toBe("Kist 1 (App build): ₹5,000 payment removed — back to Pending");
    expect(projectUndoRowLine(kist({ tds: 0, bank: 50000, after_paid: 68000, after_status: "invoiced" })))
      .toBe("Kist 1 (App build): ₹50,000 payment removed — back to Invoiced; invoice INV-0001 stays, ₹50,000 due again");
  });
  it("the toast names the money and the invoice due again", () => {
    expect(projectUndoneToast(118000, 0, ["INV-9"])).toBe("Un-reconciled · project payment ₹1,18,000 removed · invoice INV-9 is due again");
    expect(projectUndoneToast(212400, 23600, ["A", "B"])).toBe("Un-reconciled · project payment ₹2,12,400 + ₹23,600 TDS removed · 2 invoices are due again");
  });
});
