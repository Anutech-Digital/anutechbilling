// @vitest-environment jsdom
//
// R-2028 — the owner's real path (27 Oct, Q-4786-27-0001): a quote line typed by hand,
// "Google Workspace Business Starter (1 year)", had no item_id and cost 0 → "At least one line
// has no vendor cost" → Needs approval, every customer copy locked. The builder now offers the
// tenant's own catalogue row under that line — "Is this Google Workspace Business Starter? Use
// cost ₹2,640 (Annual commitment)" — and one click links the item and fills the cost. The typed
// sell price stays exactly as typed (R-2178: a typed price is never changed silently).
// And (3): "Add cost" on the quote opens /quotes/<id>/edit?addCost=<line number> with that cost box focused.
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

import { QuoteBuilder } from "./quote-builder";

/* GW Business Starter: ₹270 / ₹220 a seat a month → ₹3,240 / ₹2,640 a seat a year. */
const STARTER = {
  id: "item-gw-start", name: "Google Workspace Business Starter", vendor: "google", item_type: "recurring",
  msrp: 270, wholesale: 220, prices: {}, is_active: true, billing_unit: "per_seat_month",
};
const TYPED_NAME = "Google Workspace Business Starter (1 year)";

function quoteWithTypedLine(name: string, rate = 3000) {
  return {
    id: "Q-1", status: "draft", customer_id: null, customer_name: "E2E Test Co", lead_id: null,
    line_items: [{ id: "typed", name, qty: 5, rate, cost: 0, commitment: "annual_yearly" }],
    subtotal: rate * 5, total_cost: 0, discount_pct: 0, tax_rate: 18, amount: Math.round(rate * 5 * 1.18),
    currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: "not_required",
    prospect_state_code: "07", prospect_country: "India",
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  nav.search = "";
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

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
  await tick();
  await act(async () => { qc.setQueryData(["items", "all", false], [STARTER]); });
  await tick();
  return container;
}

const costInputs = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll<HTMLInputElement>(`input[aria-label="Cost for ${name}"]`)];
const rateInput = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLInputElement>(`input[aria-label="Rate for ${name}"]`);
const useButtons = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Use cost"));

describe("R-2028 (1): a hand-typed line is matched to the catalogue", () => {
  it("the typed GW Starter line shows 'Is this … ? Use cost ₹2,640 (Annual commitment)'", async () => {
    const c = await openEdit(quoteWithTypedLine(TYPED_NAME));
    expect(c.textContent).toContain(`Is this ${STARTER.name}?`);
    expect(useButtons(c)[0]?.textContent).toBe("Use cost ₹2,640 (Annual commitment)");
  });

  it("one click links the item and fills the cost; the typed rate stays ₹3,000; the no-cost banner goes", async () => {
    const c = await openEdit(quoteWithTypedLine(TYPED_NAME));
    expect(c.textContent).toContain("has no cost, so the margin below is not real");
    await act(async () => { useButtons(c)[0]!.click(); });
    await tick();
    for (const el of costInputs(c, TYPED_NAME)) expect(Number(el.value)).toBe(2640);
    expect(Number(rateInput(c, TYPED_NAME)?.value)).toBe(3000);
    expect(c.textContent).not.toContain(`Is this ${STARTER.name}?`);
    expect(c.textContent).not.toContain("has no cost, so the margin below is not real");
  });

  it("a typed name that matches nothing shows no suggestion", async () => {
    const c = await openEdit(quoteWithTypedLine("Website design and setup"));
    expect(c.textContent).not.toContain("Is this");
    expect(useButtons(c)).toHaveLength(0);
  });
});

describe("R-2028 (3): the no-cost banner names the line and 'Add cost' opens its cost box", () => {
  it("banner names line 1 and its 'Add cost' button focuses that line's cost box", async () => {
    const c = await openEdit(quoteWithTypedLine("Website design and setup"));
    expect(c.textContent).toContain('Line 1 "Website design and setup" has no cost');
    const add = [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add cost");
    expect(add).toBeTruthy();
    await act(async () => { add!.click(); });
    expect(costInputs(c, "Website design and setup")).toContain(document.activeElement);
  });

  it("?addCost=<line number> (from the quote's 'Add cost') opens the builder with that cost box focused", async () => {
    nav.search = "addCost=1";
    const c = await openEdit(quoteWithTypedLine("Website design and setup"));
    await tick();
    expect(costInputs(c, "Website design and setup")).toContain(document.activeElement);
  });
});
