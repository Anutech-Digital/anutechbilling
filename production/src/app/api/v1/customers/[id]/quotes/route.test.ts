/**
 * GET /api/v1/customers/{id}/quotes — `renews` (28 Sep 2026): each quote names the services
 * whose subscription it renews, so DMS can offer a renewal bill only on that service's Renew.
 * Pinned: the lookup is tenant-scoped; a quote renewing nothing says []; a failed lookup fails
 * the whole answer (500), never a list that silently says "renews nothing".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  quotes: [] as Record<string, unknown>[],
  subs: [] as Record<string, unknown>[],
  subsError: null as { message: string } | null,
  filters: [] as { table: string; op: string; col: string; val: unknown }[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const result = () => (table === "quotes" ? { data: db.quotes, error: null } : { data: db.subs, error: db.subsError });
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { db.filters.push({ table, op: "eq", col, val }); return chain; },
        in: (col: string, val: unknown) => { db.filters.push({ table, op: "in", col, val }); return chain; },
        order: () => chain,
        then: (ok: (v: unknown) => unknown) => ok(result()),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/api-keys/auth", () => ({ authenticateApiKey: async () => ({ tenantId: "tenant-1", keyId: "key-1", scopes: ["read"] }) }));
vi.mock("@/lib/api/v1-customer", () => ({ resolveCustomer: async () => ({ id: "cust-1" }) }));
vi.mock("@/lib/pdf/pdf-token", () => ({ pdfDownloadUrl: () => "https://x.invalid/pdf" }));

import { GET } from "./route";

const call = () =>
  GET(new NextRequest("https://ros.invalid/api/v1/customers/C-1/quotes"), { params: Promise.resolve({ id: "C-1" }) });
const quote = (id: string) => ({ id, amount: 708, status: "sent", pdf_url: null, public_token: "t" });

beforeEach(() => {
  db.quotes = [quote("Q-RENEW"), quote("Q-NEW")];
  db.subs = [{ renewal_quote_id: "Q-RENEW", vendor: "hosting", domain: "acme.in" }];
  db.subsError = null;
  db.filters = [];
});

describe("renews", () => {
  it("names what each quote renews, [] for one that renews nothing", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; renews: unknown }[];
    expect(body.find((q) => q.id === "Q-RENEW")?.renews).toEqual([{ vendor: "hosting", domain: "acme.in" }]);
    expect(body.find((q) => q.id === "Q-NEW")?.renews).toEqual([]);
  });
  it("looks subscriptions up in the key's tenant, for these quotes only", async () => {
    await call();
    expect(db.filters).toContainEqual({ table: "subscriptions", op: "eq", col: "tenant_id", val: "tenant-1" });
    expect(db.filters).toContainEqual({ table: "subscriptions", op: "in", col: "renewal_quote_id", val: ["Q-RENEW", "Q-NEW"] });
  });
  it("a failed lookup fails the answer (500) instead of saying renews nothing", async () => {
    db.subsError = { message: "timeout" };
    expect((await call()).status).toBe(500);
  });
});
