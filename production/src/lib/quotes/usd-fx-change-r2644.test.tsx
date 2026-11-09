// @vitest-environment jsdom
// R-2644 — a USD quote: changing the exchange rate (typed or "Latest") after a catalogue line was
// added showed "Quote discount (0%) −$0.00" although price = list (10 × $48 @ 94.8755: list gross
// ₹45,540.24 unrounded vs the per-line rounded subtotal ₹45,540). Setup copied from R-2638's test.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { catalogLineListRate } from "./catalog-line";
import { inrRateFromForeign } from "./foreign-totals";

let search = "";
let path = "/quotes/Q-1/edit";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => path,
}));

vi.mock("@/lib/supabase/client", () => {
  const never = new Promise(() => {});
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? never.then.bind(never) : chain),
    apply: () => chain,
  });
  return { createClient: () => chain };
});
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

import { QuoteBuilder } from "@/components/features/quotes/quote-builder";

const FX = 95.1;
/* ₹1,000/seat/month in India, $4/seat/month abroad — the "USD price far under the ₹ list" shape. */
const ITEM = {
  id: "ITM-R2638", name: "Acme Cloud Seat", vendor: "acme", item_type: "subscription", is_active: true,
  msrp: 1000, wholesale: 700,
  prices: { annual: { msrp: 1000, wholesale: 700 }, monthly: { msrp: 1100, wholesale: 770 }, usd: { msrp: 4, wholesale: 2.5 } },
};
const usd = { msrp: 4, wholesale: 2.5, fx: FX };
const yearUsd = catalogLineListRate(ITEM, "annual_yearly", usd);   // $48 × 95.10 = ₹4,564.80

function quote(rate: number, list: number) {
  return {
    id: "Q-1", status: "draft", customer_id: null, customer_name: "Acme Inc", lead_id: null,
    line_items: [{ id: "l1", item_id: ITEM.id, name: ITEM.name, qty: 10, rate, list_rate: list, cost: yearUsd.cost, commitment: "annual_yearly" }],
    subtotal: Math.round(10 * rate), total_cost: 10 * yearUsd.cost, discount_pct: 0, tax_rate: 0, amount: Math.round(10 * rate),
    currency: "USD", exchange_rate: FX, billing_cycle: "yearly", approval_status: "not_required",
    prospect_state_code: null, prospect_country: "United States",
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  search = "";
  path = "/quotes/Q-1/edit";
});

async function open(q: ReturnType<typeof quote>): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["quotes", "Q-1"], q);
  qc.setQueryData(["items", "all", false], [ITEM]);
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

const rateBox = (c: HTMLElement) => c.querySelector<HTMLInputElement>(`input[aria-label="Rate for ${ITEM.name}"]`)!;

const fxBox = (c: HTMLElement) => c.querySelector<HTMLInputElement>("#billingRate")!;

async function typeFx(c: HTMLElement, v: string) {
  await act(async () => { fireEvent.change(fxBox(c), { target: { value: v } }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("R-2644: changing the exchange rate of a USD quote is not a discount", () => {
  it("95.10 → 94.8755 with the line on its USD list: no 'Quote discount' row", async () => {
    const c = await open(quote(yearUsd.rate, yearUsd.rate));
    expect(c.textContent ?? "").not.toContain("Quote discount");
    await typeFx(c, "94.8755");
    expect(rateBox(c).value).toBe("48");
    const text = c.textContent ?? "";
    expect(text).not.toContain("Quote discount");
    expect(text).not.toMatch(/Discount is \d/);
  });

  it("a real 30% discount survives the rate change", async () => {
    const c = await open(quote(inrRateFromForeign(2.8 * 12, FX), yearUsd.rate));
    await typeFx(c, "94.8755");
    expect(c.textContent ?? "").toContain("Quote discount (30%)");
  });
});
