/**
 * R-880: POST /api/payments/:id/receipt writes the proof file with the admin client (upsert).
 * Money roles only (R-718: owner, manager, accountant, billing). Another tenant's payment is
 * "not found" and nothing is uploaded or linked — the check runs before any admin write.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, TENANT_B, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
  createAdminClientFor: () => fakeServerModule(h.db).createAdminClientFor(),
}));

import { POST } from "./route";

function call(id = "p-1") {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" }));
  const req = new NextRequest(`http://x/api/payments/${id}/receipt`, { method: "POST", body: fd });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  h.db = newFakeDb();
  h.db.tables.payments = [{ id: "p-1", tenant_id: TENANT_A }, { id: "p-B", tenant_id: TENANT_B, receipt_file_path: "B/payments/orig.pdf" }];
});

const adminWrites = () => h.db.writes.filter(([who]) => who === "admin");

describe("payment receipt roles (R-880)", () => {
  for (const role of ["sales", "sales_senior", "support", "delivery", "partner_agent"]) {
    it(`${role} → 403, no upload, no link`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^Only Owner, Manager, Accountant, Billing can record money/);
      expect(adminWrites()).toHaveLength(0);
    });
  }
  for (const role of ["owner", "manager", "accountant", "billing"]) {
    it(`${role} → 200, file stored under its own tenant`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(200);
      expect((await res.json()).path).toBe(`${TENANT_A}/payments/p-1-proof.png`);
      expect(adminWrites().map(([, t, op]) => `${t}:${op}`)).toEqual(["documents:upload", "payments:update"]);
    });
  }
  it("another tenant's payment → 404, its receipt is not overwritten", async () => {
    signInAs(h.db, "owner");
    const res = await call("p-B");
    expect(res.status).toBe(404);
    expect(adminWrites()).toHaveLength(0);
    expect(h.db.tables.payments[1].receipt_file_path).toBe("B/payments/orig.pdf");
  });
  it("signed out → 401", async () => {
    expect((await call()).status).toBe(401);
  });
});
