// @vitest-environment jsdom
//
// R-1532 — a business that is NOT GST-registered (or under composition) issues a Bill of
// Supply; since R-1529 the database refuses an invoice from a quote that carries GST. The
// builder still started at 18% and printed CGST/SGST, so every quote had to be fixed by hand.
// Owner's path: Settings → GST registration = Not registered → Quotes → open a quote.
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

vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

let saved: "registered" | "unregistered" | "composition" | null = "unregistered";
vi.mock("@/lib/compliance/gst-registration-query", () => ({
  useGstRegistration: () => ({
    data: { saved, compositionRate: 6, registeredFrom: null, rcDate: null, rcDateColumn: true, columnMissing: false },
    isLoading: false,
  }),
}));

import { QuoteBuilder } from "./quote-builder";

/* A draft priced intra-state (prospect in our own state would be CGST + SGST). */
const DRAFT = {
  id: "Q-1", status: "draft", customer_id: null, customer_name: "Sharma Traders", lead_id: null,
  line_items: [{ id: "l1", name: "Google Workspace Business Starter", qty: 2, rate: 1500, list_rate: 1500, cost: 1200, commitment: "annual_yearly" }],
  subtotal: 3000, total_cost: 2400, discount_pct: 0, tax_rate: 18, amount: 3540,
  currency: "INR", exchange_rate: 1, billing_cycle: "yearly", approval_status: "not_required",
  prospect_state_code: "06", prospect_country: "India",
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function open(): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["quotes", "Q-1"], DRAFT);
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

describe("R-1532: quote builder for a Bill of Supply business", () => {
  it("not registered → 0% GST, one Bill of Supply line, no CGST/SGST/IGST rows", async () => {
    saved = "unregistered";
    const el = await open();
    const text = el.textContent ?? "";
    expect(text).toContain("No GST — Bill of Supply (your business is not GST-registered)");
    expect(text).not.toMatch(/CGST \(|SGST \(|IGST \(/);
    expect(text).not.toContain("CGST + SGST split");
    expect(text).toMatch(/GST\s*0%/);
    // Grand total = taxable, no tax added (₹3,000 — not ₹3,540).
    expect(text).toContain("Total payable now₹3,000");
    expect(text).not.toContain("Total payable now₹3,540");
  });

  it("not registered → the GST rate box is locked at 0", async () => {
    saved = "unregistered";
    const el = await open();
    const change = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Change");
    expect(change).toBeTruthy();
    await act(async () => { change!.click(); });
    const input = el.querySelector<HTMLInputElement>("#taxRate");
    expect(input).toBeTruthy();
    expect(input!.disabled).toBe(true);
    expect(input!.value).toBe("0");
  });

  it("composition → same, and the line names the composition scheme", async () => {
    saved = "composition";
    const text = (await open()).textContent ?? "";
    expect(text).toContain("No GST — Bill of Supply (your business is under the GST composition scheme)");
    expect(text).not.toMatch(/CGST \(|SGST \(|IGST \(/);
  });

  it("registered → 18% with CGST + SGST as before", async () => {
    saved = "registered";
    const text = (await open()).textContent ?? "";
    expect(text).not.toContain("Bill of Supply");
    expect(text).toMatch(/GST\s*18%/);
    expect(text).toContain("CGST (9%)");
    expect(text).toContain("Total payable now₹3,540");
  });
});
