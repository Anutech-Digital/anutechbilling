// @vitest-environment jsdom
/**
 * R-1433 — an invoice from a subscription quote shows the subscription card with a working link;
 * other invoices show nothing extra; roles that cannot open /subscriptions see no card.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkedSubscriptionRow } from "@/lib/invoices/linked-subscriptions";

const S = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({ role: "billing" as string | null, rows: [] as unknown[] }));
const fetchSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: state.role === null ? undefined : { role: state.role } }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/invoices/linked-subscriptions", async (orig) => ({
  ...(await orig<typeof import("@/lib/invoices/linked-subscriptions")>()),
  fetchInvoiceSubscriptions: (...a: unknown[]) => { fetchSpy(...a); return Promise.resolve(state.rows); },
}));

import { InvoiceSubscriptionCard } from "./invoice-subscription-card";

const row: LinkedSubscriptionRow = {
  id: S, plan: "Business Starter", domain: "acme.in", customer_name: "Acme", status: "active",
  billing_cycle: "annual", term_months: 12, start_date: "2026-04-01", renewal_date: "2027-04-01", seats: 5,
};

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InvoiceSubscriptionCard invoiceId="INV-9" quoteIds={["q1"]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => { state.role = "billing"; state.rows = []; fetchSpy.mockClear(); });
afterEach(cleanup);

describe("R-1433 InvoiceSubscriptionCard", () => {
  it("shows plan, status, term, renewal date and an Open subscription link to the drawer", async () => {
    state.rows = [row];
    show();
    expect(await screen.findByText("Business Starter")).toBeTruthy();
    expect(screen.getByText("acme.in")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/Annual · billed yearly/)).toBeTruthy();
    expect(screen.getByText(/Renews/).parentElement?.textContent).toMatch(/2027/);
    const link = screen.getByRole("link", { name: /Open subscription/ });
    expect(link.getAttribute("href")).toBe(`/subscriptions?open=${S}&q=acme.in`);
  });

  it("an invoice with no subscription shows nothing", async () => {
    const { container } = show();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("a role that cannot open Subscriptions gets no card and no query", () => {
    state.role = "accountant";
    state.rows = [row];
    const { container } = show();
    expect(container.textContent).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is on the invoice page, and /subscriptions opens the drawer from ?open=", () => {
    const detail = readFileSync(join(process.cwd(), "src/app/(app)/invoices/invoice-detail.tsx"), "utf8");
    expect(detail).toMatch(/<InvoiceSubscriptionCard\b/);
    const subs = readFileSync(join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"), "utf8");
    expect(subs).toMatch(/openSubscriptionIdFromSearch\(window\.location\.search\)/);
    expect(subs).toMatch(/subs\.find\(\(x\) => x\.id === openFromLink\)/);
  });
});
