/**
 * R-361: /api/demo-data — the live app refuses before reading anything; only an owner or
 * manager of a workspace gets through; the work itself goes through the caller's own client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const getUser = vi.fn();
const me = vi.fn();
const createClient = vi.fn();
const addDemoData = vi.fn();
const clearDemoData = vi.fn();

function client() {
  return {
    auth: { getUser: () => getUser() },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(table === "users" ? { data: me() } : { data: { state_code: "07" } }),
        }),
      }),
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
  createAdminClient: () => { throw new Error("service role must not be used here"); },
}));
vi.mock("@/lib/demo/demo-data.server", () => ({
  addDemoData: (...a: unknown[]) => addDemoData(...a),
  clearDemoData: (...a: unknown[]) => clearDemoData(...a),
  describeCounts: () => "6 customers",
}));

import { POST, DELETE } from "./route";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "u1" } } });
  me.mockReset().mockReturnValue({ tenant_id: "t1", role: "owner" });
  createClient.mockReset().mockImplementation(client);
  addDemoData.mockReset().mockResolvedValue({ ok: true, already: false, counts: { customers: 6 }, invoicesSkipped: null });
  clearDemoData.mockReset().mockResolvedValue({ ok: true, counts: { customers: 6 }, invoicesSkipped: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("env guard — the live app never gets demo data", () => {
  it.each(["", "production", "live", "Staging"])("APP_ENV %j → 403, nothing read or written", async (env) => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
    for (const call of [POST, DELETE]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/only for staging and local/i);
    }
    expect(createClient).not.toHaveBeenCalled();
    expect(addDemoData).not.toHaveBeenCalled();
    expect(clearDemoData).not.toHaveBeenCalled();
  });

  it("staging and local are let through", async () => {
    for (const env of ["staging", "local"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect((await POST()).status).toBe(200);
    }
  });
});

describe("who may", () => {
  it("not signed in → 401", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await POST()).status).toBe(401);
    expect(addDemoData).not.toHaveBeenCalled();
  });

  it.each(["sales", "accountant", "support", "billing", "delivery", null])("role %j → 403", async (role) => {
    me.mockReturnValue({ tenant_id: "t1", role });
    expect((await POST()).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(addDemoData).not.toHaveBeenCalled();
    expect(clearDemoData).not.toHaveBeenCalled();
  });

  it("no workspace → 403", async () => {
    me.mockReturnValue({ tenant_id: null, role: "owner" });
    expect((await POST()).status).toBe(403);
  });

  it("owner and manager → the caller's own tenant, user and state go to the seeder", async () => {
    for (const role of ["owner", "manager"]) {
      me.mockReturnValue({ tenant_id: "t1", role });
      expect((await POST()).status).toBe(200);
    }
    const [, ctx] = addDemoData.mock.calls[0] as [unknown, { tenantId: string; userId: string; tenantStateCode: string; today: string }];
    expect(ctx).toMatchObject({ tenantId: "t1", userId: "u1", tenantStateCode: "07" });
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("responses", () => {
  it("second click → 200 already, says so", async () => {
    addDemoData.mockResolvedValue({ ok: true, already: true });
    const j = await (await POST()).json();
    expect(j).toMatchObject({ ok: true, already: true });
    expect(j.summary).toMatch(/already here/);
  });

  it("a failure → 500 with the reason", async () => {
    addDemoData.mockResolvedValue({ ok: false, error: "Could not add demo tasks: boom Nothing was kept." });
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Nothing was kept/);
  });

  it("clear → counts", async () => {
    const j = await (await DELETE()).json();
    expect(j).toMatchObject({ ok: true, counts: { customers: 6 } });
  });
});

describe("source", () => {
  const src = readFileSync(join(__dirname, "route.ts"), "utf8");
  it("never uses the service role — RLS is the tenant boundary", () => {
    expect(src).not.toMatch(/createAdminClient|SERVICE_ROLE/);
  });
  it("checks the env before creating any client", () => {
    expect(src.indexOf("demoDataAllowed(")).toBeLessThan(src.indexOf("createClient()"));
  });
});
