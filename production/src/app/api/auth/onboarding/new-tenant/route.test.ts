/**
 * R-1843 — /welcome "new business" sends the business type; the route stores it on the tenant.
 * Missing / null → empty (= Pvt Ltd until set in Settings). Anything else → 400, nothing created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  inserts: [] as { table: string; row: Row }[],
  updates: [] as { table: string; row: Row }[],
  updateError: null as null | { message: string; code?: string },
  sessionUser: null as null | { id: string; email: string; user_metadata: Row; email_confirmed_at?: string },
  /* R-2119 */
  existing: null as null | Row,
  routed: null as null | { tenantName: string },
  routeCalls: 0,
  linkCalls: [] as Array<[string, string]>,
}));

function query(table: string) {
  const b = {
    select() { return b; },
    eq() { return b; },
    is() { return b; },
    insert(row: Row) { db.inserts.push({ table, row }); return b; },
    update(row: Row) {
      db.updates.push({ table, row });
      const done = { data: null, error: db.updateError };
      const after = {
        is: async () => done,
        then(res: (v: unknown) => unknown) { return Promise.resolve(done).then(res); },
      };
      return { eq: () => after };
    },
    delete() { return b; },
    maybeSingle: async () => ({ data: table === "users" ? db.existing : null, error: null }),
    then(res: (v: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(res); },
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({ from: (t: string) => query(t) }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: db.sessionUser } }) } }),
}));
vi.mock("@/lib/auth/tenant-match", () => ({ routeVerifiedSignupToCompany: async () => { db.routeCalls++; return db.routed; } }));
vi.mock("@/lib/personal/identity-link.server", () => ({
  linkPersonalIdentity: async (u: string, t: string) => {
    db.linkCalls.push([u, t]);
    return { ok: true, status: "linked", customerId: "c1", customerCreated: true, panelQueued: true, supportQueued: true };
  },
}));

import { POST } from "./route";

const post = (body: unknown) => new NextRequest("https://app.example/api/auth/onboarding/new-tenant", {
  method: "POST", headers: { host: "app.example", "content-type": "application/json" }, body: JSON.stringify(body),
});
const tenantRows = () => db.inserts.filter((i) => i.table === "tenants").map((i) => i.row);

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.updateError = null;
  db.sessionUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "ravi@gmail.com", user_metadata: { full_name: "Ravi" } };
  db.existing = null;
  db.routed = null;
  db.routeCalls = 0;
  db.linkCalls = [];
  vi.unstubAllEnvs();
});

describe("POST /api/auth/onboarding/new-tenant — business type (R-1843)", () => {
  it("'partnership' is stored on the new tenant", async () => {
    const res = await POST(post({ companyName: "Ravi & Sons", businessType: "partnership" }));
    expect(res.status).toBe(200);
    expect(tenantRows()).toHaveLength(1);
    expect(tenantRows()[0]).toMatchObject({ name: "Ravi & Sons", business_type: "partnership" });
  });

  it("skipped (missing or null) → empty, as before", async () => {
    await POST(post({ companyName: "Ravi Traders" }));
    await POST(post({ companyName: "Ravi Traders", businessType: null }));
    expect(tenantRows().map((r) => r.business_type)).toEqual([null, null]);
  });

  it("a wrong value is a 400 with a fix-it message, and nothing is created", async () => {
    const res = await POST(post({ companyName: "Ravi Traders", businessType: "huf" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Proprietorship, Partnership, LLP or Private Limited/);
    expect(db.inserts).toEqual([]);
  });
});

describe("POST /api/auth/onboarding/new-tenant — what you sell (R-1860)", () => {
  const sellUpdates = () => db.updates.filter((u) => u.table === "tenants").map((u) => u.row);

  it("'one_time' is stored on the new tenant", async () => {
    const res = await POST(post({ companyName: "Ravi Projects", sellMode: "one_time" }));
    expect(res.status).toBe(200);
    expect(sellUpdates()).toEqual([{ sell_mode: "one_time" }]);
  });

  it("skipped or 'both' writes nothing — the column default is Both", async () => {
    await POST(post({ companyName: "Ravi Traders" }));
    await POST(post({ companyName: "Ravi Traders", sellMode: "both" }));
    await POST(post({ companyName: "Ravi Traders", sellMode: null }));
    expect(sellUpdates()).toEqual([]);
    expect(tenantRows()).toHaveLength(3);
  });

  it("a wrong value is a 400 and nothing is created", async () => {
    const res = await POST(post({ companyName: "Ravi Traders", sellMode: "rentals" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Subscriptions, One-time products & services or Both/);
    expect(db.inserts).toEqual([]);
  });

  it("the workspace is still created when the column is not there yet (before the migration)", async () => {
    db.updateError = { message: 'column "sell_mode" of relation "tenants" does not exist', code: "42703" };
    const res = await POST(post({ companyName: "Ravi Projects", sellMode: "subscriptions" }));
    expect(res.status).toBe(200);
    expect(tenantRows()).toHaveLength(1);
  });
});

/* R-2119 (GP-05, G-PERSONAL): the Google / Auth.js door for a free personal account. Before this
   card the schema had no `kind`: every request needed companyName and became a business tenant +
   owner, and a work-email address was routed to that company's join request. */
describe("POST /api/auth/onboarding/new-tenant — personal workspace (R-2119)", () => {
  const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const confirmed = (email = "meera@gmail.com") => {
    db.sessionUser = { id: UID, email, user_metadata: { full_name: "Meera Iyer" }, email_confirmed_at: "2026-10-30T10:00:00Z" } as never;
  };
  const rows = (t: string) => db.inserts.filter((i) => i.table === t).map((i) => i.row);

  it("{kind:'personal', consent:true} → 1 personal tenant, role personal, consent rows, link — and /money next", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    confirmed();
    const res = await POST(post({ kind: "personal", consent: true }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, kind: "personal", next: "/money" });
    expect(rows("tenants")).toHaveLength(1);
    const t = rows("tenants")[0];
    expect(t).toMatchObject({ name: "Meera Iyer", workspace_kind: "personal", gstin: null, business_type: null });
    expect(rows("users")[0]).toMatchObject({ id: UID, tenant_id: t.id, role: "personal" });
    const consent = rows("consent_events")[0] as unknown as Array<Record<string, unknown>>;
    expect(consent.map((r) => r.purpose).sort()).toEqual(["account_terms", "marketing", "personal_finance_processing"]);
    expect(db.updates.filter((u) => u.table === "consent_events")).toEqual([{ table: "consent_events", row: { tenant_id: t.id } }]);
    expect(db.linkCalls).toEqual([[UID, t.id]]);
    expect(db.updates.filter((u) => u.table === "tenants")).toEqual([]);
  });

  it("without consent → 400 and nothing is created", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    confirmed();
    for (const body of [{ kind: "personal" }, { kind: "personal", consent: false }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(db.inserts).toEqual([]);
    expect(db.linkCalls).toEqual([]);
  });

  it("a work-email domain is NOT routed to that company — and no domain is claimed", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    confirmed("meera@rao-traders.in");
    db.routed = { tenantName: "Rao Traders" };
    const j = await (await POST(post({ kind: "personal", consent: true }))).json();
    expect(db.routeCalls).toBe(0);
    expect(j.status).not.toBe("pending_approval");
    expect(rows("tenants")).toHaveLength(1);
    expect(rows("tenant_domains")).toEqual([]);
  });

  it("an unconfirmed email is refused before anything is written", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    db.sessionUser = { id: UID, email: "meera@gmail.com", user_metadata: {} };
    const res = await POST(post({ kind: "personal", consent: true }));
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  it("someone who already has a workspace keeps the 409", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    confirmed();
    db.existing = { tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const res = await POST(post({ kind: "personal", consent: true }));
    expect(res.status).toBe(409);
    expect(db.inserts).toEqual([]);
  });

  it("with the flag off, personal is a 404", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "");
    confirmed();
    const res = await POST(post({ kind: "personal", consent: true }));
    expect(res.status).toBe(404);
    expect(db.inserts).toEqual([]);
  });

  it("a business request still needs companyName", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    confirmed();
    const res = await POST(post({ businessType: "partnership" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/company name/i);
    expect(db.inserts).toEqual([]);
  });
});
