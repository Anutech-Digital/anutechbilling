// @vitest-environment jsdom
//
// R-2638 (split from R-2171 item 5) — the discount / approval check of a USD quote must compare
// the USD price with the item's USD list, never with the ₹ catalogue. Sep reconcile: an export
// quote asked the owner to approve a "70% discount" that did not exist.
//
// The approval maths (lineEconomics, SQL quote_lines_approval_bps) only ever compares a line's
// `rate` with its own `list_rate`, both stored ₹. So the bug is any path that leaves those two on
// DIFFERENT price lists: list_rate = the ₹ catalogue while the rate is the USD price × rate.
// Reproduced: a Commitment switch (Annual ⇄ Monthly) on a catalogue line of a USD quote re-priced
// the line from the item's ₹ tier (rate AND list ₹1,000/seat/month), and typing the item's real
// USD price ($4) back then read as a 62% discount against the ₹ list → owner approval.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lineEconomics } from "./approval-economics";
import { requiredApproval, discountBps } from "./approval";
import { catalogLineListRate } from "./catalog-line";
import { inrRateFromForeign } from "./foreign-totals";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

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

const commitSelect = (c: HTMLElement) => c.querySelector<HTMLSelectElement>(`select[aria-label="Commitment for ${ITEM.name}"]`)!;
const rateBox = (c: HTMLElement) => c.querySelector<HTMLInputElement>(`input[aria-label="Rate for ${ITEM.name}"]`)!;

describe("R-2638: the approval maths of a USD quote", () => {
  it("a USD line at the item's USD list price → 0% discount, no approval (rate and list both $ × rate)", () => {
    const line: QuoteLineItem = { id: "a", item_id: ITEM.id, name: ITEM.name, qty: 10, rate: yearUsd.rate, list_rate: yearUsd.rate, cost: yearUsd.cost, commitment: "annual_yearly" };
    const need = requiredApproval(lineEconomics([line]));
    expect(discountBps(lineEconomics([line]))).toBe(0);
    expect(need.tier).toBe("none");
  });

  it("a real 30% USD discount ($2.80 on a $4 list) → 30.00%, owner", () => {
    const rate = inrRateFromForeign(2.8 * 12, FX);
    const line: QuoteLineItem = { id: "a", item_id: ITEM.id, name: ITEM.name, qty: 10, rate, list_rate: yearUsd.rate, cost: 1, commitment: "annual_yearly" };
    expect(discountBps(lineEconomics([line]))).toBe(3000);
    expect(requiredApproval(lineEconomics([line])).tier).toBe("owner");
  });

  it("a typed (custom) USD line: list = what was typed → 0%", () => {
    const rate = inrRateFromForeign(2, FX);
    const line: QuoteLineItem = { id: "a", name: "Custom", qty: 10, rate, list_rate: rate, cost: inrRateFromForeign(1.5, FX), commitment: "annual_yearly" };
    expect(discountBps(lineEconomics([line]))).toBe(0);
  });
});

describe("R-2638: the builder keeps a USD line on the USD price list", () => {
  it("opening the saved USD quote: no quote discount", async () => {
    const text = (await open(quote(yearUsd.rate, yearUsd.rate))).textContent ?? "";
    expect(text).not.toContain("Quote discount");
  });

  it("Revise (duplicate) re-prices from the item's USD tier: no quote discount", async () => {
    search = "duplicate=Q-1"; path = "/quotes/new";
    const text = (await open(quote(yearUsd.rate, yearUsd.rate))).textContent ?? "";
    expect(text).not.toContain("Quote discount");
  });

  it("Commitment Annual → Monthly flex keeps the USD price ($4.00/seat/month), not the ₹ catalogue", async () => {
    const c = await open(quote(yearUsd.rate, yearUsd.rate));
    await act(async () => { fireEvent.change(commitSelect(c), { target: { value: "monthly" } }); });
    expect(rateBox(c).value).toBe("4");
    expect(c.textContent ?? "").not.toContain("Quote discount");
  });

  it("…and typing the USD price back after the switch is NOT a discount (the false '62% discount' approval)", async () => {
    const c = await open(quote(yearUsd.rate, yearUsd.rate));
    await act(async () => { fireEvent.change(commitSelect(c), { target: { value: "monthly" } }); });
    await act(async () => { fireEvent.change(rateBox(c), { target: { value: "4" } }); });
    const text = c.textContent ?? "";
    expect(text).not.toContain("Quote discount");
    expect(text).not.toMatch(/Discount is \d/);
  });

  it("Monthly → Annual keeps the USD price too ($4 × 12 = $48/seat/year)", async () => {
    const c = await open(quote(yearUsd.rate, yearUsd.rate));
    await act(async () => { fireEvent.change(commitSelect(c), { target: { value: "monthly" } }); });
    await act(async () => { fireEvent.change(commitSelect(c), { target: { value: "annual" } }); });
    expect(c.textContent ?? "").not.toContain("Quote discount");
    expect(rateBox(c).value).toBe("4");   // shown per month ($48/yr), never the ₹ tier ($126.18)
  });

  it("a real USD discount still shows: $2.80 typed on the $4 list after the switch → 30%", async () => {
    const c = await open(quote(yearUsd.rate, yearUsd.rate));
    await act(async () => { fireEvent.change(commitSelect(c), { target: { value: "monthly" } }); });
    await act(async () => { fireEvent.change(rateBox(c), { target: { value: "2.8" } }); });
    expect(c.textContent ?? "").toContain("Quote discount (30%)");
  });
});
