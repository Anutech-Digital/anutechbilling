/**
 * R-1897 — Co-pilot Step 3 routes:
 *   GET / PUT /api/marketing/copilot/plans/[id]/copy        (load / autosave one set, with a version)
 *   GET       /api/marketing/copilot/plans/[id]/copy/versions (earlier versions of one set)
 *   POST      /api/marketing/copilot/plans/[id]/ready       (Mark ready)
 * The DB is an in-memory fake behind withTenant; it keeps rows per tenant like RLS would and
 * records every write, so the test can prove each write carries the session's tenant.
 * Owner example: "Diwali Workspace", Google + Meta, lead_gen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  session: { userId: "u1", tenantId: "t1", aal: "aal1" } as { userId: string; tenantId: string; aal: string } | null,
  role: "marketing" as string | null,
  plans: [] as Row[],
  sets: [] as Row[],
  copies: [] as Row[],
  versions: [] as Row[],
  writes: [] as { table: string; tenant: unknown }[],
  seq: 0,
}));

const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { lte?: number; in?: unknown[] };
    if (o.lte != null) return (r[k] as number) <= o.lte;
    if (o.in) return o.in.includes(r[k]);
  }
  return r[k] === v;
});

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => {
    const log = (table: string, data: Row | Row[]) => (Array.isArray(data) ? data : [data]).forEach((d) => h.writes.push({ table, tenant: d.tenant_id }));
    return fn({
      public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
      ad_plans: {
        findFirst: async ({ where }: { where: Row }) => h.plans.find((p) => match(p, where)) ?? null,
        update: async ({ where, data }: { where: Row; data: Row }) => { const p = h.plans.find((x) => x.id === where.id)!; Object.assign(p, data); return p; },
      },
      ad_copy_sets: {
        findFirst: async ({ where }: { where: Row }) => h.sets.find((s) => match(s, where)) ?? null,
        findMany: async ({ where }: { where: Row }) => h.sets.filter((s) => match(s, where)),
        create: async ({ data }: { data: Row }) => {
          log("ad_copy_sets", data);
          if (h.sets.some((s) => s.plan_id === data.plan_id && s.platform === data.platform && s.audience === data.audience)) {
            throw Object.assign(new Error("unique"), { code: "P2002" });
          }
          const row = { id: `s${++h.seq}`, ...data };
          h.sets.push(row);
          return row;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const rows = h.sets.filter((s) => match(s, where));
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        },
      },
      ad_copies: {
        findMany: async ({ where }: { where: Row }) => h.copies.filter((c) => match(c, where)).sort((a, b) => (a.position as number) - (b.position as number)),
        deleteMany: async ({ where }: { where: Row }) => { const before = h.copies.length; h.copies = h.copies.filter((c) => !match(c, where)); return { count: before - h.copies.length }; },
        createMany: async ({ data }: { data: Row[] }) => { log("ad_copies", data); h.copies.push(...data); return { count: data.length }; },
      },
      ad_copy_set_versions: {
        create: async ({ data }: { data: Row }) => { log("ad_copy_set_versions", data); h.versions.push({ ...data, saved_at: new Date("2026-10-25T09:00:00Z") }); return data; },
        findMany: async ({ where, take }: { where: Row; take?: number }) => h.versions.filter((v) => match(v, where))
          .sort((a, b) => (b.version as number) - (a.version as number)).slice(0, take ?? 1000),
        deleteMany: async ({ where }: { where: Row }) => { h.versions = h.versions.filter((v) => !match(v, where)); return { count: 0 }; },
      },
    });
  },
}));

import { GET, PUT } from "./[id]/copy/route";
import { GET as VERSIONS } from "./[id]/copy/versions/route";
import { POST as READY } from "./[id]/ready/route";

const ID = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const url = `https://example.invalid/api/marketing/copilot/plans/${ID}/copy`;
const put = (body: unknown, id = ID) => PUT(new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(id));
const get = (id = ID) => GET(new Request(url), ctx(id));
const ready = (id = ID) => READY(new Request(url, { method: "POST" }), ctx(id));

const line = (field: string, text: string, position: number, extra: Row = {}) => ({ field, text, position, locked: false, pinned: null, ai_generated: true, ...extra });
const googleLines = [
  ...Array.from({ length: 15 }, (_, i) => line("headline", `Workspace headline ${i + 1}`, i)),
  ...Array.from({ length: 4 }, (_, i) => line("description", `Google Workspace set up by our own Delhi team, option ${i + 1}.`, i)),
];
const metaLines = [
  ...["Primary one for Workspace this Diwali, Delhi SMEs.", "Primary two for Workspace this Diwali, Delhi SMEs.", "Primary three for Workspace this Diwali, Delhi SMEs."].map((t, i) => line("primary_text", t, i)),
  ...["Workspace for Diwali", "Email that just works", "Talk to our team"].map((t, i) => line("headline", t, i)),
  line("description", "Setup and migration included", 0),
  line("cta", "GET_QUOTE", 0),
];
const google = (expectedVersion = 0, lines = googleLines) => ({ platform: "google-ads", audience: "generic", format: "search", expectedVersion, lines });
const meta = (expectedVersion = 0, lines = metaLines) => ({ platform: "meta-ads", audience: "generic", format: "feed_image", expectedVersion, lines });

beforeEach(() => {
  h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
  h.role = "marketing";
  h.plans = [
    { id: ID, tenant_id: "t1", name: "Diwali Workspace", objective: "lead_gen", platforms: ["google-ads", "meta-ads"], status: "draft" },
    { id: "7f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a12", tenant_id: "t2", name: "Other", objective: "traffic", platforms: ["google-ads"], status: "draft" },
  ];
  h.sets = [];
  h.copies = [];
  h.versions = [];
  h.writes = [];
  h.seq = 0;
});

describe("autosave — PUT then GET (survives a reload)", () => {
  it("saves a set as version 1 and reads it back exactly", async () => {
    const res = await put(google(0, [line("headline", "Kept headline", 0, { locked: true, pinned: 1 }), ...googleLines.slice(1)]));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);

    const body = await (await get()).json();
    const set = body.sets.find((s: Row) => s.platform === "google-ads" && s.audience === "generic");
    expect(set.version).toBe(1);
    expect(set.format).toBe("search");
    expect(set.rows.filter((r: Row) => r.field === "headline")).toHaveLength(15);
    expect(set.rows[0]).toMatchObject({ field: "headline", text: "Kept headline", position: 0, locked: true, pinned: 1 });
  });

  it("the next save is version 2, with a version row kept for each", async () => {
    await put(google(0));
    const r = await put(google(1, googleLines.slice(0, 5)));
    expect((await r.json()).version).toBe(2);
    expect(h.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(h.copies).toHaveLength(5);
  });

  it("a save from an older version (another tab) is refused with 409, nothing written", async () => {
    await put(google(0));
    await put(google(1));
    const r = await put(google(1, googleLines.slice(0, 3)));
    expect(r.status).toBe(409);
    expect((await r.json()).version).toBe(2);
    expect(h.copies).toHaveLength(19);
  });

  it("an audience the plan does not have, a platform it does not use, or a wrong format → 400", async () => {
    expect((await put({ ...google(0), audience: "lookalike" })).status).toBe(400); // lookalike is Meta-only
    h.plans[0].platforms = ["meta-ads"];
    expect((await put(google(0))).status).toBe(400);
    expect((await put({ ...meta(0), format: "search" })).status).toBe(400);
  });

  it("more lines than the platform takes, an unknown field or CTA → 400", async () => {
    expect((await put(google(0, [...googleLines, line("headline", "Sixteenth", 15)]))).status).toBe(400);
    expect((await put(google(0, [line("long_headline", "Nope", 0)]))).status).toBe(400);
    expect((await put(meta(0, [line("cta", "BUY_A_CAR", 0)]))).status).toBe(400);
  });

  it("an over-limit line still autosaves (work is never lost) — Mark ready is what blocks it", async () => {
    const r = await put(google(0, [line("headline", "a".repeat(31), 0), ...googleLines.slice(1)]));
    expect(r.status).toBe(200);
  });

  it("editing copy on a READY plan puts it back to draft", async () => {
    h.plans[0].status = "ready";
    const body = await (await put(google(0))).json();
    expect(body.status).toBe("draft");
    expect(h.plans[0].status).toBe("draft");
  });
});

describe("tenant isolation on ad_copies writes", () => {
  it("every row written carries the session's tenant", async () => {
    await put(google(0));
    await put(meta(0));
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.writes.every((w) => w.tenant === "t1")).toBe(true);
  });

  it("another company's plan → 404, nothing written", async () => {
    const r = await put(google(0), "7f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a12");
    expect(r.status).toBe(404);
    expect(h.writes).toEqual([]);
    expect((await get("7f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a12")).status).toBe(404);
  });

  it("401 without a session; 403 for sales — before anything is read or written", async () => {
    h.session = null;
    expect((await put(google(0))).status).toBe(401);
    h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
    h.role = "sales";
    expect((await put(google(0))).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a plan already publishing → 409", async () => {
    h.plans[0].status = "publishing";
    expect((await put(google(0))).status).toBe(409);
  });
});

describe("versions", () => {
  it("lists earlier versions of one set, newest first, with their lines", async () => {
    await put(google(0));
    await put(google(1, googleLines.slice(0, 4)));
    const r = await VERSIONS(new Request(`${url}/versions?platform=google-ads&audience=generic`), ctx());
    const body = await r.json();
    expect(body.versions.map((v: Row) => v.version)).toEqual([2, 1]);
    expect(body.versions[1].lines).toHaveLength(19);
  });

  it("keeps only the latest 20 versions", async () => {
    for (let v = 0; v < 22; v++) await put(google(v, googleLines.slice(0, 3 + (v % 2))));
    expect(Math.min(...h.versions.map((x) => x.version as number))).toBe(3);
    expect(h.versions).toHaveLength(20);
  });
});

describe("Mark ready — blocked until every chosen platform has one full set", () => {
  it("nothing written → 422 with what is missing for both platforms", async () => {
    const r = await ready();
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.missing.join(" ")).toMatch(/Google Ads/);
    expect(body.missing.join(" ")).toMatch(/Meta/);
    expect(h.plans[0].status).toBe("draft");
  });

  it("Google only → still 422 (Meta missing)", async () => {
    await put(google(0));
    const body = await (await ready()).json();
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0]).toMatch(/^Meta/);
  });

  it("a Google headline over 30 → 422 even with Meta full", async () => {
    await put(google(0, [line("headline", "a".repeat(31), 0), ...googleLines.slice(1)]));
    await put(meta(0));
    const r = await ready();
    expect(r.status).toBe(422);
    expect((await r.json()).missing[0]).toMatch(/over 30/);
  });

  it("both platforms full → 200 and the plan is Ready", async () => {
    await put(google(0));
    await put(meta(0));
    const r = await ready();
    expect(r.status).toBe(200);
    expect(h.plans[0].status).toBe("ready");
  });

  it("another company's plan → 404", async () => {
    expect((await ready("7f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a12")).status).toBe(404);
  });
});
