// R-1511: the vendor popup leads to recording that vendor's bill, and its header is not
// left half-selected (the orange "highlight" = the app's ::selection colour).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recordBillHref, readAddBillParams } from "../bills/add-from-url";
import { isCarryOverClick, CARRY_OVER_MS } from "./vendor-popup";

const src = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");
const popup = src.slice(src.indexOf("function VendorBillsDialog"));

describe("R-1511 — Record a bill from the vendor popup", () => {
  it("the link opens Bills with Add Bill for this vendor", () => {
    const href = recordBillHref("v-123 &x");
    expect(href.startsWith("/accounting/bills?")).toBe(true);
    expect(readAddBillParams(href.slice(href.indexOf("?")))).toEqual({ open: true, vendorId: "v-123 &x" });
  });

  it("footer: 'Record a bill' is the primary button, purchase order is secondary and renamed", () => {
    const footer = popup.slice(popup.indexOf("<DialogFooter"), popup.indexOf("</DialogFooter>"));
    expect(footer).toMatch(/variant="primary"[^>]*>\s*<Link href=\{recordBillHref\(vendor\.id\)\}>Record a bill<\/Link>/);
    expect(footer).toMatch(/variant="default"[^>]*>\s*<Link href=\{"\/purchase-orders" as Route\}>Raise purchase order<\/Link>/);
    expect(footer).not.toContain("Buy Products");
  });

  it("the empty state offers the same next step", () => {
    const i = popup.indexOf("No bills or expenses for this vendor yet.");
    expect(i).toBeGreaterThan(0);
    expect(popup.slice(i, i + 400)).toContain("<Link href={recordBillHref(vendor.id)}>Record a bill</Link>");
  });

  it("no string href slips past typed routes", () => {
    expect(popup).not.toMatch(/href=\{"[^"]+" as never\}/);
  });
});

describe("R-1511 — header not selected by the click that opened the popup", () => {
  it("swallows the extra clicks of the opening double/triple click only", () => {
    expect(isCarryOverClick(2, 50)).toBe(true);
    expect(isCarryOverClick(3, CARRY_OVER_MS - 1)).toBe(true);
    expect(isCarryOverClick(1, 50)).toBe(false);             // a normal click
    expect(isCarryOverClick(2, CARRY_OVER_MS + 1)).toBe(false); // a deliberate double-click later
  });

  it("the popup clears a stray selection and guards mousedown", () => {
    expect(popup).toContain("clearStraySelection()");
    expect(popup).toMatch(/onMouseDownCapture=\{\(e\) => \{ if \(isCarryOverClick\(e\.detail/);
    // and there is no highlight markup in the header at all
    const header = popup.slice(popup.indexOf("<DialogHeader>"), popup.indexOf("</DialogHeader>"));
    expect(header).not.toMatch(/<mark|highlight/i);
  });
});
