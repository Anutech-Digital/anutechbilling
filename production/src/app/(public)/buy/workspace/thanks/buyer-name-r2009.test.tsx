// @vitest-environment jsdom
/**
 * R-2009 (27 Oct 2026, localhost test purchase Q-1111-27-0011): the thanks page greeted
 * "Welcome aboard, Gupta." — the first word of the COMPANY (quotes.customer_name). It now greets
 * the buyer by the first name they typed in "Your name" (saved on the order's lead as
 * contact_name, by both the buy page and the cart checkout). No saved name → "Welcome aboard."
 * with no name, never the company. The order summary keeps showing the company. The public read
 * stays tenant-scoped and hands the page only the first name — not the full name, email or phone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const db = vi.hoisted(() => ({
  lead: null as Record<string, unknown> | null,
  leadFilters: [] as { col: string; val: unknown }[],
  leadSelect: "",
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const quote = {
      id: "Q-1111-27-0011", tenant_id: "t", public_token: "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b",
      customer_name: "Gupta Test Traders", plan: "google-workspace-starter", seats: 1, amount: 1652, subtotal: 1400,
      payment_status: "received", payment_received_at: null, line_items: [], created_date: "2026-10-27",
      lead_id: "L-1", billing_cycle: "yearly",
    };
    const make = (table: string) => {
      const c: Record<string, unknown> = {};
      c.select = (cols: string) => { if (table === "leads") db.leadSelect = cols; return c; };
      c.eq = (col: string, val: unknown) => { if (table === "leads") db.leadFilters.push({ col, val }); return c; };
      c.in = () => c; c.order = () => c; c.limit = () => c;
      c.maybeSingle = async () => ({
        data: table === "quotes" ? quote : table === "leads" ? db.lead : null, error: null,
      });
      c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return c;
    };
    return { from: make };
  },
}));

import { fetchOrder } from "./fetch-order";
import { ThanksClient, type ThanksOrder } from "./thanks-client";
process.env.BUY_PAGE_TENANT_ID ||= "fbb976f1-9090-4f10-9726-0901bd144e42";

const TOKEN = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";

beforeEach(() => { db.lead = null; db.leadFilters = []; db.leadSelect = ""; });
afterEach(cleanup);

describe("R-2009 fetchOrder: the buyer's first name from the order's lead", () => {
  it("'Test Buyer' at 'Gupta Test Traders' → buyerFirstName 'Test', company unchanged", async () => {
    db.lead = { contact_name: "Test Buyer" };
    const o = await fetchOrder("Q-1111-27-0011", TOKEN);
    expect(o?.buyerFirstName).toBe("Test");
    expect(o?.customerName).toBe("Gupta Test Traders");
    expect(db.leadFilters).toEqual(expect.arrayContaining([
      { col: "id", val: "L-1" },
      { col: "tenant_id", val: process.env.BUY_PAGE_TENANT_ID },
    ]));
    expect(db.leadSelect).toBe("contact_name");
    // Only the first name reaches the page — no surname, email or phone.
    expect(JSON.stringify(o)).not.toContain("Buyer");
  });
  it("no saved name → null (never the company's first word)", async () => {
    db.lead = { contact_name: "  " };
    expect((await fetchOrder("Q-1111-27-0011", TOKEN))?.buyerFirstName).toBeNull();
    db.lead = null;
    expect((await fetchOrder("Q-1111-27-0011", TOKEN))?.buyerFirstName).toBeNull();
  });
});

const ORDER: ThanksOrder = {
  quoteId: "Q-1111-27-0011", customerName: "Gupta Test Traders", tierName: "Business Starter",
  seats: 1, amount: 1652, paymentStatus: "received", paymentState: "paid", amountReceived: 1652, paymentDate: null,
};

describe("R-2009 thanks page greeting", () => {
  it("name 'Test Buyer' + company 'Gupta Test Traders' → 'Welcome aboard, Test.'; COMPANY still the company", () => {
    render(<ThanksClient order={{ ...ORDER, buyerFirstName: "Test" }} isSimulation={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome aboard, Test.");
    expect(document.body.textContent).toContain("Gupta Test Traders");
  });
  it("missing name → 'Welcome aboard.' — not the company", () => {
    render(<ThanksClient order={{ ...ORDER, buyerFirstName: null }} isSimulation={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome aboard.");
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toMatch(/Gupta/);
  });
});
