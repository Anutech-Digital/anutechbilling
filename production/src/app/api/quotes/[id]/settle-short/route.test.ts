/**
 * R-2606: POST /api/quotes/:id/settle-short — owner / accountant only at the route, then ONE call
 * to R-2595's settle_quote_part_short; its plain refusals reach the page as they are.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));

import { POST } from "./route";

const call = (body: unknown = {}) => POST(
  new Request("http://x/api/quotes/Q-9/settle-short", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "Q-9" }) },
);

beforeEach(() => { h.db = newFakeDb(); });

describe("settle-short (R-2606)", () => {
  it("signed out → 401, nothing called", async () => {
    expect((await call()).status).toBe(401);
    expect(h.db.rpcCalls).toEqual([]);
  });

  it.each(["sales", "billing", "manager", "support"])("%s → 403, nothing called", async (role) => {
    signInAs(h.db, role);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner or the accountant/);
    expect(h.db.rpcCalls).toEqual([]);
  });

  it.each(["owner", "accountant"])("%s → one call to settle_quote_part_short", async (role) => {
    signInAs(h.db, role);
    h.db.rpcResult = { data: { quote_id: "Q-9", invoice_id: "INV-1", amount: 60 }, error: null };
    const res = await call({ reason: "  NEFT came ₹60 short  " });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(60);
    expect(h.db.rpcCalls).toEqual([["settle_quote_part_short", { p_quote_id: "Q-9", p_reason: "NEFT came ₹60 short" }]]);
  });

  it("no body → reason null", async () => {
    signInAs(h.db, "owner");
    h.db.rpcResult = { data: { amount: 60 }, error: null };
    await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "Q-9" }) });
    expect(h.db.rpcCalls).toEqual([["settle_quote_part_short", { p_quote_id: "Q-9", p_reason: null }]]);
  });

  it("the RPC's refusal is shown as it is (400)", async () => {
    signInAs(h.db, "owner");
    const m = "Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹60 difference.";
    h.db.rpcResult = { data: null, error: { code: "22023", message: m } };
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(m);
  });

  it("an unknown database error is not shown raw", async () => {
    signInAs(h.db, "owner");
    h.db.rpcResult = { data: null, error: { code: "XX000", message: "relation bank_receipt_round_offs does not exist" } };
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/relation/);
  });
});
