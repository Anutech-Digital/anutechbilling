// @vitest-environment jsdom
/* R-376 (f): the quote preview said "Inter-state (IGST applies)" — no state. GST Rule 46(n)
   wants the state NAME and CODE, and the PDF already printed "Haryana (06) · IGST". */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QuotePreviewDialog } from "./quote-preview-dialog";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";

afterEach(cleanup);

function preview(props: Partial<React.ComponentProps<typeof QuotePreviewDialog>>) {
  render(
    <QuotePreviewDialog
      open onOpenChange={() => {}} tenantName="ANUTECH DIGITAL PVT LTD" quoteId="Q-R376" customerName="Test Co"
      lineItems={[]} subtotal={1000} discountPct={0} discount={0} taxable={1000} taxRate={18} tax={180} total={1180}
      interState={false} billingCycle="yearly" validityDays={7} notes="" {...props}
    />,
  );
}

const DELHI = { state_code: "07", gstin: "07ABDCA0298H1ZP" };

describe("quote preview — place of supply names the state", () => {
  it("Haryana lead, Delhi seller → 'Haryana (06) · IGST'", () => {
    const pos = quotePlaceOfSupply({ lead: { state_code: "06" }, seller: DELHI });
    preview({ interState: pos.interState, placeOfSupply: pos.label });
    expect(screen.getByText("Haryana (06) · IGST")).toBeTruthy();
    expect(screen.queryByText("Inter-state (IGST applies)")).toBeNull();
  });

  it("Delhi buyer, Delhi seller → 'Delhi (07) · CGST + SGST'", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "07" }, seller: DELHI });
    preview({ interState: pos.interState, placeOfSupply: pos.label });
    expect(screen.getByText("Delhi (07) · CGST + SGST")).toBeTruthy();
  });

  it("no label passed → the old wording stays (no guessed state)", () => {
    preview({ interState: true });
    expect(screen.getByText("Inter-state (IGST applies)")).toBeTruthy();
  });
});
