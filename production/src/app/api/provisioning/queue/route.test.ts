/**
 * R-1440: the Activation Queue API read every paid-and-waiting seat for the tenant (through
 * the service-role client) for ANY signed-in member — a Sales user could fetch it directly
 * even after the page itself was gated. It now answers only the roles whose menu has the
 * Activation Queue (nav.ts: owner, manager, support, delivery).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  me: { tenant_id: "t1", role: "sales" } as { tenant_id: string | null; role: string } | null,
  listed: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: st.me }) }) }),
    }),
  }),
}));
vi.mock("@/lib/provisioning/provisioning.server", () => ({
  listProvisioningQueue: async () => {
    st.listed++;
    return [{ id: "p1", status: "queued", blocker: null, payment_mode: "live" }];
  },
}));

import { GET } from "./route";

beforeEach(() => {
  st.user = { id: "u1" };
  st.me = { tenant_id: "t1", role: "sales" };
  st.listed = 0;
});

describe("GET /api/provisioning/queue — role gate (R-1440)", () => {
  it.each(["sales", "sales_senior", "billing", "accountant", "partner_agent"])(
    "%s → 403 and the queue is never read", async (role) => {
      st.me = { tenant_id: "t1", role };
      const r = await GET();
      expect(r.status).toBe(403);
      expect(st.listed).toBe(0);
    },
  );

  it.each(["owner", "manager", "support", "delivery"])("%s → 200 with the rows", async (role) => {
    st.me = { tenant_id: "t1", role };
    const r = await GET();
    expect(r.status).toBe(200);
    const body = await r.json() as { rows: unknown[]; counts: { waiting: number } };
    expect(body.rows).toHaveLength(1);
    expect(body.counts.waiting).toBe(1);
  });

  it("signed out → 401", async () => {
    st.user = null;
    expect((await GET()).status).toBe(401);
  });
});
