/**
 * R-822 (10 Oct 2026) — signing up with a company's email domain joins (by request) the
 * company's existing workspace instead of creating a second one.
 *
 * Pawan, staging: pawan@anutech.in signed up and became OWNER of a new blank "Anutech"
 * workspace although Anutech already had one. Cause: only a VERIFIED `tenant_domains` row
 * routed a signup, and Anutech's claim was not verified there. Now an existing owner's
 * verified email domain counts too (resolveOwnerDomainTenant), and every first-time path
 * follows the rule:
 *   - email signup          → no workspace; the join request is opened when the email link
 *                             is followed (an unverified address is never routed)
 *   - Google first login    → join request at /callback (on staging the Auth.js branch of
 *                             /callback only swaps how the user is read, then runs this body)
 *   - /welcome "Create my workspace" (where the Auth.js first login lands) → join request
 *
 * These run the REAL routes and the REAL tenant-match code against a small in-memory
 * database, so the whole decision is exercised, not a mock of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/* ───────────── a tiny in-memory stand-in for the admin client ───────────── */
type Row = Record<string, unknown>;
type AuthUser = { id: string; email: string; email_confirmed_at: string | null; user_metadata: Row };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  auth: new Map<string, { id: string; email: string; email_confirmed_at: string | null; user_metadata: Record<string, unknown> }>(),
  sessionUser: null as null | { id: string; email: string; user_metadata: Record<string, unknown> },
}));

function likeToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;
  let embedTenants = false;
  let limitN = Infinity;
  const rows = () => (db.tables[table] ??= []);
  const matched = () => rows().filter((r) => filters.every((f) => f(r))).slice(0, limitN);
  const withEmbed = (r: Row) =>
    embedTenants ? { ...r, tenants: (db.tables.tenants ?? []).find((t) => t.id === r.tenant_id) ?? null } : r;

  const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
    if (op === "insert") {
      const row = { ...(payload as Row) };
      if (table === "join_requests") {
        const dup = rows().some((r) => r.tenant_id === row.tenant_id && r.email === row.email && r.status === "pending_approval");
        if (dup) return { data: null, error: { code: "23505", message: "duplicate" } };
        row.status ??= "pending_approval";
        row.id ??= `jr-${rows().length + 1}`;
      }
      if (table === "tenant_domains" && rows().some((r) => r.domain === row.domain)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      rows().push(row);
      return { data: row, error: null };
    }
    if (op === "update") { for (const r of matched()) Object.assign(r, payload); return { data: null, error: null }; }
    if (op === "delete") { db.tables[table] = rows().filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
    return { data: matched().map(withEmbed), error: null };
  };

  const b = {
    select(cols?: string) { if (cols?.includes("tenants(")) embedTenants = true; return b; },
    insert(p: Row) { op = "insert"; payload = p; return b; },
    update(p: Row) { op = "update"; payload = p; return b; },
    delete() { op = "delete"; return b; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
    ilike(c: string, v: string) { filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()); return b; },
    like(c: string, p: string) { const re = likeToRegex(p); filters.push((r) => re.test(String(r[c] ?? ""))); return b; },
    in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
    not() { return b; },
    order() { return b; },
    limit(n: number) { limitN = n; return b; },
    maybeSingle: async () => { const r = run(); const d = r.data as Row[] | Row | null; return { data: Array.isArray(d) ? d[0] ?? null : d, error: r.error }; },
    single: async () => { const r = run(); const d = r.data as Row[] | Row | null; return { data: Array.isArray(d) ? d[0] ?? null : d, error: r.error }; },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}

const admin = {
  from: (t: string) => query(t),
  auth: {
    admin: {
      createUser: async (i: { email: string; email_confirm?: boolean; user_metadata?: Row }) => {
        const id = `00000000-0000-4000-8000-${String(db.auth.size + 100).padStart(12, "0")}`;
        const u: AuthUser = { id, email: i.email, email_confirmed_at: i.email_confirm ? "2026-10-10T00:00:00Z" : null, user_metadata: i.user_metadata ?? {} };
        db.auth.set(id, u);
        return { data: { user: u }, error: null };
      },
      getUserById: async (id: string) => ({ data: { user: db.auth.get(id) ?? null }, error: null }),
      deleteUser: async (id: string) => { db.auth.delete(id); return { error: null }; },
      updateUserById: async (id: string, p: { email_confirm?: boolean }) => {
        const u = db.auth.get(id); if (u && p.email_confirm) u.email_confirmed_at = "2026-10-10T00:00:00Z";
        return { data: { user: u }, error: null };
      },
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => admin,
  createAdminClientFor: () => admin,
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: db.sessionUser } }),
      exchangeCodeForSession: async () => ({ data: { user: db.sessionUser }, error: null }),
    },
  }),
}));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ status: "sent" })));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/whatsapp/client", () => ({ sendWhatsApp: vi.fn(async () => { throw new Error("not configured"); }) }));
vi.mock("@/lib/security/turnstile-guard", () => ({ turnstileRefusal: async () => null }));

import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verifyEmail } from "@/app/api/auth/verify-email/route";
import { POST as newTenant } from "@/app/api/auth/onboarding/new-tenant/route";
import { GET as callback } from "@/app/(auth)/callback/route";
import { hashToken } from "@/lib/auth/email-verification";

/* ───────────── fixtures ───────────── */
const ANUTECH = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function seed(opts: { ownerVerified?: boolean; verifiedDomainRow?: boolean } = {}) {
  db.tables = {
    tenants: [{ id: ANUTECH, name: "ANUTECH DIGITAL PVT LTD", created_at: "2026-05-26T00:00:00Z" }],
    users: [{ id: OWNER, tenant_id: ANUTECH, email: "pardeep@anutech.in", role: "owner" }],
    // Exactly the staging state: the claim exists but was never verified.
    tenant_domains: [{ tenant_id: ANUTECH, domain: "anutech.in", verified_at: opts.verifiedDomainRow ? "2026-08-14T00:00:00Z" : null }],
    join_requests: [],
    team_invites: [],
    email_verifications: [],
    academy_apprentices: [],
  };
  db.auth = new Map([[OWNER, { id: OWNER, email: "pardeep@anutech.in", email_confirmed_at: opts.ownerVerified === false ? null : "2026-05-26T00:00:00Z", user_metadata: {} }]]);
  db.sessionUser = null;
}

const H = { host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  new NextRequest(`https://app.example${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
const signupBody = (email: string) => ({ email, password: "Str0ng-pass-123!", fullName: "Pawan Kumar", companyName: "Anutech" });

const tenantCount = () => db.tables.tenants.length;
const openRequests = () => db.tables.join_requests.filter((r) => r.status === "pending_approval");

/** Follow the confirmation link the signup "emailed": replace the stored hash with a known token's. */
async function followVerifyLink(email: string) {
  const row = db.tables.email_verifications.find((r) => r.email === email)!;
  const token = "t".repeat(40);
  row.token_hash = hashToken(token);
  return verifyEmail(post("/api/auth/verify-email", { token }));
}

beforeEach(() => { seed(); sendEmail.mockClear(); });

describe("email signup at a company domain (R-822)", () => {
  it("creates NO workspace and NO users row — the old bug made Pawan owner of a blank copy", async () => {
    const res = await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    const json = await res.json();
    expect(json.status).toBe("pending_approval");
    expect(json.needsVerification).toBe(true);
    expect(tenantCount()).toBe(1);
    expect(db.tables.users).toHaveLength(1);
    // Not echoed before the address is proven — no directory of who uses ResellerOS.
    expect(json.tenantName).toBeUndefined();
  });

  it("an unverified address is NOT routed: no join request, owner not pinged, until the link is followed", async () => {
    await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    expect(openRequests()).toHaveLength(0);
    expect(sendEmail.mock.calls.some((c) => (c as unknown as [{ kind?: string }])[0]?.kind === "join_request")).toBe(false);
  });

  it("following the email link opens the join request for the existing owner and says so", async () => {
    await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    const res = await followVerifyLink("pawan@anutech.in");
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, joinRequestedTo: "ANUTECH DIGITAL PVT LTD" });
    expect(openRequests()).toHaveLength(1);
    expect(openRequests()[0]).toMatchObject({ tenant_id: ANUTECH, email: "pawan@anutech.in", matched_by: "domain" });
    expect(tenantCount()).toBe(1);
  });

  it("free-mail signup still creates its own workspace", async () => {
    const res = await signup(post("/api/auth/signup", { ...signupBody("pawan.k@gmail.com"), companyName: "Pawan Traders" }));
    expect((await res.json()).status).toBe("created");
    expect(tenantCount()).toBe(2);
    expect(openRequests()).toHaveLength(0);
  });

  it("an unknown company domain still creates its own workspace", async () => {
    const res = await signup(post("/api/auth/signup", { ...signupBody("ceo@newco.in"), companyName: "NewCo" }));
    expect((await res.json()).status).toBe("created");
    expect(tenantCount()).toBe(2);
  });

  it("an owner whose OWN email is unverified does not claim the domain", async () => {
    seed({ ownerVerified: false });
    const res = await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    expect((await res.json()).status).toBe("created");
  });

  it("a verified tenant_domains row still routes, as before", async () => {
    seed({ verifiedDomainRow: true, ownerVerified: false });
    const res = await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    expect((await res.json()).status).toBe("pending_approval");
    expect(tenantCount()).toBe(1);
  });
});

describe("Google first login → /callback (R-822; same body as the Auth.js branch on staging)", () => {
  it("company domain → join request + /welcome?pending, no workspace", async () => {
    db.sessionUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "pawan@anutech.in", user_metadata: { full_name: "Pawan" } };
    const res = await callback(new NextRequest("https://app.example/callback?code=x", { headers: H }));
    expect(res.headers.get("location")).toBe("https://app.example/welcome?pending=ANUTECH%20DIGITAL%20PVT%20LTD");
    expect(openRequests()).toHaveLength(1);
    expect(tenantCount()).toBe(1);
  });

  it("an existing member logs in unchanged — no join request", async () => {
    db.sessionUser = { id: OWNER, email: "pardeep@anutech.in", user_metadata: {} };
    const res = await callback(new NextRequest("https://app.example/callback?code=x&next=/dashboard", { headers: H }));
    expect(res.headers.get("location")).toBe("https://app.example/dashboard");
    expect(openRequests()).toHaveLength(0);
  });

  it("free-mail Google login is asked on /welcome, not routed", async () => {
    db.sessionUser = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", email: "someone@gmail.com", user_metadata: {} };
    const res = await callback(new NextRequest("https://app.example/callback?code=x", { headers: H }));
    expect(res.headers.get("location")).toContain("/welcome?suggested=");
    expect(openRequests()).toHaveLength(0);
  });
});

describe("/welcome → Create my workspace (where an Auth.js first login lands)", () => {
  it("company domain → join request, NOT a second workspace", async () => {
    db.sessionUser = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "pawan@anutech.in", user_metadata: { full_name: "Pawan" } };
    const res = await newTenant(post("/api/auth/onboarding/new-tenant", { companyName: "Anutech" }));
    expect(await res.json()).toMatchObject({ ok: true, status: "pending_approval", tenantName: "ANUTECH DIGITAL PVT LTD" });
    expect(tenantCount()).toBe(1);
    expect(openRequests()).toHaveLength(1);
  });

  it("asking twice keeps one open request", async () => {
    db.sessionUser = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "pawan@anutech.in", user_metadata: {} };
    await newTenant(post("/api/auth/onboarding/new-tenant", { companyName: "Anutech" }));
    await newTenant(post("/api/auth/onboarding/new-tenant", { companyName: "Anutech" }));
    expect(openRequests()).toHaveLength(1);
  });

  it("free-mail → creates the workspace as before", async () => {
    db.sessionUser = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", email: "someone@gmail.com", user_metadata: {} };
    const res = await newTenant(post("/api/auth/onboarding/new-tenant", { companyName: "Someone Traders" }));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(tenantCount()).toBe(2);
    expect(db.tables.users.find((u) => u.id === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")?.role).toBe("owner");
  });
});

describe("owner approves → the person is in the EXISTING workspace with the chosen role", () => {
  it("approve with a role writes a users row in Anutech's workspace", async () => {
    const { POST: decide } = await import("@/app/api/team/join-requests/[id]/route");
    await signup(post("/api/auth/signup", signupBody("pawan@anutech.in")));
    await followVerifyLink("pawan@anutech.in");
    const reqRow = openRequests()[0];
    db.sessionUser = { id: OWNER, email: "pardeep@anutech.in", user_metadata: {} };
    const res = await decide(post(`/api/team/join-requests/${reqRow.id}`, { action: "approve", role: "manager" }), {
      params: Promise.resolve({ id: String(reqRow.id) }),
    });
    expect(await res.json()).toMatchObject({ ok: true, action: "approved", role: "manager" });
    const pawan = db.tables.users.find((u) => u.email === "pawan@anutech.in");
    expect(pawan).toMatchObject({ tenant_id: ANUTECH, role: "manager" });
    expect(tenantCount()).toBe(1);
  });
});
