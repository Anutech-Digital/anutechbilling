// @vitest-environment jsdom
/**
 * R-1535 (/today) — a failed queue load speaks plain words, never database text, and never
 * the developer line "migration … has not been applied" (that goes to the console log).
 * "All clear for today" only when every source loaded.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  rpc: null as null | (() => Promise<{ data: unknown; error: unknown }>),
  compliance: {} as Record<string, unknown>,
  deals: {} as Record<string, unknown>,
  revised: {} as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: () => (state.rpc ? state.rpc() : Promise.resolve({ data: [], error: null })) }) }));
vi.mock("@/lib/queries/compliance", () => ({
  useComplianceLog: () => state.compliance,
  toFiledMap: () => new Map(),
  useTdsMonths: () => ({ data: undefined }),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: undefined }) }));
vi.mock("@/lib/queries/deals", () => ({ useTodayDealItems: () => state.deals }));
vi.mock("@/lib/compliance/revised-invoice-query", () => ({ useRevisedInvoiceReminder: () => state.revised }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/today/inbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/today/inbox")>()),
  complianceTodayItems: () => [],
}));

import TodayPage from "./page";

const RAW = "Could not find the function public.today_inbox without parameters in the schema cache";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TodayPage /></QueryClientProvider>);
}

beforeEach(() => {
  state.rpc = null;
  state.compliance = { data: [], isLoading: false, error: null, refetch: vi.fn() };
  state.deals = { items: [], isLoading: false, error: null, refetch: vi.fn() };
  state.revised = { reminder: null, isLoading: false, error: null, rcDateColumn: true, refetch: vi.fn() };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("/today load errors (R-1535)", () => {
  it("queue failure: plain words + Try again, no raw text, no migration line, no 'All clear'", async () => {
    state.rpc = () => Promise.resolve({ data: null, error: { message: RAW, code: "PGRST202" } });
    renderPage();
    await screen.findByText(/Queues could not be loaded/);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(RAW);
    expect(text).not.toMatch(/migration|has not been applied|schema cache/i);
    expect(text).not.toMatch(/All clear/);
    expect(screen.getAllByRole("button", { name: /Try again/ }).length).toBeGreaterThan(0);
  });

  it("GST/TDS and deals failures: no raw text, a Try again, and no 'All clear'", async () => {
    state.compliance = { data: undefined, isLoading: false, error: new Error('permission denied for table compliance_log'), refetch: vi.fn() };
    state.deals = { items: [], isLoading: false, error: new Error("TypeError: Failed to fetch"), refetch: vi.fn() };
    renderPage();
    await screen.findByText(/GST \/ TDS deadlines could not be loaded/);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/permission denied for table|TypeError/);
    expect(text).not.toMatch(/All clear/);
    expect(screen.getAllByRole("button", { name: /Try again/ }).length).toBeGreaterThanOrEqual(2);
  });

  it("everything loaded and empty: All clear", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/All clear for today/)).toBeTruthy());
  });
});

describe("/today — R-1531 revised-invoice reminder", () => {
  const bill = (id: string, invoice_date: string) => ({
    id, invoice_date, amount: 5000, taxable_value: 5000, status: "pending", customer_name: "Acme",
    document_kind: "bill_of_supply", supplier_gst_status: "unregistered",
  });

  it("Bills of Supply after the effective date: one GST row linking to /compliance", async () => {
    const { revisedInvoiceReminder } = await import("@/lib/compliance/revised-invoice");
    state.revised = {
      reminder: revisedInvoiceReminder({
        settings: { saved: "registered", registeredFrom: "2026-09-01", rcDate: "2026-10-10" },
        bills: [bill("BOS-1", "2026-09-05"), bill("BOS-2", "2026-09-06")],
        today: "2026-10-19",
      }),
      isLoading: false, error: null, rcDateColumn: true, refetch: vi.fn(),
    };
    renderPage();
    const row = await screen.findByText("Issue revised tax invoices for 2 Bills of Supply · by 10 Nov 2026");
    expect(row.closest("a")?.getAttribute("href")).toBe("/compliance#revised-invoices");
    expect(document.body.textContent).not.toMatch(/All clear/);
  });

  it("none: no row (and All clear)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/All clear for today/)).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/revised tax invoice/i);
  });

  it("read failed: says so with Try again, no 'All clear', no raw text", async () => {
    state.revised = { reminder: null, isLoading: false, error: new Error("permission denied for table invoices"), rcDateColumn: true, refetch: vi.fn() };
    renderPage();
    await screen.findByText(/Bills of Supply after your GST registration could not be checked/);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/permission denied/);
    expect(text).not.toMatch(/All clear/);
    expect(screen.getAllByRole("button", { name: /Try again/ }).length).toBeGreaterThan(0);
  });
});
