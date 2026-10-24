import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* R-1010: the browser no longer writes the login row. logLoginOnce only asks the server
   (POST /api/auth/login-event, no body) — once per tab session — and never calls the
   log_activity RPC. */

const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));

import { logLoginOnce } from "./activity";

const store = new Map<string, string>();
const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  store.clear();
  rpc.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("logLoginOnce (R-1010)", () => {
  it("asks the server to record the sign-in — no body, no RPC", async () => {
    await logLoginOnce();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login-event");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("once per tab session", async () => {
    await logLoginOnce();
    await logLoginOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a network failure is swallowed (never breaks the page)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(logLoginOnce()).resolves.toBeUndefined();
  });
});
