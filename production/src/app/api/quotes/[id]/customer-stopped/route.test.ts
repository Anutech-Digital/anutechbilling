/**
 * R-2044 "Customer stopped": money roles only at the route (the RPC narrows further); a bad body
 * is refused before the database is asked; a good one makes ONE call, stop_part_payment_request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));

import { POST } from "./route";

const call = (body: unknown) => POST(
  new Request("http://x/api/quotes/Q-9/customer-stopped", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "Q-9" }) },
);

beforeEach(() => { h.db = newFakeDb(); });

describe("customer-stopped (R-2044)", () => {
  it("sales → 403, nothing called", async () => {
    signInAs(h.db, "sales");
    expect((await call({ end: "cancel", reason: "Moved to another provider" })).status).toBe(403);
    expect(h.db.rpcCalls).toEqual([]);
  });
  it("no reason → 400, nothing called", async () => {
    signInAs(h.db, "owner");
    expect((await call({ end: "cancel", reason: "" })).status).toBe(400);
    expect(h.db.rpcCalls).toEqual([]);
  });
  it("owner → one call to stop_part_payment_request", async () => {
    signInAs(h.db, "owner");
    h.db.rpcResult = { data: { quote_id: "Q-9", subscription_status: "cancelled" }, error: null };
    const res = await call({ end: "cancel", reason: "Moved to another provider" });
    expect(res.status).toBe(200);
    expect(h.db.rpcCalls).toEqual([["stop_part_payment_request", { p_quote_id: "Q-9", p_end: "cancel", p_reason: "Moved to another provider" }]]);
  });
  it("signed out → 401", async () => {
    expect((await call({ end: "pause", reason: "Stopped paying" })).status).toBe(401);
  });
});
