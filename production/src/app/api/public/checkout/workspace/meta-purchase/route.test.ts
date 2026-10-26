/**
 * R-1979: the thanks page asks for Meta's server Purchase. Sent only for the website tenant's
 * PAID quote with the matching secret token and the buyer's consent; the answer never reveals
 * anything about an order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ quote: null as Record<string, unknown> | null, filters: [] as unknown[][], meta: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) c[m] = (...a: unknown[]) => { db.filters.push([m, ...a]); return c; };
      c.maybeSingle = async () => ({ data: db.quote, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/website-tenant", () => ({ websiteTenantId: () => "T-WEB" }));
vi.mock("@/lib/meta/capi.server", () => ({ reportPurchaseToMeta: async (_a: unknown, input: unknown) => { db.meta.push(input); return { sent: true }; } }));

import { POST } from "./route";

const TOKEN = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";
const post = (body: unknown) => POST(new NextRequest("https://x.invalid/api/public/checkout/workspace/meta-purchase", { method: "POST", body: JSON.stringify(body), headers: { "user-agent": "UA", "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }));

beforeEach(() => { db.quote = { id: "Q-ADPL-27-0001", public_token: TOKEN, payment_status: "received" }; db.filters = []; db.meta = []; });

describe("R-1979 meta-purchase", () => {
  it("paid quote + right token + consent → Purchase for that quote, the website tenant only", async () => {
    const res = await post({ quoteId: "Q-ADPL-27-0001", t: TOKEN, consent: true, fbp: "fb.1.1.2", pageUrl: "https://example.in/buy/workspace/thanks" });
    expect(await res.json()).toEqual({ ok: true });
    expect(db.meta).toEqual([{ quoteId: "Q-ADPL-27-0001", tenantId: "T-WEB", consent: true, fbp: "fb.1.1.2", sourceUrl: "https://example.in/buy/workspace/thanks", clientIp: "1.2.3.4", userAgent: "UA" }]);
    expect(db.filters).toEqual(expect.arrayContaining([["eq", "tenant_id", "T-WEB"], ["in", "payment_status", ["received", "invoiced"]]]));
  });

  it("wrong token → nothing sent, same answer", async () => {
    const res = await post({ quoteId: "Q-ADPL-27-0001", t: "wrong-token-123", consent: true });
    expect(await res.json()).toEqual({ ok: true });
    expect(db.meta).toEqual([]);
  });

  it("not paid (no row) → nothing sent", async () => {
    db.quote = null;
    await post({ quoteId: "Q-ADPL-27-0001", t: TOKEN, consent: true });
    expect(db.meta).toEqual([]);
  });

  it("no consent → nothing sent, not even a lookup", async () => {
    await post({ quoteId: "Q-ADPL-27-0001", t: TOKEN, consent: false });
    expect(db.meta).toEqual([]);
    expect(db.filters).toEqual([]);
  });

  it("a malformed request → 400", async () => {
    expect((await post({ quoteId: "drop table", t: TOKEN, consent: true })).status).toBe(400);
  });
});
