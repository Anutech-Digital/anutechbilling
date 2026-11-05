/**
 * R-2483 (5 Nov 2026, money review 5 F-3): release_stale_team_invite now caps itself in SQL (30 an hour
 * per login, errcode 54000). The route used to drop the RPC error and invite WITHOUT the
 * member-of-another-company check — so a cap reached by direct browser calls would let the next invite
 * through to someone in a real company. Pinned: a 54000 from the check → 429, nothing written, no email.
 * Any other RPC error keeps the old behaviour (the invite is attempted — e.g. migration not deployed yet).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  rpcResult: { data: null as unknown, error: null as null | { message: string; code?: string } },
  inserts: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; text: string }>,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async () => ({ ok: true, retryAfterSec: 60, remaining: 1 }),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (e: { to: string; text: string }) => { st.emails.push(e); return { status: "stubbed" }; },
}));

function chain(result: () => unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "update"]) q[m] = () => q;
  q.single = async () => result();
  q.maybeSingle = async () => result();
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
    rpc: async () => st.rpcResult,
    from: (table: string) => {
      if (table === "users") return chain(() => ({ data: { tenant_id: T1, role: "owner", is_active: true }, error: null }));
      if (table === "tenants") return chain(() => ({ data: { name: "Acme" }, error: null }));
      if (table === "team_invites") {
        return {
          insert(v: Record<string, unknown>) {
            st.inserts.push(v);
            return chain(() => ({ data: { token: "tok" }, error: null }));
          },
          select: () => chain(() => ({ data: null, error: null })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
  createAdminClientFor: () => ({
    from: () => {
      const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { return { data: null, error: null }; } };
      return q;
    },
  }),
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json", host: "x.test" },
    body: JSON.stringify(body),
  }) as never);

beforeEach(() => { st.rpcResult = { data: null, error: null }; st.inserts = []; st.emails = []; });

describe("R-2483: the address check's own SQL cap", () => {
  it("54000 from release_stale_team_invite → 429, no invite written, no email", async () => {
    st.rpcResult = { data: null, error: { code: "54000", message: "Too many address checks in the last hour. Try again later." } };
    const r = await call({ email: "ravi@acme.test", role: "sales" });
    expect(r.status).toBe(429);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/Too many invites in the last hour/);
    expect(st.inserts).toHaveLength(0);
    expect(st.emails).toHaveLength(0);
  });

  it("any other RPC error keeps the old behaviour — the invite is attempted", async () => {
    st.rpcResult = { data: null, error: { code: "42883", message: "function does not exist" } };
    const r = await call({ email: "ravi@acme.test", role: "sales" });
    expect(r.status).toBe(200);
    expect(st.inserts).toHaveLength(1);
  });
});
