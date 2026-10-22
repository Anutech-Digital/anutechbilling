// @vitest-environment jsdom
//
// R-1675 — Editing an approval-pending quote with a rate 18% below list (Q-5F40-27-0091 on
// staging: saved ₹10,627/seat/yr, total ₹1,25,399) opened the builder at the catalogue price
// ₹12,960 / ₹1,52,928, so one untouched Save silently removed the discount. In-place Edit must
// load the saved line rates exactly as saved.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const nav = vi.hoisted(() => ({ pathname: "/quotes/Q-1/edit", search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => nav.pathname,
}));

/* No network in a test — every query the builder starts (beyond the seeded ones) stays pending. */
vi.mock("@/lib/supabase/client", () => {
  const never = new Promise(() => {});
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? never.then.bind(never) : chain),
    apply: () => chain,
  });
  return { createClient: () => chain };
});

/* R-1755: the line ⋯ menu asks through the app-wide confirm (ConfirmProvider sits at the app root). */
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

import { QuoteBuilder } from "./quote-builder";

/* GW Business Standard: ₹1,080/seat/month → ₹12,960/seat/year on an annual line. */
const ITEM = {
  id: "item-gw-std", name: "Google Workspace Business Standard", vendor: "google", item_type: "recurring",
  msrp: 1080, wholesale: 864, prices: {}, is_active: true, billing_unit: "per_seat_month",
};

function quoteWith(line: Record<string, unknown>) {
  return {
    id: "Q-1", status: "draft", customer_id: null, customer_name: "Acme Pvt Ltd", lead_id: null,
    line_items: [{
      id: "l1", item_id: ITEM.id, name: ITEM.name, vendor: "google", qty: 10,
      commitment: "annual_yearly", cost: 10368, ...line,
    }],
    subtotal: 106270, total_cost: 103680, discount_pct: 0, tax_rate: 18, amount: 125399,
    currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: "pending",
    prospect_state_code: "07", prospect_country: "India",
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function openEdit(quote: unknown): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["quotes", "Q-1"], quote);
  qc.setQueryData(["customers"], []);
  qc.setQueryData(["subscriptions"], []);
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <QuoteBuilder />
      </QueryClientProvider>,
    );
  });
  /* The edit page already holds the quote (it fetched it to run the draft guard); the
     catalogue answers AFTER the builder has loaded the lines — the order staging hit. */
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { qc.setQueryData(["items", "all", false], [ITEM]); });
  /* Let every effect (prefill, re-price, cost backfill) settle. */
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

function rateInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="Rate for ${ITEM.name}"]`);
  if (!el) throw new Error("rate input not rendered");
  return el;
}

describe("R-1675: in-place Edit loads the saved line rate, not the catalogue price", () => {
  it("a rate typed 18% below list (list_rate frozen on the line) stays ₹10,627", async () => {
    const c = await openEdit(quoteWith({ rate: 10627, list_rate: 12960 }));
    expect(Number(rateInput(c).value)).toBe(10627);
    expect(c.textContent).toContain("1,25,399");
    expect(c.textContent).not.toContain("1,52,928");
  });

  it("an older saved line with no list_rate keeps its saved rate too", async () => {
    const c = await openEdit(quoteWith({ rate: 10627 }));
    expect(Number(rateInput(c).value)).toBe(10627);
    expect(c.textContent).toContain("1,25,399");
  });

  it("a saved line whose frozen list_rate differs from today's catalogue keeps its rate", async () => {
    /* The catalogue moved since the quote was saved (or the line's list was frozen at another
       basis) — Edit still shows what the quote says, not a re-derived number. */
    const c = await openEdit(quoteWith({ rate: 10627, list_rate: 10627 }));
    expect(Number(rateInput(c).value)).toBe(10627);
  });
});
