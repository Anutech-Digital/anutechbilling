// @vitest-environment jsdom
/* R-2939 — Ctrl+K: typing "tasks overview" / "tasks calendar" finds those pages. Their menu
   rows say only "Overview" / "Calendar" (they sit under Tasks), so the typed word "tasks"
   matched nothing. */
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: [] }) }));
vi.mock("@/lib/queries/quotes", () => ({ useQuotes: () => ({ data: [] }) }));
vi.mock("@/lib/queries/contacts", () => ({ useAllContacts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/invoices", () => ({ useInvoices: () => ({ data: [] }) }));
vi.mock("@/lib/queries/subscriptions", () => ({ useSubscriptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payments", () => ({ usePayments: () => ({ data: [] }) }));
vi.mock("@/lib/queries/leads", () => ({ useLeadSearch: () => ({ data: [], isFetching: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: "sales", canViewDeals: true, tenantId: "t1" } }),
}));
vi.mock("@/components/features/subscriptions/add-seats-dialog", () => ({ default: () => null }));
vi.mock("@/lib/queries/palette-search", () => ({
  usePaletteSearch: () => ({ customers: [], quotes: [], invoices: [], subscriptions: [], contacts: [], payments: [], fetching: false }),
}));

import { CommandPalette } from "./command-palette";

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("CommandPalette — Tasks pages (R-2939)", () => {
  it.each([
    ["tasks overview", "Tasks overview"],
    ["tasks calendar", "Tasks calendar"],
  ])("typing %j offers the page %j", (typed, page) => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: typed } });
    expect(screen.getByText(page)).toBeTruthy();
  });

  it("typing tasks lists the list page and both views", () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tasks" } });
    for (const page of ["Tasks", "Tasks overview", "Tasks calendar"]) expect(screen.getByText(page)).toBeTruthy();
  });
});
