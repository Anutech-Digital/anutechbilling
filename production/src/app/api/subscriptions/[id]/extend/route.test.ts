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
  actors: [] as string[], // R-051: who createAdminClientFor() was opened for
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
  createAdminClientFor: (actor: string) => (db.actors.push(actor), {
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
  db.actors = [];
  quote.create.mockReset();
  quote.create.mockResolvedValue({ ok: true, quoteId: "Q-1", amount: 14400, years: 1, months: 12 });
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
    expect(db.actors).toEqual(["U1"]); // R-051: audit log gets the signed-in caller
    expect(await res.json()).toEqual({ ok: true, quoteId: "Q-1", amount: 14400, years: 1, months: 12, subscriptionId: "S1" });
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

describe("subscriptions extend — months (R-805)", () => {
  beforeEach(() => {
    db.me = { tenant_id: "T1", role: "owner" };
    quote.create.mockResolvedValue({ ok: true, quoteId: "Q-2", amount: 4885, years: null, months: 3 });
  });

  it("{ months: 3 } → 200, months passed through with the dates the quote note needs", async () => {
    (db.rows.subscriptions as Record<string, unknown>).start_date = "2025-10-10";
    (db.rows.subscriptions as Record<string, unknown>).term_months = 12;
    (db.rows.subscriptions as Record<string, unknown>).billing_cycle = "yearly";
    const res = await call({ months: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, quoteId: "Q-2", amount: 4885, years: null, months: 3, subscriptionId: "S1" });
    expect(quote.create).toHaveBeenCalledWith(expect.objectContaining({
      months: 3, years: undefined, startDate: "2025-10-10", termMonths: 12,
    }));
  });

  it.each([1, 6, 11])("{ months: %i } is accepted", async (m) => {
    expect((await call({ months: m })).status).toBe(200);
  });

  it.each([0, 12, 2.5])("{ months: %s } → 400", async (m) => {
    expect((await call({ months: m })).status).toBe(400);
    expect(quote.create).not.toHaveBeenCalled();
  });

  it("both or neither of years / months → 400", async () => {
    expect((await call({ years: 1, months: 3 })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect(quote.create).not.toHaveBeenCalled();
  });

  /* R-807: years were still allowed here and double-billed the extended year (proof in
     extension-term.ts → extensionBlockedReason). Both are refused now; no quote is made. */
  it.each([
    ["monthly", "monthly"], ["quarterly", "quarterly"], ["half_yearly", "half-yearly"],
  ])("billed %s (in parts) → months AND years refused, no quote", async (cycle, word) => {
    (db.rows.subscriptions as Record<string, unknown>).billing_cycle = cycle;
    for (const body of [{ months: 3 }, { years: 1 }, { years: 3 }]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("split_billed");
      expect(json.error).toBe(`This subscription is billed ${word}, so each part gets its own invoice on its date. An extension quote would bill the same months twice, so it cannot be extended.`);
    }
    expect(quote.create).not.toHaveBeenCalled();
  });

  it.each(["yearly", null])("billed %s → years and months still allowed", async (cycle) => {
    (db.rows.subscriptions as Record<string, unknown>).billing_cycle = cycle;
    expect((await call({ years: 1 })).status).toBe(200);
    expect((await call({ months: 3 })).status).toBe(200);
  });
});
