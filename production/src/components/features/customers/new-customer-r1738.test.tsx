// @vitest-environment jsdom
/**
 * R-1738 — the owner's path: Add company → type only "Bharat Tiles" and an email → Save.
 * The customer is created and its contact is the company itself (Zoho asks only the name).
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

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

describe("Add company with only the essentials (R-1738)", () => {
  it("'Bharat Tiles' + email saves, and the contact is Bharat Tiles", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => {
      result.current.setValue("name", "Bharat Tiles");
      result.current.setValue("contact_email", "accounts@bharattiles.in");
      result.current.setValue("state", "Punjab");
    });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("Bharat Tiles");
    expect(created[0].contact_name).toBe("Bharat Tiles");
    expect(created[0].contact_email).toBe("accounts@bharattiles.in");
  });

  it("name + phone only also saves", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => {
      result.current.setValue("name", "Bharat Tiles");
      result.current.setValue("contact_mobile", "9810000000");
      result.current.setValue("state", "Punjab");
    });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(1);
    expect(created[0].contact_name).toBe("Bharat Tiles");
  });

  it("a typed contact person still wins over the company name", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => {
      result.current.setValue("name", "Bharat Tiles");
      result.current.setValue("contact_first_name", "Ravi");
      result.current.setValue("contact_last_name", "Kumar");
      result.current.setValue("contact_email", "ravi@bharattiles.in");
      result.current.setValue("state", "Punjab");
    });
    await act(async () => { await result.current.submit(); });
    expect(created[0].contact_name).toBe("Ravi Kumar");
  });

  it("no email and no phone → not saved, says one of them is needed", async () => {
    created.length = 0;
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => {
      result.current.setValue("name", "Bharat Tiles");
      result.current.setValue("state", "Punjab");
    });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(0);
    expect(result.current.errors.contact_email?.message).toMatch(/email or a phone/i);
  });
});
