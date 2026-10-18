/**
 * R-1595 (18 Oct 2026): the yearly-hosting bundle, through the checkout API.
 *
 * The site promises ONE free domain and ONE free mailbox with a yearly plan:
 *   "The domain is ₹0 when it points at our hosting (yearly plan)" (/domains) and
 *   "Add one mailbox on <domain> — free with the plan" (/domains bundle card).
 * Until R-1595 the server made EVERY domain line and EVERY mailbox ₹0 once any yearly plan
 * was in the cart — Starter ₹600 + 3 × .ai + 50 mailboxes was charged ₹708.
 *
 * Same mocks as route.test.ts, through the simulation path (no Razorpay keys, NODE_ENV=test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          eq: async () => ({ data: [], error: null }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserts.rows.push({ table, row });
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc,
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial: vi.fn() }));

/* Every name is available; the 1-year price is the TLD's (.ai ₹6,999 as catalog.ts lists it). */
const PRICE: Record<string, number> = { ai: 6999, in: 749, com: 999 };
const lookupDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains,
}));

import { POST } from "./route";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";

type Line = { name: string; qty: number; rate: number; domain?: string; hostingPlan?: string };
const address = { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001" };
const buyer = { fullName: "Test Buyer", email: "buyer@example.invalid", phone: "9999999999", stateCode: "07", simulate: true, address };
const req = (body: Record<string, unknown>) =>
  new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...buyer, ...body }),
  });
const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;
const lead = () => inserts.rows.find((r) => r.table === "leads")?.row;
const items = () => quote()!.line_items as Line[];
/** Domain lines to register (hosting lines also carry `domain` — the account's own). */
const domainRate = (d: string) => items().find((l) => l.domain === d && !l.hostingPlan)?.rate;
const mailbox = () => items().filter((l) => /^Mailbox/.test(l.name));
const mailboxPaid = () => mailbox().reduce((s, l) => s + l.qty * l.rate, 0);
const mailboxQty = () => mailbox().reduce((s, l) => s + l.qty, 0);

const dom = (d: string) => ({ sku: `domain:${d.split(".").pop()}`, domain: d, qty: 1 });
const box = (qty: number) => ({ sku: "mailbox:anutech", qty });
const starter = (cycle: "yearly" | "monthly", hostingDomain?: string) => ({ sku: "hosting:starter", cycle, qty: 1, ...(hostingDomain ? { hostingDomain } : {}) });

beforeEach(() => {
  inserts.rows = [];
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
  lookupDomains.mockReset().mockImplementation(async (base: string, tlds: string[]) => ({
    ok: true,
    base,
    source: "engine",
    domains: tlds.map((t) => ({ domain: `${base}.${t}`, available: true, price: PRICE[t], currency: "INR", years: 1, priceKnown: true })),
  }));
});

describe("R-1595: one domain and one mailbox free per yearly hosting plan", () => {
  it("the audit's cart: Starter yearly + 3 × .ai + 50 mailboxes is NOT ₹600 + GST", async () => {
    const res = await POST(req({ domain: "alpha.ai", lines: [starter("yearly"), dom("alpha.ai"), dom("beta.ai"), dom("gamma.ai"), box(50)] }));
    expect(res.status).toBe(200);
    expect(domainRate("alpha.ai")).toBe(0); // the one the hosting points at
    expect(domainRate("beta.ai")).toBe(6999);
    expect(domainRate("gamma.ai")).toBe(6999);
    expect(mailboxQty()).toBe(50);
    expect(mailboxPaid()).toBe(49 * MAILBOX_YR);
    const subtotal = 600 + 2 * 6999 + 49 * MAILBOX_YR;
    expect(quote()!.subtotal).toBe(subtotal);
    expect(quote()!.amount).toBe(Math.round(subtotal * 1.18));
    expect(quote()!.amount).not.toBe(708);
  });

  it("1 domain + 1 mailbox with yearly hosting: both free, ₹600 + GST", async () => {
    const res = await POST(req({ lines: [starter("yearly"), dom("acme.in"), box(1)] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(0);
    expect(mailboxPaid()).toBe(0);
    expect(quote()!.amount).toBe(708);
  });

  it("monthly hosting: nothing is free", async () => {
    const res = await POST(req({ lines: [starter("monthly"), dom("acme.in"), box(1)] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(749);
    expect(mailboxPaid()).toBe(MAILBOX_YR);
  });

  it("2 domains: the second is charged in full", async () => {
    const res = await POST(req({ domain: "acme.in", lines: [starter("yearly"), dom("acme.in"), dom("other.com")] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(0);
    expect(domainRate("other.com")).toBe(999);
    expect(quote()!.amount).toBe(Math.round((600 + 999) * 1.18));
  });

  it("the free domain is the one the hosting points at, even when it is not first in the cart", async () => {
    const res = await POST(req({ domain: "other.com", lines: [dom("acme.in"), starter("yearly"), dom("other.com")] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(749);
    expect(domainRate("other.com")).toBe(0);
  });

  it("hosting on a domain the buyer already owns: still only ONE cart domain free (the first)", async () => {
    const res = await POST(req({ domain: "mine.co.in", lines: [starter("yearly"), dom("acme.in"), dom("other.com")] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(0);
    expect(domainRate("other.com")).toBe(999);
  });

  it("mailbox quantity 10: one free, nine charged", async () => {
    const res = await POST(req({ domain: "acme.in", lines: [starter("yearly"), box(10)] }));
    expect(res.status).toBe(200);
    expect(mailboxQty()).toBe(10);
    expect(mailboxPaid()).toBe(9 * MAILBOX_YR);
    expect(quote()!.amount).toBe(Math.round((600 + 9 * MAILBOX_YR) * 1.18));
  });

  it("two mailbox lines: one mailbox free in all, not one per line", async () => {
    const res = await POST(req({ domain: "acme.in", lines: [starter("yearly"), box(1), box(1)] }));
    expect(res.status).toBe(200);
    expect(mailboxPaid()).toBe(MAILBOX_YR);
  });

  it("two yearly plans: one domain and one mailbox free for EACH plan", async () => {
    const res = await POST(req({ lines: [starter("yearly", "acme.in"), starter("yearly", "other.com"), dom("acme.in"), dom("other.com"), dom("third.in"), box(5)] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(0);
    expect(domainRate("other.com")).toBe(0);
    expect(domainRate("third.in")).toBe(749);
    expect(mailboxPaid()).toBe(3 * MAILBOX_YR);
  });

  it("a yearly + a monthly plan: only the yearly one brings a free domain and mailbox", async () => {
    const res = await POST(req({ lines: [starter("monthly", "acme.in"), starter("yearly", "other.com"), dom("acme.in"), dom("other.com"), box(2)] }));
    expect(res.status).toBe(200);
    expect(domainRate("acme.in")).toBe(749);
    expect(domainRate("other.com")).toBe(0);
    expect(mailboxPaid()).toBe(MAILBOX_YR);
  });

  it("staff see what was given free on the lead", async () => {
    await POST(req({ domain: "acme.in", lines: [starter("yearly"), dom("acme.in"), dom("other.com"), box(3)] }));
    expect(String(lead()!.notes)).toMatch(/Bundle \(yearly hosting\): acme\.in free; 1 mailbox free/);
  });
});
