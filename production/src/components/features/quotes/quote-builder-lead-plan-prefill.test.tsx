// @vitest-environment jsdom
//
// R-1765 (Pardeep, 22 Oct 2026): "lead bharte waqt jo plan select kiya tha wo quote bhejte waqt
// automatically item select hona chahiye by default". Localhost lead L-MVJL9MN0: contact
// "pardeep shrma", company EMPTY, plan "Google Workspace Business Starter", 10 seats — Send quote
// opened an empty quote. The lead-plan prefill returned early on `!leadCompany`, skipped a lead
// with blank seats, and dropped a plan that matched no catalogue row with only a toast.
// A NEW quote from a lead now always uses the lead's plan; Edit / Duplicate never do (R-1675).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const nav = vi.hoisted(() => ({ pathname: "/quotes/new", search: "leadId=L-2" }));
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

/* GW Business Starter ₹600/seat/month → ₹7,200/seat/year; Standard ₹1,080 → ₹12,960. */
const STARTER = {
  id: "item-gw-start", name: "Google Workspace Business Starter", vendor: "google", item_type: "recurring",
  kind: "main", msrp: 600, wholesale: 480, prices: {}, is_active: true, billing_unit: "per_seat_month",
};
const STANDARD = {
  id: "item-gw-std", name: "Google Workspace Business Standard", vendor: "google", item_type: "recurring",
  kind: "main", msrp: 1080, wholesale: 864, prices: {}, is_active: true, billing_unit: "per_seat_month",
};

type Lead = { company: string | null; plan: string | null; seats: number | null; contact_name: string | null };

/** The owner's localhost lead L-MVJL9MN0, shape for shape. */
const OWNER_LEAD: Lead = {
  company: null, plan: "Google Workspace Business Starter", seats: 10, contact_name: "pardeep shrma",
};

let root: Root | null = null;
beforeEach(() => { toasts.messages = []; });
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  nav.pathname = "/quotes/new";
  nav.search = "leadId=L-2";
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function open(lead: Lead, opts: { quote?: Record<string, unknown> } = {}): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["customers"], []);
  qc.setQueryData(["subscriptions"], []);
  qc.setQueryData(["items", "all", false], [STARTER, STANDARD]);
  if (opts.quote) qc.setQueryData(["quotes", "Q-2"], opts.quote);
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
  /* The lead answers last, as on localhost. */
  await act(async () => {
    qc.setQueryData(["leads", "quote-lead", "L-2"], {
      id: "L-2", billing_cycle: "yearly", contact_email: null, contact_phone: null,
      state_code: "07", gstin: null, ...lead,
    });
  });
  await tick();
  await tick();
  return container;
}

function input(container: HTMLElement, label: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

describe("R-1765: a new quote from a lead starts with the lead's plan", () => {
  it("company EMPTY, contact only, Business Starter × 10 → the Starter line with 10 seats", async () => {
    const c = await open(OWNER_LEAD);
    expect(Number(input(c, `Quantity for ${STARTER.name}`)?.value)).toBe(10);
    expect(Number(input(c, `Rate for ${STARTER.name}`)?.value)).toBe(7200);
    expect(c.textContent).not.toContain("Seats not on the lead");
  });

  it("seats blank on the lead → qty 1 with 'Seats not on the lead — check the quantity'", async () => {
    const c = await open({ company: "Acme Pvt Ltd", plan: "Business Standard", seats: null, contact_name: "Ravi" });
    expect(Number(input(c, `Quantity for ${STANDARD.name}`)?.value)).toBe(1);
    expect(c.textContent).toContain("Seats not on the lead — check the quantity");
  });

  it("seats 0 on the lead → qty 1 with the same hint; the hint goes once the qty is typed", async () => {
    const c = await open({ company: null, plan: "Google Workspace Business Standard", seats: 0, contact_name: "Ravi" });
    const qty = input(c, `Quantity for ${STANDARD.name}`)!;
    expect(Number(qty.value)).toBe(1);
    expect(c.textContent).toContain("Seats not on the lead — check the quantity");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(qty, "25");
      qty.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    expect(c.textContent).not.toContain("Seats not on the lead");
  });

  it("plan not in the catalogue → no line, a clear message, and the item picker searches the plan", async () => {
    const c = await open({ company: null, plan: "Zylo Mail Ultra", seats: 5, contact_name: "Ravi" });
    expect(input(c, `Quantity for Zylo Mail Ultra`)).toBeNull();
    expect(c.textContent).toContain(`The lead's plan "Zylo Mail Ultra" is not in your Items — pick the item`);
    const pick = [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Pick the item");
    expect(pick).toBeTruthy();
    await act(async () => { pick!.click(); });
    await tick();
    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search items"]');
    expect(search?.value).toBe("Zylo Mail Ultra");
  });

  it("Duplicate of a quote whose lead has no company still copies the source lines (R-1675)", async () => {
    nav.search = "duplicate=Q-2";
    const c = await open(OWNER_LEAD, {
      quote: {
        id: "Q-2", status: "draft", customer_id: null, customer_name: "pardeep shrma", lead_id: "L-2",
        line_items: [{
          id: "l1", item_id: STANDARD.id, name: STANDARD.name, vendor: "google", qty: 3,
          commitment: "annual_yearly", cost: 10368, rate: 11000, list_rate: 12960,
        }],
        subtotal: 33000, total_cost: 31104, discount_pct: 0, tax_rate: 18, amount: 38940,
        currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: "pending",
        prospect_state_code: "07", prospect_country: "India", notes: "Saved notes",
      },
    });
    expect(Number(input(c, `Rate for ${STANDARD.name}`)?.value)).toBe(11000);
    expect(input(c, `Quantity for ${STARTER.name}`)).toBeNull();
    expect(toasts.messages.some((m) => m.startsWith("Pre-filled from catalog"))).toBe(false);
  });
});
