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
import { CORE_SKUS } from "@/lib/catalog/catalog-prices";

const get = (q = "") => GET(new NextRequest(`https://example.invalid/api/public/catalog${q}`));

beforeEach(() => {
  book.rows = null;
});

describe("GET /api/public/catalog", () => {
  it("flag off: today's code prices for hosting, mail and SSL, CDN-cached 60 s", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
    const body = await res.json();
    expect(body.gstRate).toBe(18);
    expect(body.items).toHaveLength(10);
    expect(body.items[0]).toEqual({
      sku: "HOST-STARTER-YR", name: "Starter Hosting (Yearly)", function: "hosting", termMonths: 12,
      exGst: 600, inclGst: 708, gstRate: 18, hsn: "998315", fulfilment: "hosting_panel", engineRef: "Starter",
    });
  });

  it("never leaks cost: a catalogue row carrying wholesale/margin does not reach the response", async () => {
    book.rows = CORE_SKUS.map((c) => ({
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
    const bad = await get("?function=support");
    expect(bad.status).toBe(400);
    const err = await bad.json();
    expect(err.error).toMatch(/hosting, mail, ssl/);
    expect(err.error).toMatch(/workspace/);
  });
});
