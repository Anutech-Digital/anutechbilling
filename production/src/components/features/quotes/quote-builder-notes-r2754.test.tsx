// @vitest-environment jsdom
//
// R-2754 — a renewal quote opened from Renewals: the "Notes for customer" box shows only what
// the customer reads (no "subscription <uuid>" system sentence), the staff part is a small line
// without the id, and "Back to Renewals" (?returnTo=/renewals?bucket=…) links to the same tab.
//
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

const SUB = "c2458000-0000-4000-8000-000000000311";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function renewalQuote(notes: string) {
  return {
    id: "Q-1", status: "draft", customer_id: null, customer_name: "SCN Kochi", lead_id: null,
    line_items: [{ id: "l1", item_id: ITEM.id, name: ITEM.name, vendor: "google", qty: 10,
      commitment: "annual_yearly", cost: 10368, rate: 12960, list_rate: 12960 }],
    subtotal: 129600, total_cost: 103680, discount_pct: 0, tax_rate: 18, amount: 152928,
    currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: null,
    prospect_state_code: "07", prospect_country: "India",
    is_renewal: true, is_extension: false, plan: ITEM.name, notes,
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  nav.search = "";
});

async function openEdit(quote: unknown): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["quotes", "Q-1"], quote);
  qc.setQueryData(["customers"], []);
  qc.setQueryData(["subscriptions"], []);
  qc.setQueryData(["items", "all", false], [ITEM]);
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

const notesBox = (c: HTMLElement) => {
  const el = c.querySelector<HTMLTextAreaElement>("#qb-notes");
  if (!el) throw new Error("notes box not rendered");
  return el;
};

describe("R-2754: renewal quote editor — Notes for customer", () => {
  it("shows the customer line, never 'Renewal quote (operator-generated) for subscription <uuid>'", async () => {
    const c = await openEdit(renewalQuote(`Renewal quote (operator-generated) for subscription ${SUB}`));
    const box = notesBox(c);
    expect(box.value).toBe(`Renewal of ${ITEM.name} for 12 months.`);
    expect(box.value).not.toMatch(UUID);
    const staff = c.querySelector("[data-staff-note]");
    expect(staff?.textContent).toContain("not shown to the customer");
    expect(staff?.textContent).not.toMatch(UUID);
    expect(c.textContent).not.toMatch(UUID);
  });

  it("opened from Renewals → 'Back to Renewals' goes to the same tab", async () => {
    nav.search = `returnTo=${encodeURIComponent("/renewals?bucket=d30")}`;
    const c = await openEdit(renewalQuote(`Renewal quote for subscription ${SUB}`));
    const back = c.querySelector<HTMLAnchorElement>("[data-back-to-renewals]");
    expect(back?.textContent).toContain("Back to Renewals");
    expect(back?.getAttribute("href")).toBe("/renewals?bucket=d30");
  });

  it("no back link without returnTo, and never to another site", async () => {
    let c = await openEdit(renewalQuote(`Renewal quote for subscription ${SUB}`));
    expect(c.querySelector("[data-back-to-renewals]")).toBeNull();
    act(() => root?.unmount());
    nav.search = `returnTo=${encodeURIComponent("https://evil.com/renewals")}`;
    c = await openEdit(renewalQuote(`Renewal quote for subscription ${SUB}`));
    expect(c.querySelector("[data-back-to-renewals]")).toBeNull();
  });

  it("an ordinary quote's notes load into the box unchanged", async () => {
    const c = await openEdit({ ...renewalQuote("Prices valid for 15 days."), is_renewal: false });
    expect(notesBox(c).value).toBe("Prices valid for 15 days.");
    expect(c.querySelector("[data-staff-note]")).toBeNull();
  });
});
