// @vitest-environment jsdom
//
// R-2632 (10 Nov 2026) — an issued invoice's date never crosses into another financial year (the number is
// per FY and never changes; SQL correct_invoice_date refuses it, test r2632). The Correct date sheet says the
// next step and its "Credit note instead" button closes the sheet and opens the credit note (invoice page).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CorrectInvoiceDateButton, otherYearNote, type CorrectableInvoice } from "./correct-invoice-date-dialog";

afterEach(cleanup);

const inv: CorrectableInvoice = {
  id: "INV-T-2026-27-0001", invoice_date: "2026-04-20", status: "paid", document_kind: "tax_invoice",
  gst_irn: null, zoho_invoice_id: null, currency: "INR", fx_rate: null,
};

function open(onCreditNoteInstead?: () => void) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CorrectInvoiceDateButton invoice={inv} role="owner" onCreditNoteInstead={onCreditNoteInstead} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("correct-invoice-date"));
}

describe("R-2632 otherYearNote", () => {
  it("names the invoice's own FY and the next step (credit note + fresh invoice)", () => {
    const t = otherYearNote("2026-04-20");
    expect(t).toMatch(/FY 2026-27/);
    expect(t).toMatch(/never changes/);
    expect(t).toMatch(/credit note for this invoice/);
    expect(t).toMatch(/fresh invoice dated in the right year/);
  });
  it("31 Mar belongs to the year before", () => {
    expect(otherYearNote("2026-03-31")).toMatch(/FY 2025-26/);
  });
});

describe("R-2632 Correct date sheet — another financial year", () => {
  it("shows the note and 'Credit note instead'; the button closes the sheet and opens the credit note", () => {
    const onCn = vi.fn();
    open(onCn);
    expect(screen.getByTestId("correct-invoice-date-other-year").textContent).toMatch(/FY 2026-27/);
    fireEvent.click(screen.getByTestId("correct-invoice-date-credit-note"));
    expect(onCn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("correct-invoice-date-other-year")).toBeNull();
  });
  it("without credit note rights: the note shows, no button", () => {
    open(undefined);
    expect(screen.getByTestId("correct-invoice-date-other-year")).toBeTruthy();
    expect(screen.queryByTestId("correct-invoice-date-credit-note")).toBeNull();
  });
});
