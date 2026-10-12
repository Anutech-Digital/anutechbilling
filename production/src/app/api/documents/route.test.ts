/**
 * R-880: POST /api/documents uploads into the document vault through the admin client.
 * R-724's storage rule for the vault folder is owner + manager — the route now says the same,
 * so nobody else can write the vault past the bucket policy. The file always lands in the
 * caller's own tenant folder.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
  createAdminClientFor: () => fakeServerModule(h.db).createAdminClientFor(),
}));

import { POST } from "./route";

function call() {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1])], "gst cert.pdf", { type: "application/pdf" }));
  fd.append("title", "GST certificate");
  fd.append("category", "legal");
  return POST(new NextRequest("http://x/api/documents", { method: "POST", body: fd }));
}

beforeEach(() => { h.db = newFakeDb(); });

const adminWrites = () => h.db.writes.filter(([who]) => who === "admin");

describe("document vault upload roles (R-880)", () => {
  for (const role of ["sales", "sales_senior", "support", "delivery", "partner_agent", "billing", "accountant"]) {
    it(`${role} → 403, nothing written`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Only Owner, Manager can upload to the document vault. Ask one of them to do it.");
      expect(adminWrites()).toHaveLength(0);
    });
  }
  for (const role of ["owner", "manager"]) {
    it(`${role} → 200, stored in its own tenant folder`, async () => {
      signInAs(h.db, role);
      const res = await call();
      expect(res.status).toBe(200);
      const [upload, insert] = adminWrites();
      expect(upload[2]).toBe("upload");
      expect(String(upload[3]).startsWith(`${TENANT_A}/`)).toBe(true);
      expect(insert[1]).toBe("documents");
      expect((insert[3] as { payload: { tenant_id: string } }).payload.tenant_id).toBe(TENANT_A);
    });
  }
  it("signed out → 401", async () => {
    expect((await call()).status).toBe(401);
  });
});
