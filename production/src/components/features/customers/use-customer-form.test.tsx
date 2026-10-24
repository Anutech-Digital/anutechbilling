// @vitest-environment jsdom
/**
 * R-1736 — the owner's path on the customer form: type the GSTIN → "Registered Business –
 * Regular" and the PAN appear by themselves; change it to SEZ (with payment) → saved as SEZ.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const created: Array<Record<string, unknown>> = [];
vi.mock("@/lib/queries/customers", () => ({
  useCreateCustomer: () => ({
    isPending: false,
    mutateAsync: async (p: Record<string, unknown>) => { created.push(p); return { id: "new-id" }; },
  }),
  useUpdateCustomer: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useCustomerForm } from "./use-customer-form";

const GSTIN = "07AAACR5055K1Z9";

function fillContact(setValue: ReturnType<typeof useCustomerForm>["setValue"]) {
  setValue("name", "Acme SEZ Unit");
  setValue("contact_first_name", "Ravi");
  setValue("contact_email", "ravi@example.in");
  setValue("contact_phone", "9810000000");
}

describe("useCustomerForm — GST treatment and PAN (R-1736)", () => {
  it("starts as Unregistered Business, auto-picks Regular + PAN from the GSTIN", async () => {
    const { result } = renderHook(() => useCustomerForm({}));
    expect(result.current.gstTreatment).toBe("unregistered_business");
    act(() => { result.current.setValue("gstin", GSTIN); });
    await waitFor(() => expect(result.current.gstTreatment).toBe("registered_regular"));
    expect(result.current.gstTreatmentAuto).toBe(true);
    expect(result.current.watch("pan")).toBe("AAACR5055K");
    expect(result.current.panLocked).toBe(true);
  });

  it("keeps a hand-picked SEZ and saves it with the PAN", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => { result.current.setValue("gstin", GSTIN); });
    await waitFor(() => expect(result.current.gstTreatment).toBe("registered_regular"));
    act(() => { result.current.onTreatmentChange("sez_with_payment"); });
    await waitFor(() => expect(result.current.gstTreatment).toBe("sez_with_payment"));
    expect(result.current.gstTreatmentAuto).toBe(false);
    act(() => { fillContact(result.current.setValue); });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(1);
    expect(created[0].gst_treatment).toBe("sez_with_payment");
    expect(created[0].pan).toBe("AAACR5055K");
  });

  it("clears the GSTIN's PAN when the GSTIN is removed, and goes back to Unregistered", async () => {
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => { result.current.setValue("gstin", GSTIN); });
    await waitFor(() => expect(result.current.watch("pan")).toBe("AAACR5055K"));
    act(() => { result.current.setValue("gstin", ""); });
    await waitFor(() => expect(result.current.gstTreatment).toBe("unregistered_business"));
    expect(result.current.watch("pan")).toBe("");
    expect(result.current.panLocked).toBe(false);
  });

  it("refuses Regular without a GSTIN", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => { result.current.onTreatmentChange("registered_regular"); fillContact(result.current.setValue); result.current.setValue("state", "Delhi"); });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(0);
    expect(result.current.errors.gst_treatment?.message).toMatch(/GSTIN/);
  });
});
