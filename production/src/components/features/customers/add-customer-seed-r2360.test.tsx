// @vitest-environment jsdom
//
// R-2360: Reconcile → Find in Zoho → the Zoho customer is not in the app → "Create customer" opens
// this sheet already filled with Zoho's company name and GSTIN (the owner checks and saves).
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

describe("Add customer — seeded from Zoho (R-2360)", () => {
  it("name + GSTIN from Zoho are filled; saved with them", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} initial={{ name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "27aapfu0939f1zv" }} />);
    await waitFor(() => expect((document.getElementById("name") as HTMLInputElement).value).toBe("SUPREME MEDIA & STUDIOS PRIVATE LIMITED"));
    expect((document.getElementById("gstin") as HTMLInputElement).value).toBe("27AAPFU0939F1ZV");
    fireEvent.change(document.getElementById("contact_email")!, { target: { value: "accounts@supreme.example" } });
    fireEvent.submit(document.getElementById("name")!.closest("form")!);
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0][0]).toMatchObject({ name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "27AAPFU0939F1ZV" });
  });

  it("no seed → empty as before", () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("");
  });
});
