/**
 * R-880: POST /api/quotes/:id/raise-instalments raises a tax invoice through the admin client.
 * Money roles only (R-718: owner, manager, accountant, billing); another tenant's quote is
 * "not found"; a refused caller causes no admin read and no instalment run.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, TENANT_B, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, raised: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
  createAdminClientFor: () => fakeServerModule(h.db).createAdminClientFor(),
}));
vi.mock("@/lib/billing/sync-instalments.server", () => ({
  raiseDueInstalmentsForQuote: async (args: unknown) => { h.raised.push(args); return { splitBilled: true, raised: 1 }; },
}));

import { POST } from "./route";

const call = (id = "Q-1") => POST(new Request("http://x/api/quotes/Q-1/raise-instalments", { method: "POST" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.db = newFakeDb();
  h.raised = [];
  h.db.tables.quotes = [{ id: "Q-1", tenant_id: TENANT_A }, { id: "Q-B", tenant_id: TENANT_B }];
});

describe("raise-instalments roles (R-880)", () => {
  for (const role of ["sales", "sales_senior", "support", "delivery", "partner_agent"]) {
    it(`${role} → 403, nothing raised`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^Only Owner, Manager, Accountant, Billing can/);
      expect(h.raised).toHaveLength(0);
    });
  }
  for (const role of ["owner", "manager", "accountant", "billing"]) {
    it(`${role} → 200, instalments raised for its own tenant`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(200);
      expect(h.raised).toEqual([expect.objectContaining({ quoteId: "Q-1", tenantId: TENANT_A })]);
    });
  }
  it("another tenant's quote → 404, nothing raised", async () => {
    signInAs(h.db, "owner");
    const res = await call("Q-B");
    expect(res.status).toBe(404);
    expect(h.raised).toHaveLength(0);
  });
  it("signed out → 401", async () => {
    expect((await call()).status).toBe(401);
  });
});
