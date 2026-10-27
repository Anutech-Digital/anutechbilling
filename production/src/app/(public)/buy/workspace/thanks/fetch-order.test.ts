/**
 * S11 (29 Sep 2026): /buy/workspace/thanks showed any paid order's name, seats and amount to
 * anybody who counted quote numbers. It now shows the order only with the quote's secret
 * `public_token`. Pinned: no token never reaches the database; a wrong token shows nothing,
 * exactly like a wrong number; the right token shows the order; the query stays scoped to
 * ANUTECH's tenant and to paid quotes; and the buy page and checkout route carry the token.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  payments: [] as { amount: number }[],
  calls: 0,
  filters: [] as { op: string; col: string; val: unknown }[],
  paymentFilters: [] as { op: string; col: string; val: unknown }[],
  invoice: null as { id: string } | null,
  invoiceFilters: [] as { op: string; col: string; val: unknown }[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    db.calls++;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => { db.filters.push({ op: "eq", col, val }); return chain; },
      in: (col: string, val: unknown) => { db.filters.push({ op: "in", col, val }); return chain; },
      maybeSingle: async () => ({ data: db.row, error: null }),
    };
    /* R-1624: the received sum is read from payments (status 'received', this quote, this tenant). */
    const pay = {
      select: () => pay,
      eq: (col: string, val: unknown) => { db.paymentFilters.push({ op: "eq", col, val }); return pay; },
      then: (ok: (v: { data: { amount: number }[]; error: null }) => unknown) => Promise.resolve({ data: db.payments, error: null }).then(ok),
    };
    /* R-1971: the GST invoice number for the order (invoices by quote_id). */
    const inv = {
      select: () => inv,
      eq: (col: string, val: unknown) => { db.invoiceFilters.push({ op: "eq", col, val }); return inv; },
      order: () => inv,
      limit: () => inv,
      maybeSingle: async () => ({ data: db.invoice, error: null }),
    };
    return { from: (table: string) => (table === "payments" ? pay : table === "invoices" ? inv : chain) };
  },
}));

import { fetchOrder } from "./fetch-order";
import { thanksUrl } from "./thanks-url";
/* R-1499: outside production the website tenant is never implied any more — name it, as a
   deployment does. (The fixture is the same id the routes used to fall back to.) */
process.env.BUY_PAGE_TENANT_ID ||= "fbb976f1-9090-4f10-9726-0901bd144e42";

const TOKEN = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";
const paidRow = () => ({
  id: "Q-2026-27-0042", tenant_id: "t", public_token: TOKEN, customer_name: "Asha Co", plan: "Business Starter",
  seats: 5, amount: 3186, payment_status: "received", payment_received_at: "2026-09-29T06:00:00Z",
  line_items: [{ name: "Google Workspace · Business Starter (annual)" }], created_date: "2026-09-29",
});

beforeEach(() => {
  db.row = paidRow();
  db.payments = [{ amount: 3186 }];
  db.calls = 0;
  db.filters = [];
  db.paymentFilters = [];
  db.invoice = null;
  db.invoiceFilters = [];
});

describe("R-1971: the thanks page shows the GST invoice number", () => {
  it("an issued invoice for this quote (same tenant) → its number; none yet → null", async () => {
    db.invoice = { id: "INV-T-27-0007" };
    const o = await fetchOrder("Q-2026-27-0042", TOKEN);
    expect(o?.invoiceNumber).toBe("INV-T-27-0007");
    expect(db.invoiceFilters).toEqual(expect.arrayContaining([
      { op: "eq", col: "quote_id", val: "Q-2026-27-0042" },
      { op: "eq", col: "tenant_id", val: process.env.BUY_PAGE_TENANT_ID },
    ]));
    db.invoice = null;
    expect((await fetchOrder("Q-2026-27-0042", TOKEN))?.invoiceNumber).toBeNull();
  });
});

describe("R-1624: the order's payment state comes from orderPaymentState, not 'received' alone", () => {
  it("received → paid", async () => {
    expect(await fetchOrder("Q-2026-27-0042", TOKEN)).toMatchObject({ paymentState: "paid", amountReceived: 3186 });
  });
  it("invoiced and fully paid → paid (was 'Partially paid')", async () => {
    db.row = { ...paidRow(), payment_status: "invoiced" };
    db.payments = [{ amount: 1000 }, { amount: 2186 }];
    expect(await fetchOrder("Q-2026-27-0042", TOKEN)).toMatchObject({ paymentState: "paid", amountReceived: 3186 });
    expect(db.paymentFilters).toEqual(expect.arrayContaining([
      { op: "eq", col: "quote_id", val: "Q-2026-27-0042" },
      { op: "eq", col: "status", val: "received" },
      { op: "eq", col: "tenant_id", val: expect.any(String) },
    ]));
  });
  it("invoiced but part paid → part-paid", async () => {
    db.row = { ...paidRow(), payment_status: "invoiced" };
    db.payments = [{ amount: 1000 }];
    expect(await fetchOrder("Q-2026-27-0042", TOKEN)).toMatchObject({ paymentState: "part-paid", amountReceived: 1000 });
  });
  it("partial → part-paid", async () => {
    db.row = { ...paidRow(), payment_status: "partial" };
    db.payments = [{ amount: 1000 }];
    expect(await fetchOrder("Q-2026-27-0042", TOKEN)).toMatchObject({ paymentState: "part-paid" });
  });
  it("the thanks page reads the state, never payment_status === 'received'", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/thanks/thanks-client.tsx"), "utf8");
    expect(src).toMatch(/order\.paymentState === "paid"/);
    expect(src).not.toMatch(/paymentStatus === "received"/);
  });
});

describe("the thanks page shows an order only with its secret token", () => {
  it("no token → nothing, and the database is never asked", async () => {
    expect(await fetchOrder("Q-2026-27-0042", undefined)).toBeNull();
    expect(await fetchOrder("Q-2026-27-0042", "")).toBeNull();
    expect(db.calls).toBe(0);
  });
  it("a wrong token → nothing (the same answer as a wrong number)", async () => {
    expect(await fetchOrder("Q-2026-27-0042", "not-the-token")).toBeNull();
    expect(await fetchOrder("Q-2026-27-0042", TOKEN.slice(0, -1) + "c")).toBeNull();
  });
  it("the right token → the customer-safe order, with no token or tenant in it", async () => {
    const order = await fetchOrder("Q-2026-27-0042", TOKEN);
    expect(order).toMatchObject({ quoteId: "Q-2026-27-0042", customerName: "Asha Co", seats: 5, amount: 3186, paymentStatus: "received" });
    expect(JSON.stringify(order)).not.toContain(TOKEN);
  });
  it("still scoped to ANUTECH's tenant and to paid quotes", async () => {
    await fetchOrder("Q-2026-27-0042", TOKEN);
    expect(db.filters).toContainEqual({ op: "eq", col: "tenant_id", val: expect.any(String) });
    /* "invoiced" since R-120: the invoice is issued right after payment and moves the quote
       there, so leaving it out answered every invoiced order "not found". Still only PAID states. */
    expect(db.filters).toContainEqual({ op: "in", col: "payment_status", val: ["received", "partial", "invoiced"] });
  });
  it("today's quote numbers carry the tenant code, and are accepted", async () => {
    db.row = { ...paidRow(), id: "Q-ADPL-2026-27-0048" };
    expect(await fetchOrder("Q-ADPL-2026-27-0048", TOKEN)).toMatchObject({ quoteId: "Q-ADPL-2026-27-0048" });
    expect(await fetchOrder("Q-ADPL-2026-27-0048", "wrong")).toBeNull();
  });
  it("the 16-character shape (Q-<code>-27-0005, since 30 Sep 2026) is accepted", async () => {
    db.row = { ...paidRow(), id: "Q-FBB9-27-0005" };
    expect(await fetchOrder("Q-FBB9-27-0005", TOKEN)).toMatchObject({ quoteId: "Q-FBB9-27-0005" });
  });
  it("a malformed number → nothing, never queried", async () => {
    expect(await fetchOrder("Q-1' or '1'='1", TOKEN)).toBeNull();
    expect(db.calls).toBe(0);
  });
});

describe("the buy page sends the token", () => {
  it("thanksUrl carries order, t and sim", () => {
    expect(thanksUrl("Q-2026-27-0042", TOKEN, false)).toBe(`/buy/workspace/thanks?order=Q-2026-27-0042&t=${TOKEN}`);
    expect(thanksUrl("Q-2026-27-0042", TOKEN, true)).toBe(`/buy/workspace/thanks?order=Q-2026-27-0042&t=${TOKEN}&sim=1`);
  });
  it("both redirects on the buy page use thanksUrl with the route's publicToken", () => {
    /* R-1971: the buy page's checkout is inline now — the submit logic lives in _parts/submit-order.ts. */
    const src = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/_parts/submit-order.ts"), "utf8");
    expect(src.match(/thanksUrl\(json\.quoteId, json\.publicToken, (true|false)\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/\/buy\/workspace\/thanks\?order=/);
  });
  it("the checkout route reads the token back and returns it on both the live and simulated paths", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
    expect(src).toMatch(/\.select\("public_token"\)\.single\(\)/);
    expect(src.match(/^\s+publicToken,$/gm)).toHaveLength(2);
  });
});

describe("R-1986: the thanks page names the plan as the buy page does", () => {
  it("a buy-page order (plan google-workspace-starter) → 'Business Starter'", async () => {
    db.row = { ...paidRow(), plan: "google-workspace-starter", line_items: [{ name: "Google Workspace Starter" }] };
    expect((await fetchOrder("Q-2026-27-0042", TOKEN))?.tierName).toBe("Business Starter");
  });
  it("a monthly buy-page order → 'Business Standard — monthly'", async () => {
    db.row = { ...paidRow(), plan: "google-workspace-standard", line_items: [{ name: "Google Workspace Business Standard — monthly (flex)" }] };
    expect((await fetchOrder("Q-2026-27-0042", TOKEN))?.tierName).toBe("Business Standard — monthly");
  });
  it("another quote keeps its line name", async () => {
    expect((await fetchOrder("Q-2026-27-0042", TOKEN))?.tierName).toBe("Business Starter");
  });
});
