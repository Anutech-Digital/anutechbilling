// R-445: the invoice page flashed "Standard Subscription License Supply" while the quote
// loaded, then swapped in the real items. Loading must look like loading.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoiceLineItemsView } from "./invoice-line-items";

const gws = [{ name: "Google Workspace Business Starter", qty: 5 }];

describe("invoiceLineItemsView (R-445)", () => {
  it("quote still loading and no invoice items → loading, not the fallback", () => {
    expect(invoiceLineItemsView(true, undefined, [])).toEqual({ state: "loading" });
    expect(invoiceLineItemsView(true, undefined, null)).toEqual({ state: "loading" });
  });
  it("the invoice's own items show at once, even while the quote loads", () => {
    expect(invoiceLineItemsView(true, undefined, gws)).toEqual({ state: "items", items: gws });
  });
  it("loaded quote items win", () => {
    expect(invoiceLineItemsView(false, gws, [])).toEqual({ state: "items", items: gws });
  });
  it("nothing anywhere after loading → empty", () => {
    expect(invoiceLineItemsView(false, null, [])).toEqual({ state: "empty" });
  });
  it("the page uses it and shows a skeleton while loading", () => {
    const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "invoices", "invoice-detail.tsx"), "utf8");
    expect(page).toMatch(/invoiceLineItemsView\(/);
    expect(page).toMatch(/itemsView\.state === "loading"/);
    expect(page).toMatch(/<Skeleton/);
  });
});
