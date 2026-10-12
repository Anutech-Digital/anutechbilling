/**
 * R-880: POST /api/quotes/:id/mark-accepted. accept_quote makes no invoice, payment or
 * subscription — it is a sales action, so sales and sales_senior keep it. Support, delivery,
 * partner agents and accountants are refused before the RPC runs. The tenant match is
 * accept_quote's own; the route passes its refusal through (not a 200).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));

import { POST } from "./route";

const call = () => POST(new Request("http://x/api/quotes/Q-1/mark-accepted", { method: "POST" }), { params: Promise.resolve({ id: "Q-1" }) });

beforeEach(() => {
  h.db = newFakeDb();
  h.db.rpcResult = {
    data: { quote_id: "Q-1", customer_id: "c-1", converted_now: false, quote_status: "accepted", awaits_payment: true },
    error: null,
  };
});

describe("mark-accepted roles (R-880)", () => {
  for (const role of ["support", "delivery", "partner_agent", "accountant"]) {
    it(`${role} → 403, accept_quote not called`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/can mark a quote accepted/);
      expect(h.db.rpcCalls).toHaveLength(0);
    });
  }
  for (const role of ["owner", "manager", "sales_senior", "sales", "billing"]) {
    it(`${role} → 200`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(200);
      expect(h.db.rpcCalls).toEqual([["accept_quote", { p_quote_id: "Q-1" }]]);
    });
  }
  it("another tenant's quote: accept_quote refuses → not 200", async () => {
    signInAs(h.db, "sales");
    h.db.rpcResult = { data: null, error: { code: "P0001", message: "quote Q-1 does not belong to your tenant" } };
    const res = await call();
    expect(res.status).toBe(400);
  });
  it("signed out → 401", async () => {
    expect((await call()).status).toBe(401);
  });
});
