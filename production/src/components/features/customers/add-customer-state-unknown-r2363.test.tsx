// @vitest-environment jsdom
//
// R-2363 owner's path (staging reconcile, 2 Nov 2026):
//   1. Pathak Fabrication paid an ADVANCE, has no GSTIN, and nobody knows its state yet. The Add
//      customer sheet refused to save without a "Registered state", so a guessed Delhi was saved —
//      a wrong place of supply later. Now the owner picks "Not known yet": the customer saves with
//      NO state (never a guess), and the quote / tax invoice rules still stop until a state is set.
//   2. Ranz International LLC (Dubai) was created from Find in Zoho as India / unregistered. Seeded
//      with Zoho's country + treatment it is saved as United Arab Emirates / Overseas, no GSTIN, no
//      Indian state code.
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
import { STATE_NOT_KNOWN, missingInvoiceState, stateRequiredMessage } from "@/lib/gst/gstin-state";
import { supplyStateMissing } from "@/lib/quotes/quote-assist";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => created.mockReset());
afterEach(cleanup);

function fillPathak() {
  fireEvent.change(document.getElementById("name")!, { target: { value: "Pathak Fabrication" } });
  fireEvent.change(document.getElementById("contact_phone")!, { target: { value: "9876543210" } });
}
const submit = () => fireEvent.submit(document.getElementById("name")!.closest("form")!);

describe("R-2363 — State not known yet (advance-only customer)", () => {
  it("rule: 'not known yet' is an answer for India; a blank state still is not", () => {
    expect(stateRequiredMessage({ country: "India", state: STATE_NOT_KNOWN })).toBeNull();
    expect(stateRequiredMessage({ country: "India", state: "" })).toMatch(/Choose the state/);
  });

  it("India, no GSTIN, no state picked → still refused (no silent blank)", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    fillPathak();
    submit();
    await waitFor(() => expect(screen.getAllByText(/Choose the state/).length).toBeGreaterThan(0));
    expect(created).not.toHaveBeenCalled();
  });

  it("'Not known yet' → saved with no state and no state code; the next step is said", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    fillPathak();
    const state = document.getElementById("state") as HTMLSelectElement;
    expect([...state.options].some((o) => o.value === STATE_NOT_KNOWN && /Not known yet/.test(o.text))).toBe(true);
    fireEvent.change(state, { target: { value: STATE_NOT_KNOWN } });
    expect(screen.getByText(/Set the state on this customer before you send a quote or make a GST invoice/)).toBeTruthy();
    submit();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    const saved = created.mock.calls[0][0] as { state: string | null; state_code: string | null; country: string };
    expect(saved).toMatchObject({ name: "Pathak Fabrication", country: "India", state: null, state_code: null });
    // …and the quote send + the tax invoice still stop for it until a state is set.
    expect(missingInvoiceState(saved)).toBe(true);
    expect(supplyStateMissing({ isExport: false, buyerStateCode: saved.state_code })).toBe(true);
  });

  it("a GSTIN typed later still fills the real state over 'Not known yet'", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} />);
    fillPathak();
    fireEvent.change(document.getElementById("state")!, { target: { value: STATE_NOT_KNOWN } });
    fireEvent.change(document.getElementById("gstin")!, { target: { value: "27AAPFU0939F1ZV" } });
    submit();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0][0]).toMatchObject({ state: "Maharashtra", state_code: "27" });
  });
});

describe("R-2363 — a foreign customer from Find in Zoho", () => {
  it("seeded UAE + Overseas → saved as United Arab Emirates, Overseas, no GSTIN / state code", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} initial={{ name: "Ranz International LLC", gstin: null, country: "U.A.E", gst_treatment: "overseas", state: "Dubai" }} />);
    await waitFor(() => expect((document.getElementById("country") as HTMLElement).textContent).toContain("United Arab Emirates"));
    expect(screen.getAllByText(/Export customer\./).length).toBeGreaterThan(0);
    fireEvent.change(document.getElementById("contact_email")!, { target: { value: "accounts@ranz.example" } });
    submit();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0][0]).toMatchObject({
      name: "Ranz International LLC", country: "United Arab Emirates", gst_treatment: "overseas",
      gstin: null, state_code: null, pan: null, state: "Dubai",
    });
  });

  it("seeded Indian SEZ treatment is kept (not overwritten by the auto-pick)", async () => {
    render(<AddCustomerForm open onOpenChange={() => {}} initial={{ name: "Zone Unit", gstin: "27AAPFU0939F1ZV", country: "India", gst_treatment: "sez_with_payment", state: "Maharashtra" }} />);
    await waitFor(() => expect((document.getElementById("name") as HTMLInputElement).value).toBe("Zone Unit"));
    fireEvent.change(document.getElementById("contact_email")!, { target: { value: "a@zone.example" } });
    submit();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0][0]).toMatchObject({ gst_treatment: "sez_with_payment", state_code: "27", country: "India" });
  });
});
