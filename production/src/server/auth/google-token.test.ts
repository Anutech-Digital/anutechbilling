/**
 * R-824 — getGoogleAccessToken() wired to the real Auth.js cookie format (next-auth/jwt encode /
 * getToken), with the DB, cookie jar and Google's token endpoint faked. Proves: the cookie token
 * is read for the right user only, refreshed with grt when expired and WRITTEN BACK to the same
 * encrypted cookie, and the GoTrue path still uses Supabase's provider_token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode } from "next-auth/jwt";

const SECRET = "test-secret-for-r824-only-0123456789abcdef";
const COOKIE = "authjs.session-token";
const UID = "11111111-1111-4111-8111-111111111111";

const jar = new Map<string, string>();
const setCookie = vi.fn((name: string, value: string) => { jar.set(name, value); });
vi.mock("next/headers", () => ({
  cookies: async () => ({
    toString: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
    set: setCookie,
  }),
}));

let provider: "authjs" | "gotrue" = "authjs";
vi.mock("./authjs", () => ({ authProvider: () => provider }));

let connectionRow: Record<string, unknown> | null = null;
let supabaseProviderToken: string | null = null;
function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike", "update"]) c[m] = () => c;
  c.maybeSingle = async () => result();
  c.limit = async () => ({ data: [] });
  c.then = (res: (v: unknown) => unknown) => res({ data: null, error: null });
  return c;
}
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: string) => chain(() => (t === "user_google_tokens" ? { data: connectionRow } : { data: { tenant_id: "tenant-1" } })),
  }),
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: supabaseProviderToken ? { provider_token: supabaseProviderToken } : null } }) },
  }),
}));

const RESELLER = "openid email https://www.googleapis.com/auth/apps.order";

async function signIn(claims: Record<string, unknown>) {
  jar.set(COOKIE, await encode({ token: { uid: UID, email: "owner@example.test", ...claims }, secret: SECRET, salt: COOKIE }));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  jar.clear();
  setCookie.mockClear();
  connectionRow = null;
  supabaseProviderToken = null;
  provider = "authjs";
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29.refreshed", expires_in: 3600, scope: RESELLER }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const nowSec = () => Math.floor(Date.now() / 1000);

describe("R-824 getGoogleAccessToken (wired)", () => {
  it("authjs: fresh cookie token with the Reseller scope → returned, nothing written", async () => {
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({ gat: "ya29.cookie", grt: "1//rt", gexp: nowSec() + 3000, gscope: RESELLER });
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: true, token: "ya29.cookie", source: "session" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("authjs: expired → refreshed with grt at Google's token endpoint and written back to the cookie", async () => {
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({ gat: "ya29.old", grt: "1//rt", gexp: nowSec() - 10, gscope: RESELLER });
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: true, token: "ya29.refreshed", source: "session" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(setCookie).toHaveBeenCalledOnce();
    const written = await decode({ token: jar.get(COOKIE)!, secret: SECRET, salt: COOKIE });
    expect(written).toMatchObject({ uid: UID, gat: "ya29.refreshed", grt: "1//rt" });
    expect((written?.gexp as number) > nowSec()).toBe(true);
  });

  it("authjs: refresh refused → needs_reauth, cookie untouched", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }));
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({ gat: "ya29.old", grt: "1//rt", gexp: nowSec() - 10, gscope: RESELLER });
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: false, reason: "needs_reauth" });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("authjs: a cookie from before gscope existed = login scopes only → missing_scope", async () => {
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({ gat: "ya29.cookie", grt: "1//rt", gexp: nowSec() + 3000 });
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: false, reason: "missing_scope" });
  });

  it("authjs: password login (no Google token in the cookie) → not_connected", async () => {
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({});
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("authjs: the cookie of a DIFFERENT user is never used", async () => {
    const { getGoogleAccessToken } = await import("./google-token");
    await signIn({ gat: "ya29.cookie", gexp: nowSec() + 3000, gscope: RESELLER });
    expect(await getGoogleAccessToken("reseller", "22222222-2222-4222-8222-222222222222")).toEqual({ ok: false, reason: "not_connected" });
  });

  it("saved connection (Connect Google Reseller) wins and is refreshed when expired", async () => {
    connectionRow = { user_id: UID, access_token: "ya29.conn-old", refresh_token: "1//plain-legacy", token_expiry: new Date(Date.now() - 1000).toISOString(), scopes: RESELLER };
    const { getGoogleAccessToken } = await import("./google-token");
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: true, token: "ya29.refreshed", source: "connection" });
  });

  it("gotrue: Supabase provider_token is still used (old path unchanged)", async () => {
    provider = "gotrue";
    supabaseProviderToken = "ya29.supabase";
    const { getGoogleAccessToken } = await import("./google-token");
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: true, token: "ya29.supabase", source: "session" });
  });

  it("gotrue: no provider_token → not_connected", async () => {
    provider = "gotrue";
    const { getGoogleAccessToken } = await import("./google-token");
    expect(await getGoogleAccessToken("reseller", UID)).toEqual({ ok: false, reason: "not_connected" });
  });
});
