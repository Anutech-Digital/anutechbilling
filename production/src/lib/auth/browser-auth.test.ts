// @vitest-environment jsdom
/**
 * R-1501 (Pawan, staging 17 Oct 2026, /settings → Help → Report a problem): Submit answered
 * "You don't have access to this. Your report was NOT saved." After a page reload the same
 * person filed three reports in a row without trouble.
 *
 * The browser keeps the 10-minute data token in memory and fetches a new one a minute before it
 * runs out. When that one fetch failed (a 5xx / a dropped request), the failure was cached as
 * "signed out": every later request went out with the ANON key, the gateway ran it as a visitor,
 * current_tenant_id() was NULL, and the feedback insert was refused with 42501 — until a reload.
 * A failed refresh must never turn a signed-in person into a visitor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signIn: vi.fn(), signOut: vi.fn() }));

const ANON = "anon-key";
const NOW = Date.parse("2026-10-17T10:20:00Z");
const sec = () => Math.floor(Date.now() / 1000);
const ok = (token: string, ttl = 600) =>
  new Response(JSON.stringify({ access_token: token, expires_at: sec() + ttl, user: { id: "u-pawan" } }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;
async function load() {
  vi.resetModules();
  return import("./browser-auth");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("R-1501 — a failed token refresh never downgrades a signed-in person to anon", () => {
  it("refresh fails while the old token is still valid → the old token is used, not the anon key", async () => {
    const m = await load();
    fetchMock.mockResolvedValueOnce(ok("tok-A"));
    expect(await m.browserAccessToken()).toBe("tok-A");

    // Pawan types his report for 9+ minutes; the refresh window opens and the refresh fails.
    vi.setSystemTime(NOW + 545_000);
    fetchMock.mockResolvedValue(new Response("upstream error", { status: 503 }));
    expect(await m.browserAccessToken()).toBe("tok-A");
  });

  it("refresh fails by network error → still the old token", async () => {
    const m = await load();
    fetchMock.mockResolvedValueOnce(ok("tok-A"));
    await m.browserAccessToken();
    vi.setSystemTime(NOW + 545_000);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await m.browserAccessToken()).toBe("tok-A");
  });

  it("a failure is not remembered: the next request asks again and gets the new token", async () => {
    const m = await load();
    fetchMock.mockResolvedValueOnce(new Response("cold start", { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response("cold start", { status: 503 }));
    await m.browserAccessToken(); // nothing to fall back on yet
    fetchMock.mockResolvedValueOnce(ok("tok-B"));
    expect(await m.browserAccessToken()).toBe("tok-B");
  });

  it("one failed refresh is retried at once before giving up", async () => {
    const m = await load();
    fetchMock.mockResolvedValueOnce(new Response("blip", { status: 502 }));
    fetchMock.mockResolvedValueOnce(ok("tok-C"));
    expect(await m.browserAccessToken()).toBe("tok-C");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a real 'signed out' answer still gives the anon key (visitors keep working)", async () => {
    const m = await load();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: null, user: null }), { status: 200 }));
    expect(await m.browserAccessToken()).toBe(ANON);
  });

  it("a valid token is reused without asking the server again", async () => {
    const m = await load();
    fetchMock.mockResolvedValueOnce(ok("tok-A"));
    await m.browserAccessToken();
    vi.setSystemTime(NOW + 60_000);
    expect(await m.browserAccessToken()).toBe("tok-A");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
