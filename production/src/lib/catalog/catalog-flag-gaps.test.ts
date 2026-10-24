/**
 * R-1797 — the gaps R-1786 left before CATALOG_FROM_DB can be switched on:
 *
 *   1. checkout's "Buy Starter instead" built its line from the code price   → cart-reprice.test.ts
 *   2. a cart saved before a price change kept the old price: the cart showed one total and
 *      the server charged another                                             → here (shown === charged)
 *   3. the Anutech Mail ₹79/mo display and the /quote SSL estimate read code prices → here
 *   4. /domains and /rates revalidated every 10 minutes, not 60 s            → here
 *
 * The parity test uses the SAME route the checkout pays through (simulation path) and the
 * SAME public catalogue the browser reads, with the catalogue at an edited price.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const catalog = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        if (table === "items" && /\bsku\b/.test(columns)) {
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
const lookupDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains,
}));

import { POST as checkout } from "@/app/api/public/checkout/cart/route";
import { GET as catalogApi } from "@/app/api/public/catalog/route";
import { bookMailboxMonthly, bookMailRates, buildPriceBook, codePriceBook, CORE_SKUS } from "./catalog-prices";
import { forgetCatalogPricesForTests } from "./catalog-prices.server";
import { cartPricesFromCatalog, repriceCartLines } from "@/site/lib/cart-reprice";
import { cartTotals, type CartLine } from "@/site/lib/money";
import { paidHostingLine } from "@/site/lib/hosting-cart-line";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { MAIL_RATES } from "@/site/lib/data/catalog";
import { emailFromRate } from "@/site/lib/live-catalog";
import { QUOTE_PRODUCTS, withPriceBook } from "@/site/lib/data/quote-catalog";

const SEEDED: Record<string, number> = {
  "HOST-STARTER-YR": 600, "HOST-STARTER-MO": 100, "HOST-STANDARD-YR": 1500, "HOST-STANDARD-MO": 250,
  "HOST-PLUS-YR": 2246, "HOST-PLUS-MO": 374, "MAIL-ANUTECH-YR": 948,
  "SSL-POSITIVE-YR": 899, "SSL-WILDCARD-YR": 4499, "SSL-OVEV-YR": 6999,
};
const rowsAt = (over: Record<string, number> = {}) =>
  CORE_SKUS.map((c) => ({
    sku: c.sku, name: c.name, msrp: over[c.sku] ?? SEEDED[c.sku], hsn: c.hsn, term_months: c.termMonths,
    fulfilment: c.fulfilment, engine_ref: c.engineRef, is_public: true,
  }));

const buyer = { fullName: "Test Buyer", email: "buyer@example.invalid", phone: "9999999999", stateCode: "07", simulate: true };

/** What the server charges for these cart lines, as the checkout page sends them. */
async function charged(lines: CartLine[], domain: string): Promise<number> {
  inserts.rows = [];
  const res = await checkout(new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...buyer, domain, lines: lines.map((l) => ({ sku: l.sku, label: l.label, qty: l.qty, cycle: l.cycle })) }),
  }));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return inserts.rows.find((r) => r.table === "quotes")!.row.amount as number;
}

/** What the cart page and checkout show after re-pricing from GET /api/public/catalog. */
async function shown(saved: CartLine[]): Promise<{ total: number; changes: number }> {
  const res = await catalogApi(new NextRequest("https://example.invalid/api/public/catalog"));
  const prices = cartPricesFromCatalog(await res.json());
  const r = prices ? repriceCartLines(saved, prices) : { lines: saved, changes: [] };
  return { total: Math.round(cartTotals(r.lines, 0).payable), changes: r.changes.length };
}

const starter = HOSTING_TIERS.find((t) => t.name === "Starter")!;
/** A cart saved in the browser before the price change: Starter yearly + 3 mailboxes at today's code prices. */
const savedCart = (): CartLine[] => [
  { key: "h1", qty: 1, ...paidHostingLine(starter, true) },
  { key: "m1", label: "Mailbox", detail: "Anutech Mail · billed yearly", unitPrice: MAILBOX_YR, qty: 3, unit: "year", cycle: "yearly", sku: "mailbox:anutech" },
];

beforeEach(() => {
  vi.stubEnv("BUY_PAGE_TENANT_ID", "00000000-0000-4000-8000-000000001797");
  forgetCatalogPricesForTests();
  catalog.rows = rowsAt();
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-1797", error: null } : { data: null, error: null },
  );
  lookupDomains.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("gap 2: flag ON, price changed after the cart was saved — shown total === charged total", () => {
  it("Starter ₹600 → ₹610 and mailbox ₹948 → ₹999: the re-priced cart shows what the server charges", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    catalog.rows = rowsAt({ "HOST-STARTER-YR": 610, "MAIL-ANUTECH-YR": 999 });
    const server = await charged(savedCart(), "acme.in");
    // The bug: the saved lines as they were would show a different total.
    expect(Math.round(cartTotals(savedCart(), 0).payable)).not.toBe(server);
    const s = await shown(savedCart());
    expect(s.total).toBe(server);
    expect(s.total).toBe(Math.round((610 + 2 * 999) * 1.18));
    expect(s.changes).toBe(2);
  });

  it("flag ON at the seeded prices: nothing changes, and the totals agree", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const s = await shown(savedCart());
    expect(s.changes).toBe(0);
    expect(s.total).toBe(await charged(savedCart(), "acme.in"));
  });

  it("flag OFF: the cart is not touched at all (today's behaviour), and the totals agree", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "");
    catalog.rows = rowsAt({ "HOST-STARTER-YR": 610 }); // ignored with the flag off
    const s = await shown(savedCart());
    expect(s.changes).toBe(0);
    expect(s.total).toBe(await charged(savedCart(), "acme.in"));
  });
});

describe("gap 3: the Anutech Mail monthly figure and the /quote estimate read the price book", () => {
  it("flag off → ₹79/mo, the same MAIL_RATES object", () => {
    const book = codePriceBook();
    expect(bookMailboxMonthly(book)).toBe(79);
    expect(bookMailRates(book)).toBe(MAIL_RATES);
    expect(emailFromRate([], bookMailboxMonthly(book))).toBe(emailFromRate([]));
  });

  it("mailbox at ₹1,200/yr → ₹100/mo everywhere the monthly figure is shown", () => {
    const book = buildPriceBook(rowsAt({ "MAIL-ANUTECH-YR": 1200 }));
    expect(bookMailboxMonthly(book)).toBe(100);
    expect(bookMailRates(book)["Anutech Mail"]).toBe(100);
    expect(bookMailRates(book)["Google Workspace"]).toBe(MAIL_RATES["Google Workspace"]);
    expect(emailFromRate([], bookMailboxMonthly(book))).toBe(100);
  });

  it("never ₹0/mo, even for a tiny yearly price", () => {
    expect(bookMailboxMonthly({ mailboxYearly: 5 })).toBeGreaterThan(0);
  });

  it("/quote: Positive SSL and Starter hosting from the book; OV / EV stays price on request", () => {
    const book = buildPriceBook(rowsAt({ "SSL-POSITIVE-YR": 999, "HOST-STARTER-YR": 610 }));
    const p = withPriceBook(QUOTE_PRODUCTS, { tiers: book.tiers, ssl: book.ssl });
    const byName = new Map(p.map((x) => [x.name, x]));
    expect(byName.get("SSL Positive")!.annual).toBe(999);
    expect(byName.get("SSL Wildcard")!.annual).toBe(4499);
    expect(byName.get("SSL OV/EV")!.priceOnRequest).toBe(true);
    expect(Math.round(byName.get("Hosting Starter")!.annual * 12)).toBe(610);
  });

  it("/quote flag off: the code products, unchanged", () => {
    const book = codePriceBook();
    expect(withPriceBook(QUOTE_PRODUCTS, { tiers: book.tiers, ssl: book.ssl })).toEqual(QUOTE_PRODUCTS);
    expect(withPriceBook(QUOTE_PRODUCTS, undefined)).toEqual(QUOTE_PRODUCTS);
  });
});

describe("gap 4: every page that prints price-book prices revalidates every 60 s", () => {
  const ROOT = join(__dirname, "..", "..", "app", "(marketing)");
  it.each(["domains", "rates", "hosting", "ssl", "quote", "email"])("/%s", (page) => {
    const src = readFileSync(join(ROOT, page, "page.tsx"), "utf8");
    expect(src).toMatch(/export const revalidate = 60;/);
  });
});
