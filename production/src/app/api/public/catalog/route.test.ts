/**
 * R-1786 — GET /api/public/catalog: read-only, cached, narrow fields, never cost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const book = vi.hoisted(() => ({ rows: null as unknown[] | null }));
vi.mock("@/lib/catalog/catalog-prices.server", async () => {
  const m = await import("@/lib/catalog/catalog-prices");
  return { getPriceBook: async () => m.buildPriceBook(book.rows as never) };
});

import { GET } from "./route";
import { BOOK_SKUS } from "@/lib/catalog/catalog-prices";

const get = (q = "") => GET(new NextRequest(`https://example.invalid/api/public/catalog${q}`));

beforeEach(() => {
  book.rows = null;
});

describe("GET /api/public/catalog", () => {
  it("flag off: today's code prices for hosting, mail, SSL and support, CDN-cached 60 s", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
    const body = await res.json();
    expect(body.gstRate).toBe(18);
    expect(body.items).toHaveLength(14);
    expect(body.items[0]).toEqual({
      sku: "HOST-STARTER-YR", name: "Starter Hosting (Yearly)", function: "hosting", termMonths: 12,
      exGst: 600, inclGst: 708, gstRate: 18, hsn: "998315", fulfilment: "hosting_panel", engineRef: "Starter",
    });
  });

  it("never leaks cost: a catalogue row carrying wholesale/margin does not reach the response", async () => {
    book.rows = BOOK_SKUS.map((c) => ({
      sku: c.sku, name: c.name, msrp: 1000, hsn: c.hsn, term_months: c.termMonths, fulfilment: c.fulfilment,
      engine_ref: c.engineRef, is_public: true, wholesale: 400, margin_pct: 60, cost: 400,
    }));
    const text = await (await get()).text();
    expect(text).not.toMatch(/wholesale|margin|"cost"|partner/i);
    expect(JSON.parse(text).items.every((i: { exGst: number }) => i.exGst === 1000)).toBe(true);
  });

  it("?function=hosting filters; an unknown function is a 400 that says what to use", async () => {
    const body = await (await get("?function=hosting")).json();
    expect(body.items.every((i: { function: string }) => i.function === "hosting")).toBe(true);
    const bad = await get("?function=workspace");
    expect(bad.status).toBe(400);
    const err = await bad.json();
    expect(err.error).toMatch(/hosting, mail, ssl, support/);
    expect(err.error).toMatch(/workspace/);
  });
});

/* R-2083: DSP reads the support plans from here ("Upgrade" shows them, then sends the buyer to
   /buy/support). Before this card ?function=support was a 400. */
describe("GET /api/public/catalog?function=support (R-2083)", () => {
  it("flag off: the four paid plans at the SUPPORT_TIERS prices — Free is not sold", async () => {
    const res = await get("?function=support");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([
      { sku: "SUP-STANDARD-MO", name: "Support Standard (Monthly)", function: "support", termMonths: 1, exGst: 999, inclGst: 1179, gstRate: 18, hsn: "998313", fulfilment: "support_panel", engineRef: null },
      { sku: "SUP-STANDARD-YR", name: "Support Standard (Yearly)", function: "support", termMonths: 12, exGst: 9996, inclGst: 11795, gstRate: 18, hsn: "998313", fulfilment: "support_panel", engineRef: null },
      { sku: "SUP-ENTERPRISE-MO", name: "Support Enterprise (Monthly)", function: "support", termMonths: 1, exGst: 4999, inclGst: 5899, gstRate: 18, hsn: "998313", fulfilment: "support_panel", engineRef: null },
      { sku: "SUP-ENTERPRISE-YR", name: "Support Enterprise (Yearly)", function: "support", termMonths: 12, exGst: 49992, inclGst: 58991, gstRate: 18, hsn: "998313", fulfilment: "support_panel", engineRef: null },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/SUP-FREE/);
  });

  it("flag on: a yearly row's price is its prices.annual_total (msrp 0), an edited monthly row wins; is_public=false (Aug seed) does not hide a paid plan", async () => {
    book.rows = [
      { sku: "SUP-STANDARD-MO", name: "Acme Standard Support", msrp: 1099, hsn: "998313", term_months: 1, fulfilment: "support_panel", engine_ref: null, is_public: false },
      { sku: "SUP-STANDARD-YR", name: "Acme Standard Support (Yearly)", msrp: 0, annual_total_msrp: "10992", hsn: "998313", term_months: 12, fulfilment: "support_panel", engine_ref: null, is_public: false },
    ];
    const body = await (await get("?function=support")).json();
    const by = Object.fromEntries(body.items.map((i: { sku: string }) => [i.sku, i]));
    expect(by["SUP-STANDARD-MO"]).toMatchObject({ exGst: 1099, inclGst: 1297, name: "Acme Standard Support" });
    expect(by["SUP-STANDARD-YR"]).toMatchObject({ exGst: 10992, inclGst: 12971 });
    // no row → the code price, never ₹0
    expect(by["SUP-ENTERPRISE-YR"]).toMatchObject({ exGst: 49992 });
  });
});
