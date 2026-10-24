/**
 * R-1786 — getPriceBook: no read with the flag off; with it on a narrow, cached read of the
 * website company's SKU rows; a failed read never blocks a sale (last good, else code).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({
  calls: [] as { table: string; columns: string; filters: [string, unknown][] }[],
  result: { data: [] as unknown[] | null, error: null as { message: string } | null },
  throws: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        const call = { table, columns, filters: [] as [string, unknown][] };
        db.calls.push(call);
        const chain = {
          eq: (c: string, v: unknown) => { call.filters.push([c, v]); return chain; },
          in: (c: string, v: unknown) => {
            call.filters.push([c, v]);
            return db.throws ? Promise.reject(new Error("connect timeout")) : Promise.resolve(db.result);
          },
        };
        return chain;
      },
    }),
  }),
}));

import { CATALOG_TTL_MS, forgetCatalogPricesForTests, getPriceBook } from "./catalog-prices.server";
import { CORE_SKUS } from "./catalog-prices";
import { hostingPriceTable } from "@/lib/checkout/hosting-prices";

const T = "5b0c7a3e-4d2f-4e61-9a8b-2c1d0e9f7a64";
const row = (sku: string, msrp: number) => ({ sku, name: sku, msrp, hsn: "998315", term_months: 12, fulfilment: "hosting_panel", engine_ref: null, is_public: true });

beforeEach(() => {
  forgetCatalogPricesForTests();
  db.calls = [];
  db.result = { data: [row("HOST-STARTER-YR", 610)], error: null };
  db.throws = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getPriceBook", () => {
  it("flag off: code prices and NO database read", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "");
    const book = await getPriceBook(T);
    expect(book.source).toBe("code");
    expect(hostingPriceTable(book.tiers)).toEqual(hostingPriceTable());
    expect(db.calls).toHaveLength(0);
  });

  it("flag on: reads only this company's active SKU rows, narrow columns, never wholesale", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const book = await getPriceBook(T);
    expect(book.source).toBe("catalog");
    expect(hostingPriceTable(book.tiers)[0].yearly.exGst).toBe(610);
    expect(db.calls).toHaveLength(1);
    const c = db.calls[0];
    expect(c.table).toBe("items");
    expect(c.columns).not.toMatch(/wholesale|margin|partner_price|\*/);
    expect(c.filters).toContainEqual(["tenant_id", T]);
    expect(c.filters).toContainEqual(["is_active", true]);
    expect(c.filters).toContainEqual(["sku", CORE_SKUS.map((s) => s.sku)]);
  });

  it("flag on: the 9 SKUs with no row keep their code price and are logged once", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const book = await getPriceBook(T);
    expect(book.fallbacks).toHaveLength(9);
    expect(hostingPriceTable(book.tiers)[1].yearly.exGst).toBe(1500);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toMatch(/HOST-STARTER-MO.*code price/);
  });

  it("cached 60 s per company: a second call in the minute does not read again", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const t0 = 1_000_000;
    await getPriceBook(T, t0);
    await getPriceBook(T, t0 + CATALOG_TTL_MS - 1);
    expect(db.calls).toHaveLength(1);
    db.result = { data: [row("HOST-STARTER-YR", 620)], error: null };
    const later = await getPriceBook(T, t0 + CATALOG_TTL_MS + 1);
    expect(db.calls).toHaveLength(2);
    expect(hostingPriceTable(later.tiers)[0].yearly.exGst).toBe(620);
  });

  it("read fails after a good read: the last good prices, logged", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    await getPriceBook(T, 0);
    db.throws = true;
    const book = await getPriceBook(T, CATALOG_TTL_MS + 5);
    expect(hostingPriceTable(book.tiers)[0].yearly.exGst).toBe(610);
    expect(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])).toMatch(/read failed.*min ago/);
  });

  it("read fails with nothing remembered, or a database error: the code prices, logged", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    db.throws = true;
    const a = await getPriceBook(T);
    expect(a.source).toBe("code");
    expect(hostingPriceTable(a.tiers)).toEqual(hostingPriceTable());
    forgetCatalogPricesForTests();
    db.throws = false;
    db.result = { data: null, error: { message: "permission denied" } };
    const b = await getPriceBook(T);
    expect(b.source).toBe("code");
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("flag on but no website company: the code prices, no read", async () => {
    vi.stubEnv("CATALOG_FROM_DB", "1");
    const book = await getPriceBook(null);
    expect(book.source).toBe("code");
    expect(db.calls).toHaveLength(0);
  });
});
