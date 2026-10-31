// @vitest-environment jsdom
//
// R-2180 owner's path: Add a customer (the same sheet the bank-reconcile "New customer"
// opens) → Country, type "Est" → Estonia → the form turns into the export form and the
// customer is saved with country Estonia and GST treatment Overseas. And an old customer
// saved as "USA" opens as United States (export), never silently as India.
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const created = vi.fn();
vi.mock("@/lib/queries/customers", () => ({
  useCreateCustomer: () => ({ mutateAsync: async (p: unknown) => { created(p); return { id: "cust-new" }; }, isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/features/gstin/gstin-verify-card", () => ({ default: () => null }));
vi.mock("./scan-card-panel", () => ({ ScanCardPanel: () => null }));

import { AddCustomerForm } from "./add-customer-form";
import type { Customer } from "@/lib/supabase/database.types";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => created.mockReset());
afterEach(cleanup);

describe("Add customer — any country (R-2180)", () => {
  it('type "Est" → Estonia; saved as Estonia, Overseas', async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    const picker = document.getElementById("country") as HTMLElement;
    expect(picker.textContent).toContain("India");
    fireEvent.click(picker);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search countries" }), { target: { value: "Est" } });
    fireEvent.click(screen.getByRole("option", { name: "Estonia" }));

    expect(picker.textContent).toContain("Estonia");
    expect(screen.getAllByText(/Export customer\./).length).toBeGreaterThan(0);

    fireEvent.change(document.getElementById("name")!, { target: { value: "Woollyes OU" } });
    fireEvent.change(document.getElementById("contact_email")!, { target: { value: "billing@woollyes.example" } });
    fireEvent.submit(document.getElementById("name")!.closest("form")!);

    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0][0]).toMatchObject({ country: "Estonia", gst_treatment: "overseas" });
  });

  it('an old customer saved as "USA" opens as United States (export)', async () => {
    const old = { id: "c-usa", name: "Old US Co", country: "USA", gst_treatment: "overseas", customer_type: "business" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={old} />);
    await waitFor(() => expect((document.getElementById("country") as HTMLElement).textContent?.trim()).toBe("United States"));
    expect(screen.getAllByText(/Export customer\./).length).toBeGreaterThan(0);
  });
});
