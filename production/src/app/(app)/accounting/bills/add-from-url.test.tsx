// @vitest-environment jsdom
// R-1511: /accounting/bills?add=1&vendor=<id> opens Add Bill with that vendor filled in,
// once, and clears the params so reload/Back does not re-open it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useAddBillFromUrl, readAddBillParams, withoutAddBillParams, vendorBillPrefill } from "./add-from-url";

const NET2 = { id: "v1", name: "Net2Secure Private Limited", gstin: "09AAICN3949G1Z3", default_category: "COGS-Other" };

function at(url: string) { window.history.replaceState(null, "", url); }
afterEach(() => at("/"));

describe("readAddBillParams / withoutAddBillParams", () => {
  it("only add=1 opens; vendor ignored without it", () => {
    expect(readAddBillParams("?add=1&vendor=v1")).toEqual({ open: true, vendorId: "v1" });
    expect(readAddBillParams("?add=1")).toEqual({ open: true, vendorId: null });
    expect(readAddBillParams("?vendor=v1")).toEqual({ open: false, vendorId: null });
    expect(readAddBillParams("")).toEqual({ open: false, vendorId: null });
  });
  it("keeps the page's own filters", () => {
    expect(withoutAddBillParams("?add=1&vendor=v1&status=unpaid")).toBe("?status=unpaid");
    expect(withoutAddBillParams("?add=1&vendor=v1")).toBe("");
  });
});

describe("useAddBillFromUrl", () => {
  it("opens Add Bill with the vendor preselected and clears the params", () => {
    at("/accounting/bills?add=1&vendor=v1&q=x");
    const open = vi.fn();
    renderHook(() => useAddBillFromUrl([NET2], false, open));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(vendorBillPrefill(NET2));
    expect(open.mock.calls[0][0]).toMatchObject({ vendor_name: "Net2Secure Private Limited", vendor_gstin: "09AAICN3949G1Z3" });
    expect(window.location.search).toBe("?q=x");
  });

  it("waits for the vendor list before opening", () => {
    at("/accounting/bills?add=1&vendor=v1");
    const open = vi.fn();
    const { rerender } = renderHook(({ list, loading }) => useAddBillFromUrl(list, loading, open), {
      initialProps: { list: undefined as typeof NET2[] | undefined, loading: true },
    });
    expect(open).not.toHaveBeenCalled();
    rerender({ list: [NET2], loading: false });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]?.vendor_name).toBe("Net2Secure Private Limited");
  });

  it("unknown vendor still opens an empty Add Bill; no params → nothing", () => {
    at("/accounting/bills?add=1&vendor=gone");
    const open = vi.fn();
    renderHook(() => useAddBillFromUrl([NET2], false, open));
    expect(open).toHaveBeenCalledWith(undefined);

    at("/accounting/bills");
    const open2 = vi.fn();
    renderHook(() => useAddBillFromUrl([NET2], false, open2));
    expect(open2).not.toHaveBeenCalled();
  });
});

describe("bills page wiring", () => {
  const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");
  it("uses the hook and hands the prefill to the Add Bill dialog", () => {
    expect(page).toContain("useAddBillFromUrl(vendorsQ.data, vendorsQ.isLoading, openAddFromUrl)");
    expect(page).toContain("<AddVendorBillDialog prefill={addPrefill}");
  });
});
