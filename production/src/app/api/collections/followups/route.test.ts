/**
 * R-1517 — POST /api/collections/followups: the server half of "only owner / manager /
 * accountant may hand a follow-up to someone else" (R-1517 mustDo; the DB does not stop it),
 * and the insert shape (tenant from the server, no created_by from anyone).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const CUST = "33333333-3333-4333-8333-333333333333";

const db = vi.hoisted(() => ({
  role: "sales" as string,
  customer: null as Record<string, unknown> | null,
  latest: null as Record<string, unknown> | null,
  insertError: null as { code: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.insert = (row: Record<string, unknown>) => { inserted = row; db.inserts.push(row); return q; };
    const one = async () => {
      if (table === "users") return { data: { tenant_id: "T1", role: db.role }, error: null };
      if (table === "customers") return { data: db.customer, error: null };
      if (table === "payment_followups") {
        if (inserted) return db.insertError ? { data: null, error: db.insertError } : { data: { id: "F1", assigned_to: inserted.assigned_to }, error: null };
        return { data: db.latest, error: null };
      }
      return { data: null, error: null };
    };
    q.single = one;
    q.maybeSingle = one;
    return q;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.invalid" } } }) },
      from: chain,
    }),
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";
import { REASSIGN_REFUSED } from "@/lib/collections/followup-rules";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/collections/followups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const base = { customerId: CUST, kind: "call", note: "Rang kiya", nextFollowUpOn: "2026-10-20" };

beforeEach(() => {
  db.role = "sales";
  db.customer = { id: CUST, account_manager_id: OWNER };
  db.latest = null;
  db.insertError = null;
  db.inserts = [];
});

describe("reassign guard (server)", () => {
  it.each(["sales", "sales_senior", "billing"])("%s giving it to someone else → 403 with whom to ask, nothing written", async (role) => {
    db.role = role;
    const res = await call({ ...base, assignedTo: OTHER });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: REASSIGN_REFUSED });
    expect(db.inserts).toEqual([]);
  });

  it.each(["support", "delivery", "partner_agent"])("%s cannot open Payment Follow-up → 403 before any read", async (role) => {
    db.role = role;
    const res = await call(base);
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  /* R-1528: a senior seller opens Payment Follow-up like a seller (nav: sales_senior sees what
     sales sees) and logs follow-ups — but, like sales, only to the person it is with now. */
  it("sales_senior can log a follow-up (opens /collections) → saved to the customer's owner", async () => {
    db.role = "sales_senior";
    const res = await call(base);
    expect(res.status).toBe(200);
    expect(db.inserts[0].assigned_to).toBe(OWNER);
  });

  it("sales without a pick → saved to the customer's owner", async () => {
    const res = await call(base);
    expect(res.status).toBe(200);
    expect(db.inserts[0].assigned_to).toBe(OWNER);
  });

  it("sales keeps it with whoever has it now (an earlier reassignment is not undone)", async () => {
    db.latest = { assigned_to: OTHER };
    const res = await call({ ...base, assignedTo: OTHER });
    expect(res.status).toBe(200);
    expect(db.inserts[0].assigned_to).toBe(OTHER);
  });

  it.each(["owner", "manager", "accountant"])("%s may give it to someone else", async (role) => {
    db.role = role;
    const res = await call({ ...base, assignedTo: OTHER });
    expect(res.status).toBe(200);
    expect(db.inserts[0].assigned_to).toBe(OTHER);
  });

  it("no owner and nobody picked → me", async () => {
    db.customer = { id: CUST, account_manager_id: null };
    await call(base);
    expect(db.inserts[0].assigned_to).toBe(ME);
  });
});

describe("insert shape", () => {
  it("tenant from the server, created_by never written (DB default auth.uid())", async () => {
    db.role = "owner";
    await call({ ...base, kind: "promise", promisedAmount: 5000, promisedOn: "2026-10-25", invoiceId: "INV-A378", quoteId: "Q-1" });
    expect(db.inserts[0]).toEqual({
      tenant_id: "T1", customer_id: CUST, kind: "promise", note: "Rang kiya", promised_amount: 5000, promised_on: "2026-10-25",
      next_follow_up_on: "2026-10-20", assigned_to: OWNER, invoice_id: "INV-A378", quote_id: "Q-1", subscription_id: null,
    });
  });

  it("a body that tries to set created_by or tenant_id is refused (400), nothing written", async () => {
    db.role = "owner";
    for (const extra of [{ created_by: OTHER }, { tenant_id: "T2" }]) {
      const res = await call({ ...base, ...extra });
      expect(res.status).toBe(400);
    }
    expect(db.inserts).toEqual([]);
  });

  it("no next follow-up date, or a promise with no date → 400 with the fix", async () => {
    db.role = "owner";
    const a = await call({ ...base, nextFollowUpOn: undefined });
    expect(a.status).toBe(400);
    expect((await a.json()).error).toMatch(/next follow-up date/);
    const b = await call({ ...base, kind: "promise" });
    expect(b.status).toBe(400);
    expect((await b.json()).error).toMatch(/promise to pay needs a date/i);
    expect(db.inserts).toEqual([]);
  });

  it("a customer RLS hides → 404 with a next step", async () => {
    db.role = "owner";
    db.customer = null;
    const res = await call(base);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/reload Payment Follow-up/);
  });

  it("the same-tenant trigger's refusal reads as a next step, not SQL", async () => {
    db.role = "owner";
    db.insertError = { code: "23514", message: "That invoice is not in this company." };
    const res = await call(base);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/pick them again and save/);
  });
});
