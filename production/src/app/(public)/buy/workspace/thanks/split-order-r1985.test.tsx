// @vitest-environment jsdom
/**
 * R-1985: the thanks page for a MONTHLY order with a new domain — one payment over two quotes
 * (Workspace flex + the domain's own). The page shows the whole order (₹3,068 + ₹766 = ₹3,834,
 * paid in full) and BOTH GST invoices: the Workspace month-1 instalment (quote_id NULL, found
 * through the subscription — R-1974) and the domain's invoice (on the domain quote).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
vi.mock("@/lib/supabase/server", () => {
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let lim = Infinity;
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      not: (c: string) => { filters.push((r) => r[c] != null); return q; },
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
    };
    return q;
  }
  return { createAdminClient: () => ({ from: (t: string) => query(t) }) };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace/thanks",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

process.env.BUY_PAGE_TENANT_ID ||= "fbb976f1-9090-4f10-9726-0901bd144e42";
const T = process.env.BUY_PAGE_TENANT_ID;
const TOKEN = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";

import { fetchOrder } from "./fetch-order";
import { ThanksClient } from "./thanks-client";

function seed(domainPaid = true) {
  db.tables = {
    quotes: [
      {
        id: "Q-AT-27-0101", tenant_id: T, public_token: TOKEN, customer_name: "Ravi Traders", plan: "google-workspace-standard",
        seats: 2, amount: 3068, subtotal: 2600, payment_status: "received", payment_received_at: null, created_date: "2026-10-27",
        line_items: [{ name: "Google Workspace Business Standard — monthly (flex)" }], lead_id: "L-1", billing_cycle: "monthly",
      },
      {
        id: "Q-AT-27-0102", tenant_id: T, public_token: "other", customer_name: "Ravi Traders", plan: "domain-registration",
        seats: 1, amount: 766, subtotal: 649, payment_status: domainPaid ? "invoiced" : "awaiting", lead_id: "L-1",
        line_items: [{ name: "Domain ravitraders.in — registration, 1 year", domain: "ravitraders.in", registrant: {} }],
      },
    ],
    payments: [
      { tenant_id: T, quote_id: "Q-AT-27-0101", status: "received", amount: 3068 },
      ...(domainPaid ? [{ tenant_id: T, quote_id: "Q-AT-27-0102", status: "received", amount: 766 }] : []),
    ],
    invoices: domainPaid ? [{ id: "INV-AT-27-0052", tenant_id: T, quote_id: "Q-AT-27-0102" }] : [],
    subscriptions: [{ id: "sub-1", tenant_id: T, quote_id: "Q-AT-27-0101" }],
    subscription_billings: [{ tenant_id: T, subscription_id: "sub-1", invoice_id: "INV-AT-27-0051" }],
  };
}

beforeEach(() => seed());
afterEach(() => cleanup());

describe("R-1985 thanks page — one payment, two invoices", () => {
  it("the order is the whole payment ₹3,834, paid in full, with both GST invoices", async () => {
    const o = await fetchOrder("Q-AT-27-0101", TOKEN);
    expect(o).toMatchObject({
      amount: 3834, subtotal: 3249, amountReceived: 3834, paymentState: "paid",
      invoiceNumber: "INV-AT-27-0051", domainInvoiceNumber: "INV-AT-27-0052", newDomain: "ravitraders.in",
    });
  });

  it("the domain share not in yet → part-paid, never 'paid in full'", async () => {
    seed(false);
    const o = await fetchOrder("Q-AT-27-0101", TOKEN);
    expect(o).toMatchObject({ amount: 3834, amountReceived: 3068, paymentState: "part-paid", domainInvoiceNumber: null });
  });

  it("the page shows both invoice numbers", async () => {
    const o = await fetchOrder("Q-AT-27-0101", TOKEN);
    render(<ThanksClient order={o!} isSimulation={false} brand={null} />);
    expect(screen.getByTestId("thanks-invoice").textContent).toBe("INV-AT-27-0051");
    expect(screen.getByTestId("thanks-domain-invoice").textContent).toBe("INV-AT-27-0052");
    expect(screen.getByText("₹3,834")).toBeTruthy();
  });

  it("the domain quote's own token never opens the order page by itself as the Workspace order", async () => {
    expect(await fetchOrder("Q-AT-27-0102", TOKEN)).toBeNull();
  });
});
