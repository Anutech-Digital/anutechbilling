/**
 * One domain for each hosting plan (owner, 30 Sep 2026: "A domain for each plan at checkout.
 * Each hosting line in the cart gets its own domain box, and two plans can't share a domain").
 *
 * Several plans have been one order since R-032 (1 Oct 2026); the switch this file used to turn
 * on for itself was removed on 9 Oct 2026. Same mocks as route.test.ts, through the simulation path.
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

import { POST } from "./route";

type Line = { name: string; domain?: string; hostingPlan?: string; hostingDomain?: string };
const buyer = { fullName: "Test Buyer", email: "buyer@example.invalid", phone: "9999999999", stateCode: "07", simulate: true };
const req = (body: Record<string, unknown>) =>
  new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...buyer, ...body }),
  });
const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;
const lines = (a: string | undefined, b: string | undefined) => [
  { sku: "hosting:starter", cycle: "yearly", qty: 1, ...(a ? { hostingDomain: a } : {}) },
  { sku: "hosting:plus", cycle: "yearly", qty: 1, ...(b ? { hostingDomain: b } : {}) },
];

beforeEach(() => {
  inserts.rows = [];
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
});

describe("several hosting plans, each on its own domain", () => {
  it("each plan's line carries its own domain, and the quote keeps the first plan's", async () => {
    const res = await POST(req({ lines: lines("a.in", "b.in") }));
    expect(res.status).toBe(200);
    const items = quote()!.line_items as Line[];
    expect(items.map((l) => [l.hostingPlan, l.hostingDomain])).toEqual([["starter", "a.in"], ["plus", "b.in"]]);
    expect(quote()!.domain).toBe("a.in");
  });

  it("each hosting line also names its domain in `domain`, so record_payment gives each plan's subscription its own domain (R-032)", async () => {
    await POST(req({ lines: lines("a.in", "b.in") }));
    expect((quote()!.line_items as Line[]).map((l) => l.domain)).toEqual(["a.in", "b.in"]);
  });

  it("…and none of them is ever queued for REGISTRATION: provisioning makes hosting accounts, not domains", async () => {
    await POST(req({ lines: lines("a.in", "b.in") }));
    const { provisioningProducts, domainsInLines } = await import("@/lib/provisioning/products");
    const { domainSubscriptionsToCreate } = await import("@/lib/domains/renewal");
    const items = quote()!.line_items;
    expect(domainsInLines(items)).toEqual([]);
    expect(domainSubscriptionsToCreate(items)).toEqual([]);
    expect(provisioningProducts({ lineItems: items, vendor: "hosting", domain: "a.in", seats: 0 }).map((p) => `${p.vendor}:${p.domain}:${p.plan}`))
      .toEqual(["hosting:a.in:hosting-starter", "hosting:b.in:hosting-plus"]);
  });

  it("two of the SAME plan on two domains are told apart in messages", async () => {
    const res = await POST(req({ lines: [
      { sku: "hosting:starter", cycle: "yearly", qty: 1, hostingDomain: "a.in" },
      { sku: "hosting:starter", cycle: "yearly", qty: 1, hostingDomain: "a.in" },
    ] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/your Starter hosting · 2 — a\.in is already on your Starter hosting · 1/);
  });

  it("the first plan may use the top-level domain field, as a one-plan cart does", async () => {
    await POST(req({ domain: "a.in", lines: lines(undefined, "b.in") }));
    expect((quote()!.line_items as Line[]).map((l) => l.hostingDomain)).toEqual(["a.in", "b.in"]);
  });

  it("two plans on one domain are refused, and nothing is saved", async () => {
    const res = await POST(req({ lines: lines("a.in", "www.A.in") }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/a different domain for your Plus hosting — a\.in is already on your Starter hosting/);
    expect(j.error).toMatch(/Nothing was charged/);
    expect(quote()).toBeUndefined();
  });

  it("a plan with no domain is refused by name, and nothing is saved", async () => {
    const res = await POST(req({ lines: lines("a.in", undefined) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/the domain for your Plus hosting/);
    expect(quote()).toBeUndefined();
  });

  it("a quantity above one is still refused: two accounts are two lines, each with a domain", async () => {
    const res = await POST(req({ domain: "a.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 2 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/add the plan once for each website/);
  });

  it("the notes list every plan's domain for staff", async () => {
    await POST(req({ lines: lines("a.in", "b.in") }));
    expect(String(inserts.rows.find((r) => r.table === "leads")?.row.notes ?? quote()!.notes)).toMatch(/Hosting domains: a\.in \(starter\), b\.in \(plus\)/);
  });
});
