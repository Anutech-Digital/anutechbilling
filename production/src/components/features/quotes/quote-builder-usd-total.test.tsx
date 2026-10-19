// @vitest-environment jsdom
//
// R-1677 — a USD export quote's builder total must be the dollar total the customer is shown
// on the accept page and the PDF ($33.84 × 10 = $338.40). "Round off total" was ticked by
// default and the builder said $338. And the export line must name the country, never "()".
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

vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

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

describe("R-1677: USD builder total = the customer's total", () => {
  it("shows $338.40, never the whole-dollar $338", async () => {
    const text = (await openEdit()).textContent ?? "";
    expect(text).toContain("$338.40");
    expect(text).not.toMatch(/\$338(?![.\d])/);
  });

  it("the export line names the country", async () => {
    const text = (await openEdit()).textContent ?? "";
    expect(text).toContain("Export (United States)");
    expect(text).not.toContain("Export ()");
  });
});
