// @vitest-environment jsdom
//
// R-2095 (staging, 30 Oct 2026, entering Zoho's October vendor bills): a bill line had no HSN/SAC
// box — GSTR-2B / ITC matching needs it. The line keeps the HSN/SAC typed (or read from the bill).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createBillSpy = vi.fn(async (_v: Record<string, unknown>) => ({ id: "bill-1" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/vendor-bills", () => ({
  uploadBillAttachment: vi.fn(async () => null),
  useCreateVendorBill: () => ({ mutateAsync: createBillSpy }),
  useOwnStateCode: () => ({ data: "07" }),
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";

afterEach(cleanup);

const BILL = {
  vendor_name: "Google Cloud India Pvt Ltd", vendor_gstin: null, bill_no: "GCI-1001", bill_date: "2026-10-05",
  currency: "INR", subtotal: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180, document_type: "tax_invoice",
  category_guess: "COGS-Workspace",
  line_items: [{ description: "Google Workspace Business Starter", qty: 10, unit_price: 100, amount: 1000, hsn: "998313" }],
};

describe("R-2095 vendor bill line HSN/SAC", () => {
  it("shows the line's HSN/SAC, keeps an edit, and saves it on the line", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={BILL} />);
    const hsn = await screen.findByLabelText("HSN/SAC") as HTMLInputElement;
    expect(hsn.value).toBe("998313");
    fireEvent.change(hsn, { target: { value: "998315" } });
    fireEvent.click(screen.getByRole("button", { name: /Save bill/ }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalled(), { timeout: 3000 }).catch(() => {});
    if (!createBillSpy.mock.calls.length) {
      const again = screen.queryByRole("button", { name: /Save/ });
      if (again) fireEvent.click(again);
      await waitFor(() => expect(createBillSpy).toHaveBeenCalled());
    }
    const saved = createBillSpy.mock.calls[0][0] as { line_items: Array<Record<string, unknown>> };
    expect(saved.line_items[0]).toMatchObject({ name: "Google Workspace Business Starter", hsn: "998315" });
  });
});
