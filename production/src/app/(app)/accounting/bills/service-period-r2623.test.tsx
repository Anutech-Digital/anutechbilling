// @vitest-environment jsdom
//
// R-2623 — a COGS bill's service period on Add COGS Bill and on the bill view: the database's
// period with why ("auto (…)" / "set on the bill"); Change → month pickers → saved as whole months;
// "Use auto" clears it; a wrong order never reaches the database.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const createBillSpy = vi.fn(async (_v: Record<string, unknown>) => ({ id: "bill-1" }));
const setPeriodSpy = vi.fn();
const periods = new Map<string, { service_from: string; service_to: string; basis: string }>();
const who = { role: "owner" };
let autoAnswer: { data: unknown; isLoading: boolean; isError: boolean } = { data: null, isLoading: false, isError: false };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/vendor-bills", () => ({
  uploadBillAttachment: vi.fn(async () => null),
  useCreateVendorBill: () => ({ mutateAsync: createBillSpy }),
  useOwnStateCode: () => ({ data: "07" }),
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
  useAutoServicePeriod: () => autoAnswer,
  useVendorBillServicePeriods: (ids: string[]) => ({ data: new Map(ids.map((id) => [id, periods.get(id)])), isLoading: false, isError: false }),
  useSetBillServicePeriod: () => ({ mutate: setPeriodSpy, isPending: false }),
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: who.role } }) }));

import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";
import { BillDetailDialog } from "@/components/features/accounting/bill-detail-dialog";
import type { VendorBill } from "@/lib/queries/vendor-bills";

afterEach(cleanup);
beforeEach(() => {
  createBillSpy.mockClear(); setPeriodSpy.mockClear(); periods.clear(); who.role = "owner";
  autoAnswer = { data: { service_from: "2026-09-01", service_to: "2026-09-30", basis: "vendor_default" }, isLoading: false, isError: false };
});

const GOOGLE = {
  vendor_name: "Google Cloud India Pvt Ltd", vendor_gstin: null, bill_no: "5667984259", bill_date: "2026-10-07",
  currency: "INR", subtotal: 1000, cgst: 0, sgst: 0, igst: 0, total: 1000, document_type: "tax_invoice",
  category_guess: "COGS-Workspace",
};

describe("R-2623 Add COGS Bill — service period", () => {
  it("shows the auto period with why; untouched saves nothing (auto)", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={GOOGLE} />);
    expect((await screen.findByTestId("add-bill-service-period")).textContent)
      .toBe("Sep 2026 · auto (Google / Microsoft bill: month before the bill date)");
    fireEvent.click(screen.getByRole("button", { name: /Save bill/ }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalled());
    expect(createBillSpy.mock.calls[0][0]).toMatchObject({ service_from: null, service_to: null });
  });

  it("Change → Aug 2026 → saved as 1 Aug .. 31 Aug", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={GOOGLE} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const from = screen.getByLabelText("First month") as HTMLInputElement;
    expect(from.value).toBe("2026-09");
    fireEvent.change(from, { target: { value: "2026-08" } });
    fireEvent.change(screen.getByLabelText("Last month"), { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: /Save bill/ }));
    await waitFor(() => expect(createBillSpy).toHaveBeenCalled());
    expect(createBillSpy.mock.calls[0][0]).toMatchObject({ service_from: "2026-08-01", service_to: "2026-08-31" });
  });

  it("last month before the first → the rule shows and nothing is saved", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={GOOGLE} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Last month"), { target: { value: "2026-07" } });
    expect(screen.getByRole("alert").textContent).toBe("The last month must be the same as or after the first month.");
    fireEvent.click(screen.getByRole("button", { name: /Save bill/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(createBillSpy).not.toHaveBeenCalled();
  });

  it("auto period did not load → says so, and Change still opens on the bill month", async () => {
    autoAnswer = { data: undefined, isLoading: false, isError: true };
    render(<AddVendorBillDialog onClose={() => {}} prefill={GOOGLE} />);
    expect((await screen.findByTestId("add-bill-service-period")).textContent).toContain("The auto period did not load");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("First month") as HTMLInputElement).value).toBe("2026-10");
  });

  it("Use auto goes back to the worked-out period", async () => {
    render(<AddVendorBillDialog onClose={() => {}} prefill={GOOGLE} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Use auto (Sep 2026)" }));
    expect(screen.queryByLabelText("First month")).toBeNull();
    expect(screen.getByTestId("add-bill-service-period").textContent).toContain("Sep 2026 · auto");
  });
});

const BILL = {
  id: "BILL-G", vendor_name: "Google", bill_no: "5667984259", bill_date: "2026-10-07", category: "COGS-Workspace",
  currency: "INR", fx_rate: 1, subtotal: 1000, cgst: 0, sgst: 0, igst: 0, total: 1000, line_items: [],
} as unknown as VendorBill;

describe("R-2623 bill view — service period", () => {
  it("auto: shows it, Change → Aug → Save period writes whole months", () => {
    periods.set("BILL-G", { service_from: "2026-09-01", service_to: "2026-09-30", basis: "vendor_default" });
    render(<BillDetailDialog bill={BILL} onClose={() => {}} />);
    expect(screen.getByTestId("bill-BILL-G-service-period").textContent)
      .toBe("Sep 2026 · auto (Google / Microsoft bill: month before the bill date)");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("First month"), { target: { value: "2026-08" } });
    fireEvent.change(screen.getByLabelText("Last month"), { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Save period" }));
    expect(setPeriodSpy).toHaveBeenCalledWith(
      { id: "BILL-G", service_from: "2026-08-01", service_to: "2026-08-31" }, expect.anything());
  });

  it("set on the bill: says so; Use auto clears both columns", () => {
    periods.set("BILL-G", { service_from: "2026-08-01", service_to: "2026-08-31", basis: "set" });
    render(<BillDetailDialog bill={BILL} onClose={() => {}} />);
    expect(screen.getByTestId("bill-BILL-G-service-period").textContent).toBe("Aug 2026 · set on the bill");
    fireEvent.click(screen.getByRole("button", { name: "Use auto" }));
    expect(setPeriodSpy).toHaveBeenCalledWith({ id: "BILL-G", service_from: null, service_to: null }, expect.anything());
  });

  it("a role that cannot change bills (sales) sees the period, Change is off", () => {
    who.role = "sales";
    periods.set("BILL-G", { service_from: "2026-08-01", service_to: "2026-08-31", basis: "set" });
    render(<BillDetailDialog bill={BILL} onClose={() => {}} />);
    expect(screen.getByTestId("bill-BILL-G-service-period").textContent).toBe("Aug 2026 · set on the bill");
    expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use auto" })).toBeNull();
  });

  it("Save period is off while the months are in the wrong order", () => {
    periods.set("BILL-G", { service_from: "2026-09-01", service_to: "2026-09-30", basis: "vendor_default" });
    render(<BillDetailDialog bill={BILL} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Last month"), { target: { value: "2026-07" } });
    expect((screen.getByRole("button", { name: "Save period" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
