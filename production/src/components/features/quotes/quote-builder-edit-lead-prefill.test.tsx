// @vitest-environment jsdom
//
// R-1675 (second pass) — staging d5355f2: /quotes/Q-5F40-27-0091/edit, a quote made from a LEAD
// whose plan is "Google Workspace Standard", saved at ₹10,627 × 10 (total ₹1,25,399), opened at
// ₹12,960 / ₹1,52,928 with the toast "Pre-filled from catalog: 10 × Google Workspace Business
// Standard @ ₹12960/seat/yr". The lead-plan prefill (meant for a NEW quote from a lead) ran on
// Edit — the quote's lead_id loads the lead, the lead's plan/seats fill a catalogue line, and
// that line replaced the saved ones. Edit, Duplicate and Revise copy the source quote's lines;
// the prefill must never run over them. A new quote from a lead still prefills (R-1667).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const nav = vi.hoisted(() => ({ pathname: "/quotes/Q-1/edit", search: "" }));
const toasts = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => nav.pathname,
}));

vi.mock("sonner", () => {
  const rec = (m: unknown) => { toasts.messages.push(String(m)); };
  const toast = Object.assign(rec, {
    success: rec, warning: rec, info: rec, error: rec, message: rec, loading: rec,
    dismiss: () => {}, promise: () => {},
  });
  return { toast, Toaster: () => null };
});

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

const LEAD = {
  id: "L-1", company: "Acme Pvt Ltd", plan: "Google Workspace Standard", seats: 10,
  billing_cycle: "yearly", contact_name: "Ravi", contact_email: "ravi@acme.test", contact_phone: null,
  state_code: "07", gstin: null,
};

const QUOTE = {
  id: "Q-1", status: "draft", customer_id: null, customer_name: "Acme Pvt Ltd", lead_id: "L-1",
  line_items: [{
    id: "l1", item_id: ITEM.id, name: ITEM.name, vendor: "google", qty: 10,
    commitment: "annual_yearly", cost: 10368, rate: 10627, list_rate: 12960,
  }],
  subtotal: 106270, total_cost: 103680, discount_pct: 0, tax_rate: 18, amount: 125399,
  currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: "pending",
  prospect_state_code: "07", prospect_country: "India", notes: "Saved notes",
};

type Order = "quote-lead-catalog" | "catalog-lead-quote" | "lead-after-quote";

let root: Root | null = null;
beforeEach(() => { toasts.messages = []; });
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  nav.pathname = "/quotes/Q-1/edit";
  nav.search = "";
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function open(order: Order): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["customers"], []);
  qc.setQueryData(["subscriptions"], []);
  const quote = () => qc.setQueryData(["quotes", "Q-1"], QUOTE);
  const lead = () => qc.setQueryData(["leads", "quote-lead", "L-1"], LEAD);
  const catalog = () => qc.setQueryData(["items", "all", false], [ITEM]);
  if (order === "catalog-lead-quote") { catalog(); }
  else { quote(); }
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
  if (order === "quote-lead-catalog") {
    await act(async () => { lead(); }); await tick();
    await act(async () => { catalog(); }); await tick();
  } else if (order === "catalog-lead-quote") {
    await act(async () => { lead(); }); await tick();
    await act(async () => { quote(); }); await tick();
  } else {
    /* The staging order: the quote is already there, the catalogue answers, the lead last. */
    await act(async () => { catalog(); }); await tick();
    await act(async () => { lead(); }); await tick();
  }
  await tick();
  return container;
}

function rateInput(container: HTMLElement): HTMLInputElement {
  const els = container.querySelectorAll<HTMLInputElement>(`input[aria-label="Rate for ${ITEM.name}"]`);
  if (els.length !== 1) throw new Error(`expected one rate input, got ${els.length}`);
  return els[0];
}

describe("R-1675: a lead-linked quote's saved lines are never replaced by the lead-plan prefill", () => {
  for (const order of ["quote-lead-catalog", "catalog-lead-quote", "lead-after-quote"] as const) {
    it(`Edit keeps ₹10,627 × 10 = ₹1,25,399 (${order})`, async () => {
      const c = await open(order);
      expect(Number(rateInput(c).value)).toBe(10627);
      expect(c.textContent).toContain("1,25,399");
      expect(c.textContent).not.toContain("1,52,928");
      expect(toasts.messages.some((m) => m.startsWith("Pre-filled from catalog"))).toBe(false);
    });
  }

  it("Duplicate / Revise copies the source lines, not a prefilled catalogue line", async () => {
    nav.pathname = "/quotes/new";
    nav.search = "duplicate=Q-1";
    const c = await open("lead-after-quote");
    expect(Number(rateInput(c).value)).toBe(10627);
    expect(c.textContent).not.toContain("1,52,928");
    expect(toasts.messages.some((m) => m.startsWith("Pre-filled from catalog"))).toBe(false);
  });

  it("a NEW quote from the lead still prefills from the catalogue (R-1667)", async () => {
    nav.pathname = "/quotes/new";
    nav.search = "leadId=L-1";
    const c = await open("lead-after-quote");
    expect(Number(rateInput(c).value)).toBe(12960);
    expect(toasts.messages.some((m) => m.startsWith("Pre-filled from catalog"))).toBe(true);
  });
});
