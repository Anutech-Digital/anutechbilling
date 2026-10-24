/**
 * POST /api/dms/panel-order (owner decision 30, 25 Sep 2026).
 *
 * Pinned: only DMS's key gets in; the order is priced by the site cart's own code
 * (a hosting line's price comes from the server, not the body); the lead and the
 * Razorpay order name the DMS account; a panel order can be neither simulated nor a trial.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: {}, error: null }),
          eq: async () => ({ data: [], error: null }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => { inserts.rows.push({ table, row }); return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async () => ({ data: "Q-PANEL-0001", error: null }),
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({
  decryptTenantSecrets: () => ({ razorpay_key_id: "rzp_test_panel", razorpay_key_secret: "secret", razorpay_mode: "test" }),
}));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
const rzp = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("razorpay", () => ({ default: class { orders = { create: rzp.create }; } }));
const startHostingTrial = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial }));

import { POST } from "./route";

const KEY = "panel-key-0123456789abcdef";
const order = {
  dmsUserId: "665f0c0ffee",
  fullName: "Asha Verma", companyName: "Asha Co", email: "asha@example.invalid", phone: "9876543210",
  domain: "ashaco.in",
  lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1, label: "Starter", unitPrice: 1 }],
};
const req = (body: unknown, key: string | null = KEY) =>
  new NextRequest("https://example.invalid/api/dms/panel-order", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const row = (t: string) => inserts.rows.find((r) => r.table === t)?.row;

const ENV = { ...process.env };
beforeEach(() => {
  inserts.rows = [];
  rzp.create.mockReset().mockResolvedValue({ id: "order_PANEL1" });
  startHostingTrial.mockReset();
  process.env.DMS_PANEL_API_KEY = KEY;
});
afterEach(() => { process.env = { ...ENV }; });

describe("only DMS gets in", () => {
  it("no key configured here → 503, nothing created", async () => {
    process.env.DMS_PANEL_API_KEY = "";
    expect((await POST(req(order))).status).toBe(503);
    expect(inserts.rows).toHaveLength(0);
  });
  it("missing or wrong key → 401", async () => {
    expect((await POST(req(order, null))).status).toBe(401);
    expect((await POST(req(order, "wrong-key-0123456789abcdef"))).status).toBe(401);
    expect(inserts.rows).toHaveLength(0);
  });
  it("either key in a rotation list is accepted", async () => {
    process.env.DMS_PANEL_API_KEY = `old-key-0123456789abcdef,${KEY}`;
    expect((await POST(req(order))).status).toBe(200);
  });
});

describe("the order", () => {
  it("is priced by the server and names the DMS account on the lead, quote and Razorpay order", async () => {
    const res = await POST(req(order));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, orderId: "order_PANEL1", razorpayKeyId: "rzp_test_panel", quoteId: "Q-PANEL-0001" });
    const line = (row("quotes")?.line_items as { rate: number; commitment?: string }[])[0];
    expect(line.rate).toBeGreaterThan(1); // the body's unitPrice: 1 is ignored
    expect(line.commitment).toBe("annual_yearly");
    expect(row("leads")).toMatchObject({ source: "dms-panel" });
    expect(String(row("leads")?.notes)).toContain("DMS account 665f0c0ffee");
    expect(rzp.create.mock.calls[0][0].notes).toMatchObject({ channel: "dms-panel", dmsUserId: "665f0c0ffee" });
    // The quote's notes are printed on the customer's bill: true after payment, nothing internal.
    expect(row("quotes")?.notes).toBe("Ordered from your hosting control panel.");
    expect(String(row("quotes")?.notes)).not.toMatch(/pending|665f0c0ffee/);
  });
  it("no dmsUserId → 400, nothing created", async () => {
    const { dmsUserId: _drop, ...rest } = order;
    void _drop;
    expect((await POST(req(rest))).status).toBe(400);
    expect(inserts.rows).toHaveLength(0);
  });
  it("cannot be simulated", async () => {
    expect((await POST(req({ ...order, simulate: true }))).status).toBe(400);
    expect(inserts.rows).toHaveLength(0);
  });
  it("cannot start a trial — the panel has its own trial button", async () => {
    const res = await POST(req({ ...order, lines: [{ sku: "hosting-trial:starter", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect(startHostingTrial).not.toHaveBeenCalled();
  });
  it("not JSON → 400", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
  });
});

/* R-1595: the panel is priced by the same bundle rule as the site cart — a yearly plan brings
   ONE mailbox free, not every mailbox on the order. */
describe("the yearly-hosting bundle on a panel order", () => {
  it("Starter yearly + 10 mailboxes: one mailbox free, nine charged", async () => {
    const { MAILBOX_YR } = await import("@/site/lib/data/domains-landing");
    const res = await POST(req({ ...order, lines: [...order.lines, { sku: "mailbox:anutech", qty: 10 }] }));
    expect(res.status).toBe(200);
    const lines = row("quotes")?.line_items as { name: string; qty: number; rate: number }[];
    const boxes = lines.filter((l) => /^Mailbox/.test(l.name));
    expect(boxes.reduce((n, l) => n + l.qty, 0)).toBe(10);
    expect(boxes.reduce((s, l) => s + l.qty * l.rate, 0)).toBe(9 * MAILBOX_YR);
    expect(row("quotes")?.amount).toBe(Math.round((600 + 9 * MAILBOX_YR) * 1.18));
  });
});
