/**
 * R-1749 — "Connect Zoho Books", per tenant. Owner's example: the Acme Traders owner
 * connects THEIR Zoho; only Acme Traders sees it, Other company sees nothing.
 *
 * Zoho is never called: global fetch is replaced by a fake that answers like Zoho's India DC.
 * Every value below is a throwaway made up for this test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const TENANT_ACME = "11111111-0000-4000-8000-00000000e1ce";
const TENANT_OTHER = "22222222-0000-4000-8000-0000000a0700";

const db = vi.hoisted(() => ({
  currentUser: null as string | null,
  users: {} as Record<string, { tenant_id: string; role: string }>,
  secrets: {} as Record<string, Record<string, unknown>>,
}));

/** A tiny tenant_secrets / users table that honours .eq() filters like PostgREST would. */
function table(name: string) {
  const filters: Array<[string, unknown]> = [];
  let op: { kind: "select" } | { kind: "update"; patch: Record<string, unknown> } = { kind: "select" };
  const rows = (): Record<string, unknown>[] =>
    name === "users"
      ? Object.entries(db.users).map(([id, u]) => ({ id, ...u }))
      : Object.values(db.secrets);
  const match = () => rows().filter((r) => filters.every(([k, v]) => r[k] === v));
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
  q.maybeSingle = async () => ({ data: match()[0] ?? null, error: null });
  q.single = q.maybeSingle;
  q.update = (patch: Record<string, unknown>) => { op = { kind: "update", patch }; return q; };
  q.upsert = async (row: Record<string, unknown>) => {
    const t = String(row.tenant_id);
    db.secrets[t] = { ...(db.secrets[t] ?? {}), ...row };
    return { error: null };
  };
  q.then = (ok: (v: unknown) => unknown) => {
    if (op.kind === "update") for (const r of match()) Object.assign(db.secrets[String(r.tenant_id)], op.patch);
    return Promise.resolve({ error: null }).then(ok);
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: db.currentUser ? { id: db.currentUser } : null } }) },
    from: (t: string) => table(t),
  }),
  createAdminClientFor: () => ({ from: (t: string) => table(t) }),
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));

import * as connect from "./connect/route";
import * as callback from "./callback/route";
import * as status from "./route";
import * as orgs from "./organizations/route";
import * as preview from "./preview/route";

const CLIENT_ID = "1000.TESTONLYCLIENTID";
const CLIENT_SECRET = "testonly-client-secret-0000000000";
const REFRESH = "1000.testonly-refresh-token.aaaaaaaa";
const ACCESS = "1000.testonly-access-token.bbbbbbbb";

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let zohoOrgs: Array<{ organization_id: string; name: string }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeZoho(url: string, init?: RequestInit): Response {
  calls.push({ url, init });
  const u = new URL(url);
  if (u.href.startsWith("https://accounts.zoho.in/oauth/v2/token/revoke")) return json({ status: "success" });
  if (u.href === "https://accounts.zoho.in/oauth/v2/token") {
    const p = new URLSearchParams(String(init?.body ?? ""));
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "good-code") return json({ error: "invalid_code" });
      return json({ access_token: ACCESS, refresh_token: REFRESH, api_domain: "https://www.zohoapis.in", expires_in: 3600 });
    }
    if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === REFRESH) return json({ access_token: ACCESS, expires_in: 3600 });
    return json({ error: "invalid_code" });
  }
  if (u.origin === "https://www.zohoapis.in") {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Zoho-oauthtoken ${ACCESS}`) return json({ code: 57, message: "not authorized" }, 401);
    if (u.pathname === "/books/v3/organizations") return json({ code: 0, organizations: zohoOrgs });
    const page = Number(u.searchParams.get("page"));
    if (u.pathname === "/books/v3/contacts") {
      const n = page === 1 ? 200 : 37;
      return json({ code: 0, contacts: Array.from({ length: n }, (_, i) => ({ contact_id: `c${page}-${i}` })), page_context: { has_more_page: page === 1 } });
    }
    if (u.pathname === "/books/v3/invoices") {
      return json({
        code: 0,
        invoices: [
          { invoice_id: "1", status: "paid", balance: 0, cf_subs_period: "01/04/2026 to 31/03/2027" },
          { invoice_id: "2", status: "overdue", balance: 1180, custom_fields: [{ label: "Service Expiry", api_name: "cf_service_expiry", value: "2027-03-31" }] },
          { invoice_id: "3", status: "partially_paid", balance: 500, cf_subs_period: "", cf_service_expiry: "2026-12-31" },
          { invoice_id: "4", status: "void", balance: 900 },
          { invoice_id: "5", status: "sent", balance: 236, custom_fields: [{ label: "Subs Period", value: "Apr 2026 - Mar 2027" }] },
        ],
        page_context: { has_more_page: false },
      });
    }
  }
  return json({ code: 1, message: "unexpected" }, 404);
}

const BASE = "http://localhost:3001";
function req(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: "localhost:3001" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function signIn(userId: string) { db.currentUser = userId; }

/** Starts a connect as the current user; returns the state + the cookie the browser keeps. */
async function startConnect() {
  const res = await connect.GET(req("/api/integrations/zoho-books/connect"));
  const loc = new URL(res.headers.get("location")!);
  const nonce = res.cookies.get("zb_oauth_nonce")?.value;
  return { res, loc, state: loc.searchParams.get("state")!, cookie: `zb_oauth_nonce=${nonce}` };
}

function noSecretIn(text: string) {
  expect(text).not.toContain(REFRESH);
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(CLIENT_SECRET);
}

beforeEach(() => {
  calls = [];
  zohoOrgs = [{ organization_id: "60001", name: "Acme Traders Pvt Ltd" }, { organization_id: "60002", name: "Acme Demo Org" }];
  db.currentUser = null;
  db.users = {
    "u-acme-owner": { tenant_id: TENANT_ACME, role: "owner" },
    "u-acme-accountant": { tenant_id: TENANT_ACME, role: "accountant" },
    "u-acme-sales": { tenant_id: TENANT_ACME, role: "sales" },
    "u-acme-billing": { tenant_id: TENANT_ACME, role: "billing" },
    "u-other-owner": { tenant_id: TENANT_OTHER, role: "owner" },
  };
  db.secrets = {};
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("ZOHO_BOOKS_REDIRECT_URI", "");
  vi.stubEnv("SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeZoho(String(url), init)));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("R-1749 owner's example — Acme Traders connects its own Zoho Books", () => {
  it("connect → Zoho consent → choose organization → Other company sees nothing of it", async () => {
    signIn("u-acme-owner");
    const { loc, state, cookie } = await startConnect();
    expect(loc.origin + loc.pathname).toBe("https://accounts.zoho.in/oauth/v2/auth");

    const cb = await callback.GET(req(`/api/integrations/zoho-books/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie }));
    expect(cb.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=connected`);

    // Stored on Acme's row only, sealed.
    const stored = String(db.secrets[TENANT_ACME].zoho_books_refresh_token);
    expect(stored.startsWith("rosv1:")).toBe(true);
    expect(stored).not.toContain(REFRESH);
    expect(db.secrets[TENANT_OTHER]).toBeUndefined();

    const list = await orgs.GET();
    const listBody = await list.json();
    expect(listBody.organizations).toEqual([{ id: "60001", name: "Acme Traders Pvt Ltd" }, { id: "60002", name: "Acme Demo Org" }]);
    const chosen = await orgs.POST(req("/api/integrations/zoho-books/organizations", { method: "POST", body: { organization_id: "60001" } }));
    expect(chosen.status).toBe(200);

    const st = await (await status.GET()).json();
    expect(st).toMatchObject({ configured: true, connected: true, needs_org: false, org_name: "Acme Traders Pvt Ltd", can_manage: true });

    // Other company's owner: not connected, no org name, cannot preview or disconnect Acme's.
    signIn("u-other-owner");
    const other = await (await status.GET()).json();
    expect(other).toMatchObject({ connected: false, org_name: null });
    const pv = await preview.POST();
    expect(pv.status).toBe(409);
    expect(JSON.stringify(await pv.json())).not.toContain("Acme Traders");
    await status.DELETE();
    expect(db.secrets[TENANT_ACME].zoho_books_org_id).toBe("60001");
    expect(String(db.secrets[TENANT_ACME].zoho_books_refresh_token).startsWith("rosv1:")).toBe(true);
  });
});

describe("connect", () => {
  it("asks Zoho India for read-only scopes, offline access, consent, the local callback and a signed state", async () => {
    signIn("u-acme-owner");
    const { res, loc, state } = await startConnect();
    expect(res.status).toBe(307);
    expect(loc.searchParams.get("scope")).toBe("ZohoBooks.contacts.READ,ZohoBooks.invoices.READ,ZohoBooks.settings.READ");
    expect(loc.searchParams.get("scope")).not.toMatch(/CREATE|UPDATE|DELETE|ALL/);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/integrations/zoho-books/callback");
    expect(state).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(res.cookies.get("zb_oauth_nonce")?.httpOnly).toBe(true);
    noSecretIn(res.headers.get("location")!);
  });

  it("missing env → back to Settings with 'not set up', Zoho is not opened", async () => {
    vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "");
    signIn("u-acme-owner");
    const res = await connect.GET(req("/api/integrations/zoho-books/connect"));
    expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=notconfigured`);
    const st = await (await status.GET()).json();
    expect(st).toMatchObject({ configured: false, message: "Zoho Books is not set up on this server" });
  });

  it("a sales or billing user cannot start it; an accountant can", async () => {
    for (const u of ["u-acme-sales", "u-acme-billing"]) {
      signIn(u);
      const res = await connect.GET(req("/api/integrations/zoho-books/connect"));
      expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=role`);
    }
    signIn("u-acme-accountant");
    const { loc } = await startConnect();
    expect(loc.host).toBe("accounts.zoho.in");
  });

  it("signed out → login", async () => {
    const res = await connect.GET(req("/api/integrations/zoho-books/connect"));
    expect(res.headers.get("location")).toBe(`${BASE}/login`);
  });
});

describe("callback — state check", () => {
  it("no cookie / wrong cookie / tampered state → refused before Zoho is called", async () => {
    signIn("u-acme-owner");
    const { state, cookie } = await startConnect();
    const tampered = state.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    for (const [s, c] of [[state, undefined], [state, "zb_oauth_nonce=someone-else"], [tampered, cookie]] as const) {
      calls = [];
      const res = await callback.GET(req(`/api/integrations/zoho-books/callback?code=good-code&state=${encodeURIComponent(s)}`, { cookie: c }));
      expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=badstate`);
      expect(calls).toHaveLength(0);
    }
    expect(db.secrets[TENANT_ACME]).toBeUndefined();
  });

  it("a state started by Acme's owner cannot land on Other company's tenant (even with the cookie)", async () => {
    signIn("u-acme-owner");
    const { state, cookie } = await startConnect();
    signIn("u-other-owner");
    const res = await callback.GET(req(`/api/integrations/zoho-books/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie }));
    expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=badstate`);
    expect(calls).toHaveLength(0);
    expect(db.secrets[TENANT_OTHER]).toBeUndefined();
    expect(db.secrets[TENANT_ACME]).toBeUndefined();
  });

  it("exchanges the code at accounts.zoho.in with the server's own secret, then never echoes it", async () => {
    signIn("u-acme-owner");
    const { state, cookie } = await startConnect();
    const res = await callback.GET(req(`/api/integrations/zoho-books/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie }));
    const tok = calls.find((c) => c.url === "https://accounts.zoho.in/oauth/v2/token")!;
    const p = new URLSearchParams(String(tok.init?.body));
    expect(Object.fromEntries(p)).toMatchObject({
      grant_type: "authorization_code", code: "good-code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: "http://localhost:3001/api/integrations/zoho-books/callback",
    });
    noSecretIn(res.headers.get("location")! + JSON.stringify([...res.cookies.getAll()]));
    expect(db.secrets[TENANT_ACME].zoho_books_connected_by).toBe("u-acme-owner");
  });

  it("Zoho refuses the code → error, nothing stored", async () => {
    signIn("u-acme-owner");
    const { state, cookie } = await startConnect();
    const res = await callback.GET(req(`/api/integrations/zoho-books/callback?code=bad&state=${encodeURIComponent(state)}`, { cookie }));
    expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=error`);
    expect(db.secrets[TENANT_ACME]?.zoho_books_refresh_token).toBeUndefined();
  });

  it("person pressed Deny at Zoho → denied", async () => {
    signIn("u-acme-owner");
    const res = await callback.GET(req("/api/integrations/zoho-books/callback?error=access_denied"));
    expect(res.headers.get("location")).toBe(`${BASE}/settings?tab=integrations&zoho=denied`);
  });
});

async function connectAcme(org = true) {
  signIn("u-acme-owner");
  const { state, cookie } = await startConnect();
  await callback.GET(req(`/api/integrations/zoho-books/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie }));
  if (org) await orgs.POST(req("/api/integrations/zoho-books/organizations", { method: "POST", body: { organization_id: "60001" } }));
  calls = [];
}

describe("organization, preview, disconnect", () => {
  it("only an organization this Zoho login can see can be chosen", async () => {
    await connectAcme(false);
    const res = await orgs.POST(req("/api/integrations/zoho-books/organizations", { method: "POST", body: { organization_id: "99999" } }));
    expect(res.status).toBe(400);
    expect(db.secrets[TENANT_ACME].zoho_books_org_id).toBeNull();
  });

  it("preview reads counts only: contacts, invoices total / open, custom fields", async () => {
    await connectAcme();
    const res = await preview.POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.preview).toEqual({ contacts: 237, invoices: 5, openInvoices: 3, withSubsPeriod: 2, withServiceExpiry: 2, capped: false });
    noSecretIn(JSON.stringify(body));
    // every Books call is a GET for the chosen org
    const books = calls.filter((c) => c.url.startsWith("https://www.zohoapis.in"));
    expect(books.every((c) => !c.init?.method || c.init.method === "GET")).toBe(true);
    expect(books.every((c) => new URL(c.url).searchParams.get("organization_id") === "60001")).toBe(true);
  });

  it("preview before an organization is chosen → 409 with the next step", async () => {
    await connectAcme(false);
    const res = await preview.POST();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Choose/);
  });

  it("a billing user cannot preview or disconnect", async () => {
    await connectAcme();
    signIn("u-acme-billing");
    expect((await preview.POST()).status).toBe(403);
    expect((await status.DELETE()).status).toBe(403);
    expect(db.secrets[TENANT_ACME].zoho_books_org_id).toBe("60001");
  });

  it("disconnect revokes the token at Zoho and deletes the stored copy", async () => {
    await connectAcme();
    const res = await status.DELETE();
    expect(res.status).toBe(200);
    const revoke = calls.find((c) => c.url.startsWith("https://accounts.zoho.in/oauth/v2/token/revoke"))!;
    expect(new URL(revoke.url).searchParams.get("token")).toBe(REFRESH);
    expect(db.secrets[TENANT_ACME]).toMatchObject({ zoho_books_refresh_token: null, zoho_books_org_id: null, zoho_books_org_name: null });
    expect((await (await status.GET()).json()).connected).toBe(false);
  });

  it("status never carries the token or the client secret", async () => {
    await connectAcme();
    const text = JSON.stringify(await (await status.GET()).json());
    noSecretIn(text);
    expect(text).not.toContain("rosv1:");
  });
});
