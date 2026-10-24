/**
 * R-1786 — the cart checkout under both CATALOG_FROM_DB states.
 *
 *   · flag off, and flag on with the catalogue at the R-1785 seed prices: every sample cart
 *     from route.bundle.test.ts (R-1595 free domain + mailbox rules) is charged the SAME rupee;
 *   · flag on with an edited row: the catalogue price is charged;
 *   · flag on with a missing row: the code price is charged (never ₹0, never a refused cart).
 *
 * Same mocks and simulation path as app/api/public/checkout/cart/route.bundle.test.ts, plus an
 * `items` read for the price book.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const catalog = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], reads: 0 }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        // The price book's read (by SKU); checkout's own hosting-line linking reads "id, name".
        if (table === "items" && /\bsku\b/.test(columns)) {
          catalog.reads++;
          const chain = { eq: () => chain, in: async () => ({ data: catalog.rows, error: null }) };
          return chain;
        }
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            eq: async () => ({ data: [], error: null }),
          }),
        };
      },
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

const PRICE: Record<string, number> = { ai: 6999, in: 749, com: 999 };
const lookupDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains,
}));

import { POST } from "@/app/api/public/checkout/cart/route";
import { CORE_SKUS } from "./catalog-prices";
import { forgetCatalogPricesForTests } from "./catalog-prices.server";

const SEEDED: Record<string, number> = {
  "HOST-STARTER-YR": 600, "HOST-STARTER-MO": 100, "HOST-STANDARD-YR": 1500, "HOST-STANDARD-MO": 250,
  "HOST-PLUS-YR": 2246, "HOST-PLUS-MO": 374, "MAIL-ANUTECH-YR": 948,
  "SSL-POSITIVE-YR": 899, "SSL-WILDCARD-YR": 4499, "SSL-OVEV-YR": 6999,
};
const seedRows = (over: Record<string, number> = {}, drop: string[] = []) =>
  CORE_SKUS.filter((c) => !drop.includes(c.sku)).map((c) => ({
    sku: c.sku, name: c.name, msrp: over[c.sku] ?? SEEDED[c.sku], hsn: c.hsn, term_months: c.termMonths,
    fulfilment: c.fulfilment, engine_ref: c.engineRef, is_public: true,
  }));

const address = { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001" };
const buyer = { fullName: "Test Buyer", email: "buyer@example.invalid", phone: "9999999999", stateCode: "07", simulate: true, address };
const req = (body: Record<string, unknown>) =>
  new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...buyer, ...body }),
  });
const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;

const dom = (d: string) => ({ sku: `domain:${d.split(".").pop()}`, domain: d, qty: 1 });
const box = (qty: number) => ({ sku: "mailbox:anutech", qty });
const plan = (tier: string, cycle: "yearly" | "monthly") => ({ sku: `hosting:${tier}`, cycle, qty: 1 });

/** The sample carts of route.bundle.test.ts (R-1595), plus one of each tier and cycle. */
const CARTS: Record<string, Record<string, unknown>> = {
  "audit cart: Starter yearly + 3 × .ai + 50 mailboxes": { domain: "alpha.ai", lines: [plan("starter", "yearly"), dom("alpha.ai"), dom("beta.ai"), dom("gamma.ai"), box(50)] },
  "Starter yearly + free .in + free mailbox": { lines: [plan("starter", "yearly"), dom("acme.in"), box(1)] },
  "Starter monthly: nothing free": { lines: [plan("starter", "monthly"), dom("acme.in"), box(1)] },
  "2 domains: second charged": { domain: "acme.in", lines: [plan("starter", "yearly"), dom("acme.in"), dom("other.com")] },
  "Standard + Plus yearly": { lines: [{ ...plan("standard", "yearly"), hostingDomain: "a.in" }, { ...plan("plus", "yearly"), hostingDomain: "b.in" }] },
  "Plus monthly + 3 mailboxes": { domain: "acme.in", lines: [plan("plus", "monthly"), box(3)] },
};

async function charge(cart: Record<string, unknown>) {
  inserts.rows = [];
  forgetCatalogPricesForTests();
  const res = await POST(req(cart));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  const q = quote()!;
  return { subtotal: q.subtotal as number, amount: q.amount as number, lines: q.line_items as { name: string; qty: number; rate: number }[] };
}

beforeEach(() => {
  catalog.rows = seedRows();
  catalog.reads = 0;
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
  lookupDomains.mockReset().mockImplementation(async (base: string, tlds: string[]) => ({
    ok: true,
    base,
    source: "engine",
    domains: tlds.map((t) => ({ domain: `${base}.${t}`, available: true, price: PRICE[t], currency: "INR", years: 1, priceKnown: true })),
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("R-1786: cart totals are the same with CATALOG_FROM_DB off and on (seeded catalogue)", () => {
  it.each(Object.keys(CARTS))("%s", async (name) => {
    vi.stubEnv("CATALOG_FROM_DB", "");
    const off = await charge(CARTS[name]);
    expect(catalog.reads).toBe(0); // flag off never reads the catalogue
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const on = await charge(CARTS[name]);
    expect(catalog.reads).toBeGreaterThan(0);
    expect(on.subtotal).toBe(off.subtotal);
    expect(on.amount).toBe(off.amount);
    expect(on.lines.map((l) => [l.name, l.qty, l.rate])).toEqual(off.lines.map((l) => [l.name, l.qty, l.rate]));
  });

  it("the known figures still hold: Starter yearly + .in + mailbox = ₹708", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    expect((await charge(CARTS["Starter yearly + free .in + free mailbox"])).amount).toBe(708);
  });
});

describe("R-1786: flag on — the catalogue row is what is charged", () => {
  it("Starter Yearly edited to ₹610 on the Items page → ₹610 + GST", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    catalog.rows = seedRows({ "HOST-STARTER-YR": 610 });
    const c = await charge({ domain: "acme.in", lines: [plan("starter", "yearly")] });
    expect(c.subtotal).toBe(610);
    expect(c.amount).toBe(720);
  });

  it("mailbox edited to ₹999 → each paid mailbox ₹999; the R-1595 free one stays free", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    catalog.rows = seedRows({ "MAIL-ANUTECH-YR": 999 });
    const c = await charge({ domain: "acme.in", lines: [plan("starter", "yearly"), box(3)] });
    expect(c.subtotal).toBe(600 + 2 * 999);
  });

  it("a missing row falls back to the code price (logged), never ₹0 and never a refused cart", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    catalog.rows = seedRows({}, ["HOST-PLUS-MO", "MAIL-ANUTECH-YR"]);
    const c = await charge({ domain: "acme.in", lines: [plan("plus", "monthly"), box(1)] });
    expect(c.subtotal).toBe(374 + 948);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/HOST-PLUS-MO, MAIL-ANUTECH-YR/));
  });
});
