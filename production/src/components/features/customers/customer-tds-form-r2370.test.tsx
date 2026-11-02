// @vitest-environment jsdom
/**
 * R-2370 — the owner's path: Customer → Edit → "TDS the customer deducts" → 194C, rate 1 → Save.
 * The update carries tds_default_section 194C / tds_default_rate_pct 1 (what the Overview's
 * "TDS" field and the receipt dialog read). An edit that leaves TDS alone never rewrites it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook, act, cleanup } from "@testing-library/react";

const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
const created: Array<Record<string, unknown>> = [];
vi.mock("@/lib/queries/customers", () => ({
  useCreateCustomer: () => ({
    isPending: false,
    mutateAsync: async (p: Record<string, unknown>) => { created.push(p); return { id: "new-id" }; },
  }),
  useUpdateCustomer: () => ({
    isPending: false,
    mutateAsync: async (a: { id: string; patch: Record<string, unknown> }) => { updates.push(a); return {}; },
  }),
}));
vi.mock("./group-form-dialog", () => ({ GroupFormDialog: () => null }));
vi.mock("@/lib/queries/customer-groups", () => ({ useCustomerGroups: () => ({ data: [] }) }));
let role = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/components/features/gstin/gstin-verify-card", () => ({ default: () => null }));
vi.mock("./scan-card-panel", () => ({ ScanCardPanel: () => null }));
vi.mock("@/components/shared/smart-paste", () => ({ SmartPaste: () => null }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

import { useCustomerForm } from "./use-customer-form";
import { CustomerFormPage } from "./customer-form-page";
import type { Customer } from "@/lib/supabase/database.types";

const SUPREME = {
  id: "c-1", tenant_id: "t-1", name: "Supreme Media", customer_type: "business", country: "India",
  state: "Delhi", state_code: "07", gstin: null, gst_treatment: "unregistered_business",
  contact_name: "Supreme Media", contact_email: "accounts@example.in", contact_phone: "9810000000",
  contact_persons: [], tds_default_section: "194J", tds_default_rate_pct: 10,
} as unknown as Customer;

beforeEach(() => { updates.length = 0; created.length = 0; role = "owner"; });
afterEach(() => cleanup());

describe("Edit customer — TDS section + rate (R-2370)", () => {
  it("opens on the saved 194J @ 10%; picking 194C fills 2%, typing 1 saves 194C @ 1%", async () => {
    render(<CustomerFormPage customer={SUPREME} />);
    const section = await screen.findByLabelText("TDS the customer deducts") as HTMLSelectElement;
    const rate = screen.getByLabelText("TDS rate (%)") as HTMLInputElement;
    await waitFor(() => expect(section.value).toBe("194J"));
    expect(rate.value).toBe("10");

    fireEvent.change(section, { target: { value: "194C" } });
    await waitFor(() => expect(rate.value).toBe("2"));
    fireEvent.change(rate, { target: { value: "1" } });
    /* 1% on 194C is the individual / HUF rate — said softly, never blocked. */
    await waitFor(() => expect(screen.getByText(/194C is usually 2%/)).toBeTruthy());

    const form = section.closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0].patch.tds_default_section).toBe("194C");
    expect(updates[0].patch.tds_default_rate_pct).toBe(1);
  });

  it("No TDS clears both columns", async () => {
    render(<CustomerFormPage customer={SUPREME} />);
    const section = await screen.findByLabelText("TDS the customer deducts") as HTMLSelectElement;
    await waitFor(() => expect(section.value).toBe("194J"));
    fireEvent.change(section, { target: { value: "" } });
    await act(async () => { fireEvent.submit(section.closest("form")!); });
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0].patch.tds_default_section).toBeNull();
    expect(updates[0].patch.tds_default_rate_pct).toBeNull();
  });

  it("a sales user sees the TDS but cannot change it", async () => {
    role = "sales";
    render(<CustomerFormPage customer={SUPREME} />);
    const section = await screen.findByLabelText("TDS the customer deducts") as HTMLSelectElement;
    expect(section.disabled).toBe(true);
    expect((screen.getByLabelText("TDS rate (%)") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("useCustomerForm — TDS in the save payload (R-2370)", () => {
  it("an edit that does not touch TDS does not send it", async () => {
    const { result } = renderHook(() => useCustomerForm({ customer: SUPREME }));
    await waitFor(() => expect(result.current.watch("tds_section")).toBe("194J"));
    act(() => { result.current.setValue("city", "New Delhi"); });
    await act(async () => { await result.current.submit(); });
    expect(updates).toHaveLength(1);
    expect("tds_default_section" in updates[0].patch).toBe(false);
    expect("tds_default_rate_pct" in updates[0].patch).toBe(false);
  });

  it("a new customer saved with a section carries it; without one, nothing", async () => {
    const { result } = renderHook(() => useCustomerForm({}));
    act(() => {
      result.current.setValue("name", "New Co");
      result.current.setValue("state", "Delhi");
      result.current.setValue("contact_email", "a@example.in");
      result.current.setValue("tds_section", "194C");
      result.current.setValue("tds_rate_pct", "1");
    });
    await act(async () => { await result.current.submit(); });
    expect(created).toHaveLength(1);
    expect(created[0].tds_default_section).toBe("194C");
    expect(created[0].tds_default_rate_pct).toBe(1);
  });

  it("a section with no rate is refused on the rate box", async () => {
    const { result } = renderHook(() => useCustomerForm({ customer: SUPREME }));
    await waitFor(() => expect(result.current.watch("tds_section")).toBe("194J"));
    act(() => { result.current.setValue("tds_rate_pct", ""); });
    await act(async () => { await result.current.submit(); });
    expect(updates).toHaveLength(0);
    expect(result.current.errors.tds_rate_pct?.message).toMatch(/rate/i);
  });
});
