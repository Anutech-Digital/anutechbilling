// @vitest-environment jsdom
//
// R-2648 — the builder quotes a buyer abroad at 0% (export). With no LUT for today's FY that invoice is
// refused later (R-2444); the builder now says so with the next step (Add LUT). With the LUT: no warning.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/quotes/Q-1/edit",
}));

vi.mock("@/lib/supabase/client", () => {
  const never = new Promise(() => {});
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? never.then.bind(never) : chain),
    apply: () => chain,
  });
  return { createClient: () => chain };
});

/* R-1755: the line ⋯ menu asks through the app-wide confirm (ConfirmProvider sits at the app root). */
const lutState = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/queries/tenant-luts", () => ({
  useTenantLuts: (enabled: boolean) => (enabled ? { isSuccess: true, isError: false, data: lutState.rows } : { isSuccess: false, isError: false, data: undefined }),
}));

vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

import { fyStartISO, fyBounds, fyLabel, istToday } from "@/lib/dates/ist";
import { QuoteBuilder } from "./quote-builder";

const QUOTE = {
  id: "Q-1", status: "draft", customer_id: null, customer_name: "Acme Inc", lead_id: null,
  line_items: [{ id: "l1", name: "Custom licence", qty: 10, rate: 3240, list_rate: 3240, cost: 1320, commitment: "annual_yearly" }],
  subtotal: 32400, total_cost: 13200, discount_pct: 0, tax_rate: 0, amount: 32400,
  currency: "USD", exchange_rate: 95.7485, billing_cycle: "yearly", approval_status: "not_required",
  prospect_state_code: null, prospect_country: "United States",
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function openEdit(): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["quotes", "Q-1"], QUOTE);
  qc.setQueryData(["items", "all", false], []);
  qc.setQueryData(["customers"], []);
  qc.setQueryData(["subscriptions"], []);
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={qc}><QuoteBuilder /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

const today = istToday();
const FY = fyLabel(today);

describe("R-2648: builder export quote and the LUT", () => {
  it("no LUT for today's FY → warning: the 0% invoice will be refused until the LUT is added", async () => {
    lutState.rows = [];
    const c = await openEdit();
    const w = c.querySelector('[data-testid="export-lut-warning"]');
    expect(w?.textContent).toContain(`No LUT for FY ${FY} on file: an export at 0% GST needs it, so the invoice for this quote will be refused`);
    expect(w?.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=company#lut");
  });

  it("LUT for today's FY → no warning, still 0% export", async () => {
    lutState.rows = [{ fyStart: fyStartISO(today), arn: "AD0704260001234", validFrom: fyStartISO(today), validUpto: fyBounds(today).end }];
    const c = await openEdit();
    expect(c.querySelector('[data-testid="export-lut-warning"]')).toBeNull();
    expect(c.textContent).toContain("0% (export)");
  });
});
