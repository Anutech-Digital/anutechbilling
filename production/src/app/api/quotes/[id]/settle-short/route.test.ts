/**
 * R-2606: /api/quotes/:id/settle-short — owner / accountant only at the route; POST books only the
 * amount the owner confirmed (409 otherwise), then ONE call to R-2595's settle_quote_part_short;
 * its plain refusals reach the page as they are.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  preview: null as null | { amount: number; invoiceId: string; bankLine: { credit: number; txnDate: string } | null },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));
vi.mock("@/lib/quotes/settle-small-short", async (orig) => ({
  ...(await orig<typeof import("@/lib/quotes/settle-small-short")>()),
  settleShortPreview: async () => h.preview,
}));

import { GET, POST } from "./route";

const ctx = { params: Promise.resolve({ id: "Q-9" }) };
const call = (body: unknown = { expected: 60 }) => POST(
  new Request("http://x/api/quotes/Q-9/settle-short", { method: "POST", body: JSON.stringify(body) }), ctx,
);

beforeEach(() => {
  h.db = newFakeDb();
  h.preview = { amount: 60, invoiceId: "INV-1", bankLine: { credit: 95933, txnDate: "2026-11-03" } };
});

describe("settle-short POST (R-2606)", () => {
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
    const res = await call({ expected: 60, reason: "  NEFT came ₹60 short  " });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(60);
    expect(h.db.rpcCalls).toEqual([["settle_quote_part_short", { p_quote_id: "Q-9", p_reason: "NEFT came ₹60 short" }]]);
  });

  it("no expected amount → 400, nothing booked", async () => {
    signInAs(h.db, "owner");
    expect((await call({})).status).toBe(400);
    expect(h.db.rpcCalls).toEqual([]);
  });

  it("the part's difference changed since the page loaded → 409, nothing booked", async () => {
    signInAs(h.db, "owner");
    h.preview = { amount: 61, invoiceId: "INV-1", bankLine: null };
    const res = await call({ expected: 60 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/now ₹61, not ₹60/);
    expect(h.db.rpcCalls).toEqual([]);
  });

  it("nothing open to settle → the RPC answers in its own words", async () => {
    signInAs(h.db, "owner");
    h.preview = null;
    const m = "Quote Q-9 has no part left with a difference — nothing to settle. Refresh the page.";
    h.db.rpcResult = { data: null, error: { code: "22023", message: m } };
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(m);
  });

  it("the RPC's refusal is shown as it is (400)", async () => {
    signInAs(h.db, "owner");
    const m = "Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹60 difference.";
    h.db.rpcResult = { data: null, error: { code: "22023", message: m } };
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(m);
  });

  it("an unknown database error is not shown raw (and is logged)", async () => {
    signInAs(h.db, "owner");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.db.rpcResult = { data: null, error: { code: "XX000", message: "relation bank_receipt_round_offs does not exist" } };
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/relation/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("settle-short GET (R-2606)", () => {
  it("sales → 403", async () => {
    signInAs(h.db, "sales");
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
  });
  it("owner → the preview", async () => {
    signInAs(h.db, "owner");
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).preview).toEqual({ amount: 60, invoiceId: "INV-1", bankLine: { credit: 95933, txnDate: "2026-11-03" } });
  });
});
