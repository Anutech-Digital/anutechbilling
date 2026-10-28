// @vitest-environment jsdom
//
// R-2056 (Pardeep, 28 Oct 2026) — owner's real path on Add bill: a foreign online-service
// bill in USD (subtotal $325, GST - India 18% $58.50, total $383.50, dated 25 Oct 2026) whose
// "VAT Registration India GST" is an OIDAR GSTIN. Synthetic GSTIN in the real shape; the
// rate fetch (/api/fx/latest) is mocked — no network.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createBillSpy = vi.fn(async (_v: Record<string, unknown>) => ({ id: "bill-1" }));
const ensureVendorSpy = vi.fn(async (_v: Record<string, unknown>) => null);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: (v: Record<string, unknown>) => ensureVendorSpy(v) }));
vi.mock("@/lib/queries/vendor-bills", () => ({
  uploadBillAttachment: vi.fn(async () => null),
  useCreateVendorBill: () => ({ mutateAsync: createBillSpy }),
  useOwnStateCode: () => ({ data: "07" }),
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";

const OIDAR_USA = "9924USA00001OSX";
const USD_BILL = {
  vendor_name: "Foreign AI Co, PBC", vendor_gstin: OIDAR_USA, bill_no: "INV-0038", bill_date: "2026-10-25",
  currency: "USD", subtotal: 325, cgst: 0, sgst: 0, igst: 58.5, total: 383.5, document_type: "tax_invoice",
  category_guess: "COGS-Other",
};
const el = (id: string) => document.getElementById(id) as HTMLInputElement;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  createBillSpy.mockClear(); ensureVendorSpy.mockClear();
  fetchMock = vi.fn(async (url: string) => {
    const date = new URL(url, "http://x").searchParams.get("date");
    const rate = date === "2026-10-25" ? 94.7145 : 94.94;
    return { ok: true, status: 200, json: async () => ({ rate, from: "USD", to: "INR", asOf: date === "2026-10-25" ? "2026-10-24" : date, source: "fbil", kind: "reference", label: "FBIL reference rate (RBI)" }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Add bill — USD bill from a foreign online service (OIDAR)", () => {
  it("says OIDAR with the next step, not 'no GSTIN'", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={USD_BILL} />);
    await waitFor(() => expect(screen.getByText(/Foreign online service \(OIDAR\) GSTIN/)).toBeTruthy());
    const line = screen.getByText(/Foreign online service \(OIDAR\) GSTIN/).textContent ?? "";
    expect(line).toMatch(/Add your GSTIN in the vendor's billing settings/);
    expect(line).not.toMatch(/no GSTIN/i);
  });

  it("the Exchange rate box fills with the bill date's rate, says source + date, stays editable", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={USD_BILL} />);
    await waitFor(() => expect(el("add-vendor-field").value).toBe("94.7145"));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/fx/latest?from=USD&date=2026-10-25");
    expect(screen.getByText(/₹94\.7145 · FBIL\/RBI reference rate, 24 Oct 2026 — change it if your bank charged a different rate/)).toBeTruthy();

    fireEvent.change(el("add-vendor-field"), { target: { value: "95.2" } });
    expect(el("add-vendor-field").value).toBe("95.2");
    /* The bill date changes → the rate is asked again, but the typed one stays. */
    fireEvent.change(el("bill_date"), { target: { value: "2026-10-26" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(el("add-vendor-field").value).toBe("95.2");
  });

  it("a rate untouched by the user follows the bill date", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={USD_BILL} />);
    await waitFor(() => expect(el("add-vendor-field").value).toBe("94.7145"));
    fireEvent.change(el("bill_date"), { target: { value: "2026-10-26" } });
    await waitFor(() => expect(el("add-vendor-field").value).toBe("94.94"));
  });

  it("saves the typed rate and the GSTIN without spaces", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={{ ...USD_BILL, vendor_gstin: "9924 USA-00001 OSX" }} />);
    await waitFor(() => expect(el("add-vendor-field").value).toBe("94.7145"));
    fireEvent.change(el("add-vendor-field"), { target: { value: "95" } });
    /* GST gives no credit → first Save asks, second Save saves it as cost. */
    fireEvent.click(screen.getByRole("button", { name: /Save bill/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save — GST as cost/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Save — GST as cost/ }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalledTimes(1));
    const saved = createBillSpy.mock.calls[0][0];
    expect(saved).toMatchObject({ currency: "USD", fx_rate: 95, vendor_gstin: OIDAR_USA, total: 36433 });
    expect(String(saved.notes)).toMatch(/@ ₹95\/USD \(rate entered by you\)/);
  });

  it("an empty GSTIN box and a wrong one say different things", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={{ ...USD_BILL, vendor_gstin: null }} />);
    await waitFor(() => expect(screen.getByText(/Vendor GSTIN box is empty/)).toBeTruthy());
    fireEvent.change(el("vendor_gstin"), { target: { value: "07ABCDE12" } });
    await waitFor(() => expect(screen.getByText(/This GSTIN looks wrong \(15 characters, no spaces\)/)).toBeTruthy());
  });
});
