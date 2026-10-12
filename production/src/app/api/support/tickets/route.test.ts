/**
 * R-880: PATCH /api/support/tickets changes a ticket's status / resolution note. Owner,
 * manager, support — or the agent the ticket is assigned to. Another tenant's ticket is
 * "not found"; an unknown status is refused; nothing but status / note / resolved_at is written.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, TENANT_B, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
  createAdminClientFor: () => fakeServerModule(h.db).createAdminClientFor(),
}));
vi.mock("@/lib/platform", () => ({ isPlatformAdmin: () => false }));

import { PATCH } from "./route";

const call = (body: Record<string, unknown>) =>
  PATCH(new Request("http://x/api/support/tickets", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  h.db = newFakeDb();
  h.db.tables.support_tickets = [
    { id: "t-1", tenant_id: TENANT_A, status: "open", assigned_agent: null },
    { id: "t-2", tenant_id: TENANT_A, status: "open", assigned_agent: "u-delivery" },
    { id: "t-B", tenant_id: TENANT_B, status: "open", assigned_agent: null },
  ];
});

const updates = () => h.db.writes.filter(([, t, op]) => t === "support_tickets" && op === "update");

describe("support ticket PATCH roles (R-880)", () => {
  for (const role of ["sales", "sales_senior", "billing", "delivery", "accountant", "partner_agent"]) {
    it(`${role} (not assigned) → 403, ticket unchanged`, async () => {
      signInAs(h.db, role);
      const res = await call({ id: "t-1", status: "closed" });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^Only Owner, Manager, Support or the person this ticket is assigned to/);
      expect(updates()).toHaveLength(0);
      expect(h.db.tables.support_tickets[0].status).toBe("open");
    });
  }
  for (const role of ["owner", "manager", "support"]) {
    it(`${role} → 200, status written in its own tenant`, async () => {
      signInAs(h.db, role);
      const res = await call({ id: "t-1", status: "resolved", resolution_note: "fixed" });
      expect(res.status).toBe(200);
      expect(h.db.tables.support_tickets[0]).toMatchObject({ status: "resolved", resolution_note: "fixed" });
      const [, , , w] = updates()[0];
      expect(Object.keys((w as { payload: object }).payload).sort()).toEqual(["resolution_note", "resolved_at", "status"]);
    });
  }
  it("the assigned agent may update its own ticket even without a support role", async () => {
    signInAs(h.db, "delivery");
    const res = await call({ id: "t-2", status: "in_progress" });
    expect(res.status).toBe(200);
    expect(h.db.tables.support_tickets[1].status).toBe("in_progress");
  });
  it("another tenant's ticket → 404, unchanged", async () => {
    signInAs(h.db, "owner");
    const res = await call({ id: "t-B", status: "closed" });
    expect(res.status).toBe(404);
    expect(updates()).toHaveLength(0);
    expect(h.db.tables.support_tickets[2].status).toBe("open");
  });
  it("unknown status → 400", async () => {
    signInAs(h.db, "owner");
    const res = await call({ id: "t-1", status: "deleted" });
    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
  it("signed out → 401", async () => {
    expect((await call({ id: "t-1", status: "closed" })).status).toBe(401);
  });
});
