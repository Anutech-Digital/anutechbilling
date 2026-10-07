// @vitest-environment jsdom
//
// R-344 (7 Oct 2026) — the rest of R-335 on the invoice screens. Display only, no tax change:
//  1. a credit note dated after its invoice's GST s.34(2) limit shows a "Late" tag in the
//     invoice's notes list (in-time credit notes and every debit note do not);
//  2. the list page hands the credit-note dialog the invoice date it already has, so the
//     dialog does not run its own fetch for it.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, within } from "@testing-library/react";

const credit = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const debit = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/queries/credit-notes", () => ({ useCreditNotesByInvoice: () => ({ data: credit.rows }) }));
vi.mock("@/lib/queries/debit-notes", () => ({ useDebitNotesByInvoice: () => ({ data: debit.rows }) }));

import { InvoiceNotesList } from "./invoice-detail";

afterEach(cleanup);

// Invoice of 10 Jun 2024 (FY 2024-25) → s.34 limit is 30 Nov 2025.
const INVOICE_DATE = "2024-06-10";

function rowFor(id: string) {
  return screen.getByText(id).closest("li") as HTMLElement;
}

describe("Invoice notes list — late credit note tag (R-344)", () => {
  it("tags a credit note dated after the s.34 limit, not one in time, and never a debit note", () => {
    credit.rows = [
      { id: "CN-LATE", reason_code: "seats_reduced", amount: 1180, credit_date: "2025-12-01" },
      { id: "CN-OK", reason_code: "seats_reduced", amount: 590, credit_date: "2025-11-30" },
    ];
    debit.rows = [{ id: "DN-1", reason_code: "undercharge", amount: 100, debit_date: "2026-01-05" }];
    render(<InvoiceNotesList invoiceId="INV-1" invoiceDate={INVOICE_DATE} />);

    const late = within(rowFor("CN-LATE")).getByText("Late");
    expect(late.getAttribute("title")).toMatch(/s\.34/);
    expect(within(rowFor("CN-OK")).queryByText("Late")).toBeNull();
    expect(within(rowFor("DN-1")).queryByText("Late")).toBeNull();
  });

  it("shows no tag when the invoice date is not known", () => {
    credit.rows = [{ id: "CN-LATE", reason_code: "seats_reduced", amount: 1180, credit_date: "2026-06-01" }];
    debit.rows = [];
    render(<InvoiceNotesList invoiceId="INV-1" />);
    expect(screen.queryByText("Late")).toBeNull();
  });
});

describe("Invoice screens pass the invoice date (R-344)", () => {
  const dir = join(process.cwd(), "src/app/(app)/invoices");
  const list = readFileSync(join(dir, "page.tsx"), "utf8");
  const detail = readFileSync(join(dir, "invoice-detail.tsx"), "utf8");

  it("the credit-note dialog on the list gets invoiceDate as a prop (no extra fetch)", () => {
    const creditDialog = list.match(/<IssueCreditNoteDialog\s+open=\{cnOpen\}[\s\S]*?\/>/)?.[0] ?? "";
    expect(creditDialog).toContain("invoiceDate={inv.invoice_date}");
  });

  it("both notes lists get the invoice date for the Late tag", () => {
    expect(list).toContain("<InvoiceNotesList invoiceId={inv.id} invoiceDate={inv.invoice_date} />");
    expect(detail).toContain("<InvoiceNotesList invoiceId={invoice.id} invoiceDate={invoice.invoice_date} />");
  });
});
