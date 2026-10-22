/**
 * R-1757 — the Zoho access token is minted once and reused; Zoho's "too many requests" is
 * "busy", never "access has ended". Zoho is never called: fetch is a fake token endpoint.
 * Every value is a throwaway made up for this test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EARLY_MS, forgetAccessToken, getAccessToken, invalidateAccessToken, type TokenStore } from "./token-cache";
import { ZOHO_ACCESS_ENDED_MESSAGE, ZOHO_BUSY_MESSAGE, ZohoApiError } from "./api";

const CREDS = { clientId: "t-client", clientSecret: "t-secret" };
const T = "t-tenant-a";

function fakeTokenEndpoint(answer: () => { status: number; body: Record<string, unknown> }) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    expect(String(input)).toBe("https://accounts.zoho.in/oauth/v2/token");
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
function memStore(initial: { token: string; expiresAt: number } | null = null) {
  let row = initial;
  const writes: unknown[] = [];
  const store: TokenStore = {
    async read() { return row; },
    async write(t) { row = t; writes.push(t); },
    async clear() { row = null; },
  };
  return { store, writes, get: () => row };
}

let n = 0;
const ok = () => ({ status: 200, body: { access_token: `t-access-${++n}`, expires_in: 3600, api_domain: "https://www.zohoapis.in", token_type: "Bearer" } });

beforeEach(() => { forgetAccessToken(T); forgetAccessToken("t-tenant-b"); n = 0; });

describe("getAccessToken — one mint, reused", () => {
  it("100 steps of a dry run → the token is minted once", async () => {
    const { f, calls } = fakeTokenEndpoint(ok);
    const { store, writes } = memStore();
    let clock = 1_000_000;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(await getAccessToken(T, "t-refresh", CREDS, store, { fetch: f, now: () => clock }));
      clock += 20_000; // 100 × 20 s = 33 min, inside the 1-hour token
    }
    expect(calls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect([...seen]).toEqual(["t-access-1"]);
  });

  it("callers arriving together share one refresh (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: number[] = [];
    const f = (async () => { calls.push(1); await gate; return Response.json(ok().body); }) as unknown as typeof fetch;
    const { store } = memStore();
    const all = Promise.all(Array.from({ length: 10 }, () => getAccessToken(T, "t-refresh", CREDS, store, { fetch: f })));
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(new Set(await all).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("another server instance uses the stored token instead of minting", async () => {
    const { f, calls } = fakeTokenEndpoint(ok);
    const { store } = memStore({ token: "t-shared", expiresAt: Date.now() + 30 * 60_000 });
    expect(await getAccessToken(T, "t-refresh", CREDS, store, { fetch: f })).toBe("t-shared");
    expect(calls).toHaveLength(0);
  });

  it("mints again only shortly before expiry, and after a reconnect or a 401", async () => {
    const { f, calls } = fakeTokenEndpoint(ok);
    const { store } = memStore();
    let clock = 0;
    await getAccessToken(T, "t-refresh", CREDS, store, { fetch: f, now: () => clock });
    clock = 3600_000 - EARLY_MS - 1;
    await getAccessToken(T, "t-refresh", CREDS, store, { fetch: f, now: () => clock });
    expect(calls).toHaveLength(1);
    clock = 3600_000 - EARLY_MS + 1;
    await getAccessToken(T, "t-refresh", CREDS, store, { fetch: f, now: () => clock });
    expect(calls).toHaveLength(2);
    // reconnect: a different refresh token never reuses the old token from memory
    const { store: s2 } = memStore();
    expect(await getAccessToken(T, "t-refresh-new", CREDS, s2, { fetch: f, now: () => clock })).toBe("t-access-3");
    await invalidateAccessToken(T, s2);
    await getAccessToken(T, "t-refresh-new", CREDS, s2, { fetch: f, now: () => clock });
    expect(calls).toHaveLength(4);
  });

  it("each tenant has its own token", async () => {
    const { f } = fakeTokenEndpoint(ok);
    const a = await getAccessToken(T, "t-refresh-a", CREDS, memStore().store, { fetch: f });
    const b = await getAccessToken("t-tenant-b", "t-refresh-b", CREDS, memStore().store, { fetch: f });
    expect(a).not.toBe(b);
  });
});

describe("token endpoint refusals", () => {
  const err = async (status: number, body: Record<string, unknown>) => {
    const { f } = fakeTokenEndpoint(() => ({ status, body }));
    try { await getAccessToken(T, "t-refresh", CREDS, memStore().store, { fetch: f }); }
    catch (e) { return e as ZohoApiError; }
    throw new Error("no error");
  };

  it("Zoho's rate limit (Access Denied … too many requests) → busy, no disconnect advice", async () => {
    const e = await err(400, { error: "Access Denied", error_description: "You have made too many requests continuously. Please try again after some time." });
    expect(e.code).toBe("busy");
    expect(e.message).toBe(ZOHO_BUSY_MESSAGE);
    expect(e.message).not.toMatch(/Disconnect|access has ended/i);
    expect((await err(429, {})).code).toBe("busy");
  });

  it("invalid / revoked refresh token → access has ended", async () => {
    const e = await err(200, { error: "invalid_code" });
    expect(e.code).toBe("reconnect");
    expect(e.message).toBe(ZOHO_ACCESS_ENDED_MESSAGE);
  });

  it("any other refusal → try again, not access ended", async () => {
    const e = await err(500, { error: "something_else" });
    expect(e.code).toBe("token_error");
    expect(e.message).not.toMatch(/access has ended|Disconnect/i);
  });
});
