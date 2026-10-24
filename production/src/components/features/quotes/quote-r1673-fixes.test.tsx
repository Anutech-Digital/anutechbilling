// @vitest-environment jsdom
/* R-1673 — staging recheck 19 Oct (T-1R/T-3R, build 0b23760), small quote defects:
   (1) "Preview · This is how the customer will see it" printed "Internal: this is a prospect —
       customer record pending payment" INSIDE the customer's document. Staff notes belong in
       the preview chrome, outside the document.
   (2) /quotes/new wider than the page: the line table and the bottom action bar could not
       shrink, so "Save & send quote" was cut off at a narrow content width.
   (3b) a one-time line's rate field said "/yr" on a yearly quote. */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen } from "@testing-library/react";
import { QuotePreviewDialog } from "./quote-preview-dialog";
import { lineRateUnitSuffix } from "@/lib/quotes/line-rate-unit";

afterEach(cleanup);

function preview(props: Partial<React.ComponentProps<typeof QuotePreviewDialog>>) {
  render(
    <QuotePreviewDialog
      open onOpenChange={() => {}} tenantName="ANUTECH DIGITAL PVT LTD" quoteId="Q-1" customerName="Lead Co"
      lineItems={[]} subtotal={1000} discountPct={0} discount={0} taxable={1000} taxRate={18} tax={180} total={1180}
      interState={false} billingCycle="yearly" validityDays={7} notes="" {...props}
    />,
  );
}

describe("R-1673 (1): no internal line inside the customer's document", () => {
  it("prospect quote → the note is in the staff chrome, not in the document", () => {
    preview({ isProspect: true });
    const doc = screen.getByTestId("preview-document");
    expect(doc.textContent).not.toMatch(/Internal/);
    expect(doc.textContent).not.toMatch(/prospect/i);
    const note = screen.getByTestId("preview-staff-hint-prospect");
    expect(note.closest("[data-testid='preview-document']")).toBeNull();
    expect(note.textContent).toMatch(/lead/i);
  });

  it("customer quote → no prospect note anywhere", () => {
    preview({ isProspect: false });
    expect(screen.queryByTestId("preview-staff-hint-prospect")).toBeNull();
  });
});

const builder = readFileSync(join(process.cwd(), "src/components/features/quotes/quote-builder.tsx"), "utf8");

describe("R-1673 (2): /quotes/new fits its page", () => {
  it("the desktop line table scrolls inside its own box, never the page", () => {
    const at = builder.indexOf('<table className="hidden md:table');
    expect(at).toBeGreaterThan(-1);
    const wrapper = builder.slice(builder.lastIndexOf("<div", at), at);
    expect(wrapper).toMatch(/\boverflow-x-auto\b/);
  });

  it("the action-bar button group may shrink and wrap from md up (Save & send stays on screen)", () => {
    const bar = builder.indexOf("data-quote-action-bar");
    const group = builder.indexOf('<div className="flex gap-2 flex-nowrap md:flex-wrap items-center', bar);
    const tag = builder.slice(group, builder.indexOf(">", group));
    expect(tag).toMatch(/\bmd:shrink\b/);
    expect(tag).toMatch(/\bmd:min-w-0\b/);
    // Both the quote buttons and the invoice-mode buttons.
    expect(builder.match(/items-center shrink-0 md:shrink md:min-w-0/g)?.length).toBe(2);
  });
});

describe("R-1673 (3b): a one-time line's rate says one-time, not /yr", () => {
  it("yearly quote: one-time line → ' one-time'; licence line → '/yr'", () => {
    expect(lineRateUnitSuffix({ commitment: undefined }, 1, "/yr")).toBe(" one-time");
    expect(lineRateUnitSuffix({ commitment: undefined, one_time: true }, 1, "/yr")).toBe(" one-time");
    expect(lineRateUnitSuffix({ commitment: "annual_yearly" }, 1, "/yr")).toBe("/yr");
  });
  it("split billing keeps the per-invoice unit (pricing untouched)", () => {
    expect(lineRateUnitSuffix({ commitment: undefined }, 4, "/qtr")).toBe("/qtr");
  });
  it("the builder's rate fields use it", () => {
    expect(builder.match(/lineRateUnitSuffix\(line, billingN, billingUnit\)/g)?.length).toBe(2);
  });
});
