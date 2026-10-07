// @vitest-environment jsdom
/* R-367 — the quote preview and the quote PDF print the SAME included-support line, from
   one builder (includedSupportLine). Both documents are rendered for real (@react-pdf
   primitives mocked to div/span, as in quote-gst-heads.test.tsx) and their text read back. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { QuotePDF } from "./QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { includedSupportLine } from "./quote-support-line";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const licence = { id: "l1", name: "Google Workspace Business Starter", qty: 2, rate: 1650, cost: 1500, commitment: "annual_yearly" };
const paid = { id: "s1", item_id: "SUP-STANDARD-YR-t1", name: "Standard Support (Yearly)", qty: 1, rate: 9996, cost: 0, commitment: "annual_yearly" };
const productSupport = { id: "s2", item_id: "SUP-GWS-STARTER-YR", name: "Workspace Starter Support", qty: 1, rate: 2000, cost: 0 };
const typedSupport = { id: "s3", name: "Standard support", qty: 1, rate: 999, cost: 0 };

const amounts = { subtotal: 3300, discountPct: 0, discount: 0, taxable: 3300, taxRate: 18, tax: 594, total: 3894 };

function pdfText(lineItems: QuoteLineItem[]): string {
  const { container } = render(
    <QuotePDF tenantName="ANUTECH" quoteId="Q-R367" customerName="Test Co" validityDays={7}
      interState={false} billingCycle="yearly" lineItems={lineItems} {...amounts} />,
  );
  const t = container.textContent ?? "";
  cleanup();
  return t;
}

function previewText(lineItems: QuoteLineItem[]): string {
  render(
    <QuotePreviewDialog open onOpenChange={() => {}} tenantName="ANUTECH" quoteId="Q-R367" customerName="Test Co"
      interState={false} billingCycle="yearly" validityDays={7} notes="" lineItems={lineItems} {...amounts} />,
  );
  const t = document.body.textContent ?? "";
  cleanup();
  return t;
}

describe("includedSupportLine", () => {
  it("licence-only quote → Free, Included, with the tier summary", () => {
    const l = includedSupportLine([licence]);
    expect(l).toEqual({
      planName: "Free",
      text: "Support: Free — Included",
      detail: "Email helpdesk, answered within a working day. · First response in 24h · Email only · No live calls",
    });
  });
  it("paid plan / product add-on / typed support line → null", () => {
    expect(includedSupportLine([licence, paid])).toBeNull();
    expect(includedSupportLine([licence, productSupport])).toBeNull();
    expect(includedSupportLine([licence, typedSupport])).toBeNull();
  });
  it("empty or missing → null", () => {
    expect(includedSupportLine([])).toBeNull();
    expect(includedSupportLine(null)).toBeNull();
  });
});

describe("preview and PDF print the same line", () => {
  it("licence-only quote: both show 'Support: Free — Included'", () => {
    const items = [licence] as unknown as QuoteLineItem[];
    const want = includedSupportLine(items)!.text;
    expect(pdfText(items)).toContain(want);
    expect(previewText(items)).toContain(want);
  });

  it("paid support on the quote: neither shows it, and the priced line remains", () => {
    const items = [licence, paid] as unknown as QuoteLineItem[];
    const pdf = pdfText(items);
    const prev = previewText(items);
    expect(pdf).not.toContain("— Included");
    expect(prev).not.toContain("— Included");
    expect(pdf).toContain("Standard Support (Yearly)");
    expect(prev).toContain("Standard Support (Yearly)");
  });

  it("PDF honours an explicit null from build-props", () => {
    const { container } = render(
      <QuotePDF tenantName="ANUTECH" quoteId="Q-R367" customerName="Test Co" validityDays={7}
        interState={false} billingCycle="yearly" lineItems={[licence] as unknown as QuoteLineItem[]}
        includedSupport={null} {...amounts} />,
    );
    expect(container.textContent).not.toContain("— Included");
  });
});
