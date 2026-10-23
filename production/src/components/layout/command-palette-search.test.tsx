// @vitest-environment jsdom
/**
 * R-1121 — Ctrl+K read six whole tables the first time it opened, and said "No results found"
 * while they were still loading. Now it reads nothing until something is typed, then asks the
 * server for a few matches per group, and says "Searching…" until they arrive.
 */
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const wholeTable = vi.fn();
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => { wholeTable("customers"); return { data: [] }; } }));
vi.mock("@/lib/queries/quotes", () => ({ useQuotes: () => { wholeTable("quotes"); return { data: [] }; } }));
vi.mock("@/lib/queries/contacts", () => ({ useAllContacts: () => { wholeTable("contacts"); return { data: [] }; } }));
vi.mock("@/lib/queries/invoices", () => ({ useInvoices: () => { wholeTable("invoices"); return { data: [] }; } }));
vi.mock("@/lib/queries/subscriptions", () => ({ useSubscriptions: () => { wholeTable("subscriptions"); return { data: [] }; } }));
vi.mock("@/lib/queries/payments", () => ({ usePayments: () => { wholeTable("payments"); return { data: [] }; } }));
vi.mock("@/lib/queries/leads", () => ({ useLeadSearch: () => ({ data: [], isFetching: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: "owner", canViewDeals: true, tenantId: "t1" } }),
}));
vi.mock("@/components/features/subscriptions/add-seats-dialog", () => ({ default: () => null }));

const search = vi.fn();
let searchState = {
  customers: [] as unknown[], quotes: [] as unknown[], invoices: [] as unknown[],
  subscriptions: [] as unknown[], contacts: [] as unknown[], payments: [] as unknown[], fetching: false,
};
vi.mock("@/lib/queries/palette-search", () => ({
  usePaletteSearch: (...a: unknown[]) => { search(...a); return searchState; },
}));

import { CommandPalette } from "./command-palette";

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  wholeTable.mockClear();
  search.mockClear();
  searchState = { customers: [], quotes: [], invoices: [], subscriptions: [], contacts: [], payments: [], fetching: false };
});

describe("CommandPalette (R-1121)", () => {
  it("opening it reads no whole table", () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(wholeTable).not.toHaveBeenCalled();
  });

  it("asks the server with the typed text only after a pause (debounced), tenant-scoped", () => {
    vi.useFakeTimers();
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ac" } });
    expect(search).not.toHaveBeenCalledWith("ac", true, expect.anything(), "t1");
    act(() => { vi.advanceTimersByTime(250); });
    expect(search).toHaveBeenLastCalledWith("ac", true, expect.anything(), "t1");
  });

  it("while the server is answering it says Searching…, never No results", () => {
    searchState = { ...searchState, fetching: true };
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzqx" } });
    expect(screen.getByText(/searching/i)).toBeTruthy();
    expect(screen.queryByText(/no results found/i)).toBeNull();
  });

  it("says No results once the answer is in and nothing matched", () => {
    vi.useFakeTimers();
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzqx" } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/no results found/i)).toBeTruthy();
    expect(screen.queryByText(/searching/i)).toBeNull();
  });

  it("shows the rows the server found", () => {
    vi.useFakeTimers();
    searchState = {
      ...searchState,
      customers: [{ id: "c1", name: "Acme Pvt Ltd", domain: "acme.in" }],
      quotes: [{ id: "Q-2026-27-0042", customer_name: "Acme Pvt Ltd", amount: 1000, status: "draft" }],
    };
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "acme" } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText("Acme Pvt Ltd")).toBeTruthy();
    expect(screen.getByText("Q-2026-27-0042")).toBeTruthy();
  });
});
