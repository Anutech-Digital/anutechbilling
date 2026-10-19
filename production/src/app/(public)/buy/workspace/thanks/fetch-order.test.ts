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
  calls: 0,
  filters: [] as { op: string; col: string; val: unknown }[],
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
    return { from: () => chain };
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
  db.calls = 0;
  db.filters = [];
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
    const src = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/buy-workspace-client.tsx"), "utf8");
    expect(src.match(/thanksUrl\(json\.quoteId, json\.publicToken, (true|false)\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/\/buy\/workspace\/thanks\?order=/);
  });
  it("the checkout route reads the token back and returns it on both the live and simulated paths", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
    expect(src).toMatch(/\.select\("public_token"\)\.single\(\)/);
    expect(src.match(/^\s+publicToken,$/gm)).toHaveLength(2);
  });
});
