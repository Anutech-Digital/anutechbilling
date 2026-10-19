// @vitest-environment jsdom
//
// R-1677 — the staff "customer will see it" preview of a USD export quote must show the same
// dollar total as the builder, the customer's accept page and the PDF: $33.84 × 10 = $338.40.
// It printed $338.39 (₹32,400 ÷ 95.7485 per figure) or, without the currency passed, ₹32,400.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QuotePreviewDialog } from "./quote-preview-dialog";

afterEach(cleanup);

const base = {
  open: true, onOpenChange: () => {}, tenantName: "Anutech", quoteId: "Q-5F40-27-0100",
  customerName: "Acme Inc", lineItems: [{ id: "l1", name: "Google Workspace Business Starter", qty: 10, rate: 3240, cost: 1320, commitment: "annual_yearly" as const }],
  subtotal: 32400, discountPct: 0, discount: 0, taxable: 32400, taxRate: 0, tax: 0, total: 32400,
  interState: true, isExport: true, validityDays: 30, notes: "",
};

describe("QuotePreviewDialog — USD export quote (R-1677)", () => {
  it("shows $33.84 a seat and $338.40 in total, never $338.39", () => {
    render(<QuotePreviewDialog {...base} currency="USD" exchangeRate={95.7485} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("$33.84");
    expect(text).toContain("$338.40");
    expect(text).not.toContain("$338.39");
    /* The ₹ books value stays visible as the GST reference. */
    expect(text).toContain("32,400");
  });
});
