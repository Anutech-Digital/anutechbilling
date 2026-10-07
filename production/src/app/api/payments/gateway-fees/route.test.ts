/**
 * R-045 slice 2 — "Book Razorpay fees": role-gated, books only the payments not booked yet,
 * and a second press books nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  payments: [] as { id: string }[],
  existing: [] as string[],
  bookCalls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "order", "limit", "in"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === "users" ? { tenant_id: "T1", role: state.role } : null, error: null });
      q.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "payments" ? state.payments : table === "expenses" ? state.existing.map((id) => ({ id })) : [],
          error: null,
        }).then(ok);
      return q;
    },
  }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({
  bookGatewayFeeExpense: async (_db: unknown, tenant: string, id: string) => {
    expect(tenant).toBe("T1");
    state.bookCalls.push(id);
    state.existing.push(`EXP-RZPFEE-${id}`);
    return "booked";
  },
}));

import { POST } from "./route";

const req = () => new Request("http://localhost/api/payments/gateway-fees", { method: "POST" }) as unknown as NextRequest;

beforeEach(() => {
  state.role = "owner";
  state.payments = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  state.existing = ["EXP-RZPFEE-p2"];
  state.bookCalls = [];
});

describe("POST /api/payments/gateway-fees", () => {
  it("books only payments without a fee expense; a second press books nothing", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, booked: 2, alreadyBooked: 1, remaining: 0, failed: 0 });
    expect(state.bookCalls).toEqual(["p1", "p3"]);

    state.bookCalls = [];
    const again = await (await POST(req())).json();
    expect(again).toMatchObject({ booked: 0, alreadyBooked: 3 });
    expect(state.bookCalls).toEqual([]);
  });

  it.each(["sales", "support", "delivery"])("%s → 403, nothing booked", async (role) => {
    state.role = role;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(state.bookCalls).toEqual([]);
  });
});
