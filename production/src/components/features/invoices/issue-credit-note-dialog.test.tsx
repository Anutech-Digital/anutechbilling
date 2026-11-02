// @vitest-environment jsdom
/* R-2219 (31 Oct 2026) — the credit / debit note form says what is REALLY still owed: the same
   invoiceAmountDue the invoice page shows as "Balance due" (net_payable − paid_amount; the note
   RPCs keep net_payable = amount − credit notes + debit notes).
   Owner's real case (local, R-2178 check): INV-F588-27-0007 ₹38,232, ₹5,000 received → Balance
   due ₹33,232, but the credit note form said "₹38,232 still owed" and pre-filled ₹38,232; after
   CN ₹33,232 (net_payable 5,000) the debit note form said "₹5,000 still owed" for a ₹0 balance. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { invoiceAmountDue } from "@/lib/payments/amount-due";

vi.mock("@/lib/queries/credit-notes", () => ({ useIssueCreditNote: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/debit-notes", () => ({ useIssueDebitNote: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: null }) }));

import { IssueCreditNoteDialog } from "./issue-credit-note-dialog";

afterEach(cleanup);

/* INV-F588-27-0007 as the local DB holds it at each step of the owner's path. */
const PART_PAID = { id: "INV-F588-27-0007", status: "pending", amount: 38232, net_payable: 38232, paid_amount: 5000, written_off_at: null };
const AFTER_CN = { ...PART_PAID, net_payable: 5000 };                 // CN-F588-27-0008 ₹33,232 issued
const AFTER_DN = { ...PART_PAID, net_payable: 38232 };                // DN-F588-27-0001 ₹33,232 issued
const FULLY_PAID = { id: "INV-PAID", status: "paid", amount: 11800, net_payable: 11800, paid_amount: 11800, written_off_at: null };
const SIMPLE_PART = { id: "INV-SIMPLE", status: "pending", amount: 11800, net_payable: 11800, paid_amount: 1800, written_off_at: null };

function open(inv: typeof PART_PAID, mode: "credit" | "debit" = "credit") {
  render(
    <IssueCreditNoteDialog
      open onOpenChange={() => {}} invoiceId={inv.id} customerName="T-M3-19Oct"
      amountDue={invoiceAmountDue(inv)} taxRate={18} interState mode={mode} invoiceDate="2026-10-19"
    />,
  );
}
const owed = () => screen.getByTestId("note-amount-owed").textContent;
const amountInput = () => screen.getByLabelText(/amount \(₹, incl GST\)/) as HTMLInputElement;

describe("R-2219 credit / debit note form — Amount still owed = the invoice's Balance due", () => {
  it("part-paid ₹38,232 / ₹5,000 in: credit note says ₹33,232 owed and pre-fills ₹33,232 (not ₹38,232)", () => {
    open(PART_PAID);
    expect(owed()).toContain("33,232");
    expect(owed()).not.toContain("38,232");
    expect(amountInput().value).toBe("33232");
    expect(screen.queryByTestId("note-over-balance")).toBeNull();
  });

  it("credit typed above the balance → warns (not blocks) and says what the extra means", () => {
    open(PART_PAID);
    fireEvent.change(amountInput(), { target: { value: "38232" } });
    const warn = screen.getByTestId("note-over-balance");
    expect(warn.textContent).toContain("5,000");
    expect(warn.textContent).toMatch(/customer credit/i);
    const submit = screen.getByRole("button", { name: /Issue credit note/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("after the CN and DN the balance is still ₹33,232 — the debit form says so, no pre-fill", () => {
    open(AFTER_DN, "debit");
    expect(owed()).toContain("33,232");
    expect(amountInput().value).toBe("");
  });

  it("settled (CN covered the balance, net_payable 5,000 = paid): debit note says ₹0 owed, not ₹5,000", () => {
    open(AFTER_CN, "debit");
    expect(owed()).toContain("₹0");
    expect(owed()).not.toContain("5,000");
    expect(amountInput().value).toBe("");
  });

  it("fully paid invoice: debit note says ₹0 owed; credit note pre-fills nothing", () => {
    open(FULLY_PAID, "debit");
    expect(owed()).toContain("₹0");
    cleanup();
    open(FULLY_PAID, "credit");
    expect(owed()).toContain("₹0");
    expect(amountInput().value).toBe("");
  });

  it("simple part-paid ₹11,800 / ₹1,800 in: credit note pre-fills ₹10,000", () => {
    open(SIMPLE_PART);
    expect(owed()).toContain("10,000");
    expect(amountInput().value).toBe("10000");
  });
});

describe("R-2219 every caller hands the dialog the invoice's Balance due (invoiceAmountDue)", () => {
  const root = process.cwd();
  const files = [
    "src/app/(app)/invoices/page.tsx",
    "src/app/(app)/invoices/invoice-detail.tsx",
  ];
  it.each(files)("%s passes amountDue={invoiceAmountDue(...)} — never net_payable", (f) => {
    const src = readFileSync(join(root, f), "utf8");
    const dialogs = src.match(/<IssueCreditNoteDialog[\s\S]*?\/>/g) ?? [];
    expect(dialogs.length).toBeGreaterThan(0);
    for (const d of dialogs) {
      expect(d).toMatch(/amountDue=\{invoiceAmountDue\(\w+\)\}/);
      expect(d).not.toMatch(/net_payable/);
    }
  });
});
