// @vitest-environment jsdom
/* R-2717 — the credit / debit note form on an invoice whose lines carry different GST rates.
   Owner's example (R-2702: INV/25-26/1248): ₹10,000 at 0% + ₹20,000 at 18%, GST ₹3,600, total
   ₹33,600, invoices.tax_rate NULL. Before: the form said "Splits as IGST @ 18%: taxable ₹14,237 +
   tax ₹2,563" for a ₹16,800 credit; the note is ₹15,000 + ₹1,800 (split like the invoice). */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { noteSplitRule, type NoteSplitRule } from "@/lib/gst/line-rates";

const state: { rule: NoteSplitRule | null; loading: boolean } = { rule: null, loading: false };

vi.mock("@/lib/queries/credit-notes", () => ({ useIssueCreditNote: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/debit-notes", () => ({ useIssueDebitNote: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) =>
    o.queryKey[1] === "note-split-rule" ? { data: state.loading ? undefined : state.rule, isLoading: state.loading } : { data: null, isLoading: false },
}));

import { IssueCreditNoteDialog } from "./issue-credit-note-dialog";

afterEach(() => { cleanup(); state.rule = null; state.loading = false; });

const LINES = [
  { name: "Domain renewal", qty: 1, rate: 10000, amount: 10000, tax_rate: 0 },
  { name: "Workspace", qty: 2, rate: 10000, amount: 20000, tax_rate: 18 },
];
const MIXED = noteSplitRule({ taxable_value: 30000, tax_amount: 3600, tax_rate: null, line_items: LINES });

function open(mode: "credit" | "debit" = "credit") {
  render(
    <IssueCreditNoteDialog
      open onOpenChange={() => {}} invoiceId="INV/25-26/1248" customerName="Acme"
      amountDue={33600} taxRate={null} interState mode={mode} invoiceDate="2026-11-10"
    />,
  );
}
const amountInput = () => screen.getByLabelText(/amount \(₹, incl GST\)/) as HTMLInputElement;
const text = () => (document.body.textContent ?? "").replace(/ /g, " ");
const issue = (noun: RegExp) => screen.getByRole("button", { name: noun }) as HTMLButtonElement;

describe("R-2717 credit / debit note form on a mixed-rate invoice", () => {
  it("₹16,800 credit → 'split like the invoice: taxable ₹15,000 + IGST ₹1,800', never 'IGST @ 18%'", () => {
    state.rule = MIXED;
    open();
    fireEvent.change(amountInput(), { target: { value: "16800" } });
    expect(text()).toContain("This invoice has lines at different GST rates (0% + 18%). The note is split like the invoice: taxable ₹15,000 + IGST ₹1,800.");
    expect(text()).not.toMatch(/Splits as IGST @/);
    expect(issue(/Issue credit note/).disabled).toBe(false);
  });

  it("debit note ₹3,360 on it → taxable ₹3,000 + IGST ₹360 (the same rule)", () => {
    state.rule = MIXED;
    open("debit");
    fireEvent.change(amountInput(), { target: { value: "3360" } });
    expect(text()).toContain("taxable ₹3,000 + IGST ₹360");
  });

  it("while the invoice's rates are being read: no guessed split, Issue waits", () => {
    state.loading = true;
    open();
    expect(text()).toContain("Checking the invoice's GST rates…");
    expect(text()).not.toMatch(/Splits as IGST @/);
    expect(issue(/Issue credit note/).disabled).toBe(true);
  });

  it("different rates but no taxable / GST on record → says why and Issue is off (the RPC refuses the same)", () => {
    state.rule = noteSplitRule({ taxable_value: null, tax_amount: null, tax_rate: null, line_items: LINES });
    open();
    expect(text()).toContain("but no taxable value and GST on record, so a note cannot be split. Correct the invoice first.");
    expect(issue(/Issue credit note/).disabled).toBe(true);
  });

  it("tax_rate NULL but every line at 0% → 'IGST @ 0%', not the 18% default", () => {
    state.rule = noteSplitRule({ taxable_value: 10000, tax_amount: 0, tax_rate: null, line_items: [{ qty: 1, rate: 10000, amount: 10000, tax_rate: 0 }] });
    open();
    fireEvent.change(amountInput(), { target: { value: "4000" } });
    expect(text()).toContain("Splits as IGST @ 0%: taxable ₹4,000 + tax ₹0.");
  });

  it("an ordinary invoice (no line rates): the form as before", () => {
    state.rule = { kind: "rate", rate: 18 };
    open();
    fireEvent.change(amountInput(), { target: { value: "11800" } });
    expect(text()).toContain("Splits as IGST @ 18%: taxable ₹10,000 + tax ₹1,800.");
    expect(issue(/Issue credit note/).disabled).toBe(false);
  });
});
