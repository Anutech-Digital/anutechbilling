/**
 * POST /api/subscriptions/[id]/extend — role gate via withRoute() (R-217, R-051).
 * Pinned: owner/manager/billing get the extension quote (200); sales/support/delivery get 403
 * in the withRoute shape ({ ok: false, error }) and no quote is created.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "sales" } as { tenant_id: string; role: string } | null,
  rows: {} as Record<string, unknown>,
  reads: [] as string[],
}));
const quote = vi.hoisted(() => ({ create: vi.fn() }));

function chain(table: string, user: boolean) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
  const one = async () => ({ data: table === "users" && user ? db.me : (db.rows[table] ?? null), error: null });
  q.single = one;
  q.maybeSingle = one;
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: (t: string) => chain(t, true),
  }),
  createAdminClient: () => ({
    from: (t: string) => { db.reads.push(t); return chain(t, false); },
  }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/renewals/create-extension-quote", () => ({ createExtensionQuote: quote.create }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(
    new NextRequest("https://example.invalid/api/subscriptions/S1/extend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "S1" }) },
  );

beforeEach(() => {
  db.me = { tenant_id: "T1", role: "sales" };
  db.rows = {
    subscriptions: {
      id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "Acme", plan: "Business Starter",
      seats: 5, mrr: 1200, renewal_date: "2027-01-01", status: "active", renewal_quote_id: null,
    },
    tenants: { grace_period_days: 7 },
  };
  db.reads = [];
  quote.create.mockReset();
  quote.create.mockResolvedValue({ ok: true, quoteId: "Q-1", amount: 14400, years: 1 });
});

describe("subscriptions extend — role gate (R-217)", () => {
  it.each(["sales", "support", "delivery", "accountant"])("%s → 403, withRoute shape, no quote", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call({ years: 1 });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Only Owner, Manager, Billing can change seats or subscription terms. Ask one of them to do it.");
    expect(db.reads).toEqual([]);
    expect(quote.create).not.toHaveBeenCalled();
  });

  it.each(["owner", "manager", "billing"])("%s → 200 with the quote", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call({ years: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, quoteId: "Q-1", amount: 14400, years: 1, subscriptionId: "S1" });
    expect(quote.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "T1", subscriptionId: "S1", years: 1 }));
  });

  it("another tenant's subscription stays 403 for an allowed role", async () => {
    db.me = { tenant_id: "T2", role: "owner" };
    const res = await call({ years: 1 });
    expect(res.status).toBe(403);
    expect(quote.create).not.toHaveBeenCalled();
  });

  it("years outside 1–5 is 400", async () => {
    db.me = { tenant_id: "T1", role: "owner" };
    expect((await call({ years: 9 })).status).toBe(400);
  });
});
