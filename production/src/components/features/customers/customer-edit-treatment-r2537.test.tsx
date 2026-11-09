// @vitest-environment jsdom
//
// R-2537 owner's path (staging Excel, 6 Nov 2026): D N B DESIGNS is an Overseas customer brought
// over from Zoho with NO country stored. Opening Edit showed region "India" and saving it — without
// touching the GST treatment — turned it into "Unregistered Business" (and the country into India,
// so its invoices left USD for INR). Now: the stored treatment is kept until the user changes the
// region / GSTIN / customer type in THIS edit, a blank country stays blank (shown as empty, not
// India), and a change of treatment is said on the form before Save.
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const created = vi.fn();
const updated = vi.fn();
vi.mock("@/lib/queries/customers", () => ({
  useCreateCustomer: () => ({ mutateAsync: async (p: unknown) => { created(p); return { id: "cust-new" }; }, isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: async (p: unknown) => { updated(p); }, isPending: false }),
}));
vi.mock("@/components/features/gstin/gstin-verify-card", () => ({ default: () => null }));
vi.mock("./scan-card-panel", () => ({ ScanCardPanel: () => null }));

import { AddCustomerForm } from "./add-customer-form";
import type { Customer } from "@/lib/supabase/database.types";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => { created.mockReset(); updated.mockReset(); });
afterEach(cleanup);

const DNB = {
  id: "c-dnb", name: "D N B DESIGNS", country: "", gst_treatment: "overseas", customer_type: "business",
  gstin: null, state: null, state_code: null, contact_email: "accounts@dnb.example",
} as unknown as Customer;
const DELHI_GSTIN = "07AAACR5055K1Z9";

const submit = () => fireEvent.submit(document.getElementById("name")!.closest("form")!);
const treatment = () => (document.getElementById("gst_treatment") as HTMLSelectElement).value;
const region = () => (document.getElementById("country") as HTMLElement).textContent?.trim() ?? "";
function pickCountry(name: string) {
  fireEvent.click(document.getElementById("country") as HTMLElement);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search countries" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("option", { name }));
}
type Patch = { id: string; patch: Record<string, unknown> };
const lastPatch = () => (updated.mock.calls.at(-1)![0] as Patch).patch;

describe("R-2537 — editing a customer never changes its GST treatment by itself", () => {
  it("untouched save: Overseas with no country stays Overseas, country is not rewritten", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} customer={DNB} />);
    await waitFor(() => expect(treatment()).toBe("overseas"));
    expect(region()).not.toMatch(/India/);
    expect(screen.getByText(/No region saved for this customer/)).toBeTruthy();
    submit();
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    const patch = lastPatch();
    expect(patch.gst_treatment).toBe("overseas");
    expect("country" in patch).toBe(false);
    expect(screen.queryByText(/GST treatment changes from/)).toBeNull();
  });

  it("domestic blank country: region empty, saved without a country, treatment unchanged", async () => {
    const c = { ...DNB, id: "c-dom", name: "Local Co", gst_treatment: "unregistered_business", state: "Delhi", state_code: "07" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={c} />);
    await waitFor(() => expect(treatment()).toBe("unregistered_business"));
    expect(region()).not.toMatch(/India/);
    submit();
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(lastPatch().gst_treatment).toBe("unregistered_business");
    expect("country" in lastPatch()).toBe(false);
  });

  it("kept until facts change: a stored treatment the rule would not pick is not recomputed", async () => {
    const c = { ...DNB, id: "c-od", name: "Odd Overseas", country: "India", gst_treatment: "overseas" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={c} />);
    await waitFor(() => expect(region()).toBe("India"));
    // Opening alone never flips it.
    expect(treatment()).toBe("overseas");
  });

  it("region change shows the treatment change before save", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} customer={DNB} />);
    await waitFor(() => expect(treatment()).toBe("overseas"));
    pickCountry("India");
    await waitFor(() => expect(treatment()).toBe("unregistered_business"));
    expect(screen.getByText(/GST treatment changes from Overseas to Unregistered Business/)).toBeTruthy();
  });

  it("change back restores the saved treatment and the notice goes", async () => {
    const c = { ...DNB, id: "c-uae", country: "United Arab Emirates" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={c} />);
    await waitFor(() => expect(region()).toBe("United Arab Emirates"));
    pickCountry("India");
    await waitFor(() => expect(treatment()).toBe("unregistered_business"));
    pickCountry("United Arab Emirates");
    await waitFor(() => expect(treatment()).toBe("overseas"));
    expect(screen.queryByText(/GST treatment changes from/)).toBeNull();
  });

  it("gstin cleared on a Regular customer: the change is shown, not silent", async () => {
    const c = { ...DNB, id: "c-reg", name: "Reg Co", country: "India", gst_treatment: "registered_regular", gstin: DELHI_GSTIN, state: "Delhi", state_code: "07" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={c} />);
    await waitFor(() => expect(treatment()).toBe("registered_regular"));
    fireEvent.change(document.getElementById("gstin")!, { target: { value: "" } });
    await waitFor(() => expect(treatment()).toBe("unregistered_business"));
    expect(screen.getByText(/GST treatment changes from Registered Business – Regular to Unregistered Business/)).toBeTruthy();
  });

  it("hand pick is saved as picked, with the notice", async () => {
    const c = { ...DNB, id: "c-reg2", name: "Reg Co", country: "India", gst_treatment: "registered_regular", gstin: DELHI_GSTIN, state: "Delhi", state_code: "07" } as unknown as Customer;
    render(<AddCustomerForm open onOpenChange={() => {}} customer={c} />);
    await waitFor(() => expect(treatment()).toBe("registered_regular"));
    fireEvent.change(document.getElementById("gst_treatment")!, { target: { value: "sez_with_payment" } });
    expect(screen.getByText(/GST treatment changes from Registered Business – Regular to SEZ \(with payment\)/)).toBeTruthy();
    submit();
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toMatchObject({ gst_treatment: "sez_with_payment", country: "India" });
  });

  it("create unchanged: a new customer starts in India with the auto-picked treatment", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    expect(region()).toBe("India");
    expect(treatment()).toBe("unregistered_business");
    expect(screen.queryByText(/No region saved/)).toBeNull();
  });
});
