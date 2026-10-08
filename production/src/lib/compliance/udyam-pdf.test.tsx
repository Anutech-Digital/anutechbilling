// @vitest-environment jsdom
/* R-368 — the company's Udyam number is printed under the GSTIN on the quote and the invoice
   PDF when set, and nothing is printed when it is not. Both documents rendered for real with
   the @react-pdf primitives mocked to div/span (as quote-support-line.test.tsx does). */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null, Link: box,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { InvoicePDF } from "@/lib/pdf/InvoicePDF";

afterEach(cleanup);

const amounts = { subtotal: 1000, discountPct: 0, discount: 0, taxable: 1000, taxRate: 18, tax: 180, total: 1180 };
const lines = [{ id: "l1", name: "Google Workspace Business Starter", qty: 1, rate: 1000, cost: 900, commitment: "annual_yearly" as const }];

function quoteText(udyamNumber?: string | null): string {
  const { container } = render(
    <QuotePDF tenantName="ANUTECH" tenantGstin="07ABDCA0298H1ZP" udyamNumber={udyamNumber}
      quoteId="Q-R368" customerName="Test Co" validityDays={7}
      interState={false} billingCycle="yearly" lineItems={lines} {...amounts} />,
  );
  const t = container.textContent ?? "";
  cleanup();
  return t;
}

function invoiceText(udyamNumber?: string | null): string {
  const props = {
    invoice: { id: "INV-R368-0001", customer_name: "Test Co", amount: 1180, invoice_date: "2026-10-07", status: "pending" },
    lineItems: lines, ...amounts, interState: false,
    tenantName: "ANUTECH", tenantGstin: "07ABDCA0298H1ZP", udyamNumber,
  };
  const { container } = render(<InvoicePDF {...(props as unknown as React.ComponentProps<typeof InvoicePDF>)} />);
  const t = container.textContent ?? "";
  cleanup();
  return t;
}

describe("Udyam on PDFs (R-368)", () => {
  it("quote: printed when set, absent when not", () => {
    expect(quoteText("UDYAM-DL-01-0012345")).toContain("MSME Udyam: UDYAM-DL-01-0012345");
    expect(quoteText(null)).not.toContain("Udyam");
    expect(quoteText(undefined)).not.toContain("Udyam");
  });
  it("invoice: printed when set, absent when not or malformed", () => {
    expect(invoiceText("UDYAM-DL-01-0012345")).toContain("MSME Udyam: UDYAM-DL-01-0012345");
    expect(invoiceText(null)).not.toContain("Udyam");
    expect(invoiceText("junk")).not.toContain("Udyam");
  });
});
