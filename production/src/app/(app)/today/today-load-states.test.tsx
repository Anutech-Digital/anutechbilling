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
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: () => (state.rpc ? state.rpc() : Promise.resolve({ data: [], error: null })) }) }));
vi.mock("@/lib/queries/compliance", () => ({
  useComplianceLog: () => state.compliance,
  toFiledMap: () => new Map(),
  useTdsMonths: () => ({ data: undefined }),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: undefined }) }));
vi.mock("@/lib/queries/deals", () => ({ useTodayDealItems: () => state.deals }));
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
