/**
 * R-1526 — the public signed statement link (what the WhatsApp text carries). The token binds
 * (statement, customer, tenant) and expires; anything else → 403 and nothing is rendered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.stubEnv("PDF_SIGNING_SECRET", "test-only-signing-secret-r1526");

const CUST = "33333333-3333-4333-8333-333333333333";
const OTHER = "55555555-5555-4555-8555-555555555555";

const st = vi.hoisted(() => ({ renders: [] as Array<{ customerId: string; tenantId: string }> }));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => {
      let id = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (_c: string, v: string) => { id = v; return q; };
      q.maybeSingle = async () => ({ data: id === CUST || id === OTHER ? { id, tenant_id: "T1" } : null, error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/collections/pending-dues.server", () => ({
  pendingDuesPdfFor: async (_db: unknown, o: { customerId: string; tenantId: string; today: string }) => {
    st.renders.push(o);
    return { pdf: Buffer.from("%PDF"), statement: { customerName: "Acme", asOn: o.today }, raw: {} };
  },
}));

import { GET } from "./route";
import { signPdfToken } from "@/lib/pdf/pdf-token";

const call = (id: string, token: string) =>
  GET(new NextRequest(`https://app.example/api/v1/documents/statement/${id}/pdf?token=${token}`), { params: Promise.resolve({ id }) });

beforeEach(() => { st.renders = []; });

describe("GET /api/v1/documents/statement/{id}/pdf", () => {
  it("a valid statement token → the PDF, rendered for that customer's own company", async () => {
    const res = await call(CUST, signPdfToken("statement", CUST, "T1", { ttlDays: 7 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(st.renders).toEqual([expect.objectContaining({ customerId: CUST, tenantId: "T1" })]);
  });

  it("no token, a token for another customer, another company, or an invoice token → 403, nothing rendered", async () => {
    expect((await call(CUST, "")).status).toBe(403);
    expect((await call(CUST, signPdfToken("statement", OTHER, "T1"))).status).toBe(403);
    expect((await call(CUST, signPdfToken("statement", CUST, "T2"))).status).toBe(403);
    expect((await call(CUST, signPdfToken("invoice", CUST, "T1"))).status).toBe(403);
    expect(st.renders).toHaveLength(0);
  });

  it("an expired token → 403", async () => {
    const old = signPdfToken("statement", CUST, "T1", { ttlDays: 1, now: new Date(Date.now() - 3 * 86_400_000) });
    expect((await call(CUST, old)).status).toBe(403);
  });
});
