/**
 * R-1879 — GET /api/marketing/copilot/plans (recent plans + product picker) and
 * GET / PUT /api/marketing/copilot/plans/[id] (open a draft, save steps 1–2).
 * The DB is an in-memory fake behind withTenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  session: { userId: "u1", tenantId: "t1", aal: "aal1" } as { userId: string; tenantId: string; aal: string } | null,
  role: "owner" as string | null,
  plans: [] as Row[],
  groups: [] as Row[],
  findManyArgs: null as unknown,
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
    items: { findMany: async () => [{ id: "i-gws", name: "Google Workspace" }] },
    tenants: { findUnique: async () => ({ name: "Anutech Digital" }) },
    ad_plans: {
      findMany: async (args: unknown) => { h.findManyArgs = args; return h.plans.map((p) => ({ ...p, items: p.item_id ? { name: "Google Workspace" } : null })); },
      findFirst: async ({ where }: { where: { id: string; tenant_id: string } }) => {
        const p = h.plans.find((x) => x.id === where.id && x.tenant_id === where.tenant_id);
        return p ? { ...p, ad_target_groups: h.groups.filter((g) => g.plan_id === p.id) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => { const p = h.plans.find((x) => x.id === where.id)!; Object.assign(p, data); return p; },
    },
    ad_target_groups: {
      deleteMany: async ({ where }: { where: { plan_id: string } }) => { h.groups = h.groups.filter((g) => g.plan_id !== where.plan_id); return { count: 0 }; },
      createMany: async ({ data }: { data: Row[] }) => { h.groups.push(...data); return { count: data.length }; },
    },
  }),
}));

import { GET as LIST } from "./route";
import { GET, PUT } from "./[id]/route";

const ID = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown, id = ID) => PUT(new Request(`https://example.invalid/api/marketing/copilot/plans/${id}`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), ctx(id));
const get = (id = ID) => GET(new Request(`https://example.invalid/api/marketing/copilot/plans/${id}`), ctx(id));

const draft = {
  name: "Diwali Workspace", itemId: "i-gws", objective: "lead_gen", platforms: ["google-ads", "meta-ads"],
  prompt: "Diwali offer", language: "en",
  audience: { ageMin: 25, ageMax: 55, genders: ["female"], regions: ["Delhi"], lookalike: true },
};

beforeEach(() => {
  h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
  h.role = "owner";
  h.plans = [{
    id: ID, tenant_id: "t1", name: "Old", item_id: null, objective: "traffic", platforms: ["google-ads"],
    prompt: "Diwali offer", language: "en", status: "draft", updated_at: new Date("2026-10-25T00:00:00Z"),
  }];
  h.groups = [{ plan_id: ID, tenant_id: "t1", kind: "generic", age_min: 18, age_max: 65, genders: [], regions: [] }];
});

describe("GET /plans — Recent", () => {
  it("401 / 403 before anything is read", async () => {
    h.session = null;
    expect((await LIST()).status).toBe(401);
    h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
    h.role = "billing";
    expect((await LIST()).status).toBe(403);
  });

  it("this company's plans, newest first, with the product picker list", async () => {
    const body = await (await LIST()).json();
    expect(body.plans[0]).toMatchObject({ id: ID, name: "Old", objective: "traffic", status: "draft" });
    expect(body.items).toEqual([{ id: "i-gws", name: "Google Workspace" }]);
    expect(body.brand).toBe("Anutech Digital");
    expect(h.findManyArgs).toMatchObject({ where: { tenant_id: "t1" }, orderBy: { updated_at: "desc" } });
  });
});

describe("GET /plans/[id]", () => {
  it("reads the plan with its audience", async () => {
    const body = await (await get()).json();
    expect(body.plan).toMatchObject({ id: ID, objective: "traffic", audience: { ageMin: 18, ageMax: 65, lookalike: false } });
  });

  it("another company's id / a bad id → 404", async () => {
    h.plans[0].tenant_id = "t2";
    expect((await get()).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});

describe("PUT /plans/[id] — save steps 1–2", () => {
  it("saves the plan and replaces its audience rows", async () => {
    const res = await put(draft);
    expect(res.status).toBe(200);
    expect(h.plans[0]).toMatchObject({ name: "Diwali Workspace", item_id: "i-gws", objective: "lead_gen", platforms: ["google-ads", "meta-ads"] });
    expect(h.groups.map((g) => g.kind)).toEqual(["generic", "lookalike"]);
    const body = await res.json();
    expect(body.plan.audience).toEqual(draft.audience);
  });

  it("drops a platform the objective cannot use and says why", async () => {
    const body = await (await put({ ...draft, objective: "engagement" })).json();
    expect(body.plan.platforms).toEqual(["meta-ads"]);
    expect(body.notes.join(" ")).toMatch(/Google Ads/);
  });

  it("400 when nothing can run; 400 for an unknown region", async () => {
    expect((await put({ ...draft, objective: "awareness", platforms: ["google-ads"] })).status).toBe(400);
    expect((await put({ ...draft, audience: { ...draft.audience, regions: ["Atlantis"] } })).status).toBe(400);
  });

  it("409 once the plan is publishing / live", async () => {
    h.plans[0].status = "live";
    expect((await put(draft)).status).toBe(409);
  });

  it("403 for sales; 404 for another company's plan", async () => {
    h.role = "sales";
    expect((await put(draft)).status).toBe(403);
    h.role = "marketing";
    h.plans[0].tenant_id = "t2";
    expect((await put(draft)).status).toBe(404);
  });
});
