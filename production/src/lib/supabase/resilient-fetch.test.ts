/**
 * R-710: the fetch under every server Supabase client retries a request that never reached
 * api.anutech.in, and only when a retry cannot run a write twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isUnreachableError, networkErrorKind, resilientFetch } from "./resilient-fetch";

function connectTimeout(): TypeError {
  const cause = Object.assign(new Error("Connect Timeout Error (attempted address: api.anutech.in:443, timeout: 10000ms)"), {
    name: "ConnectTimeoutError",
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  return new TypeError("fetch failed", { cause });
}
function socketReset(): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
}
const ok = () => new Response("[]", { status: 200 });
const noSleep = async () => {};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("networkErrorKind", () => {
  it("reads undici's connect timeout from the cause chain", () => {
    expect(networkErrorKind(connectTimeout())).toBe("connect");
  });
  it("reads a socket reset", () => {
    expect(networkErrorKind(socketReset())).toBe("socket");
  });
  it("never treats a caller's abort as retryable", () => {
    expect(networkErrorKind(new DOMException("aborted", "AbortError"))).toBeNull();
  });
  it("ignores ordinary errors", () => {
    expect(networkErrorKind(new Error("boom"))).toBeNull();
  });
});

describe("resilientFetch", () => {
  it("retries a connect timeout once and returns the second answer", async () => {
    const base = vi.fn().mockRejectedValueOnce(connectTimeout()).mockResolvedValueOnce(ok());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep });
    const r = await f("https://api.anutech.in/auth/v1/user", { method: "GET" });
    expect(r.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("retries a WRITE on a connect error (the request never left)", async () => {
    const base = vi.fn().mockRejectedValueOnce(connectTimeout()).mockResolvedValueOnce(ok());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep });
    await f("https://api.anutech.in/rest/v1/leads", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a write after a socket reset (it may have landed)", async () => {
    const base = vi.fn().mockRejectedValue(socketReset());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep });
    await expect(f("https://api.anutech.in/rest/v1/payments", { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("leaves PostgREST reads to postgrest-js's own retry (no 8 × 10 s stacking)", async () => {
    const base = vi.fn().mockRejectedValue(connectTimeout());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep });
    await expect(f("https://api.anutech.in/rest/v1/items?select=name", { method: "GET" })).rejects.toThrow();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured retries and rethrows the network error", async () => {
    const base = vi.fn().mockRejectedValue(connectTimeout());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep, retries: 2 });
    await expect(f("https://api.anutech.in/auth/v1/user")).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("never retries an HTTP answer — the server spoke", async () => {
    const base = vi.fn().mockResolvedValue(new Response("bad", { status: 500 }));
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep });
    const r = await f("https://api.anutech.in/auth/v1/user");
    expect(r.status).toBe(500);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("times out a hung attempt and retries a read", async () => {
    let calls = 0;
    const base = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(ok());
    });
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep, timeoutMs: 20 });
    const r = await f("https://api.anutech.in/auth/v1/user");
    expect(r.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller aborted", async () => {
    const ctl = new AbortController();
    const base = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        ctl.abort();
      }));
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep, timeoutMs: 1000 });
    await expect(f("https://api.anutech.in/auth/v1/user", { signal: ctl.signal })).rejects.toBeDefined();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("never logs the query string", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = vi.fn().mockRejectedValue(connectTimeout());
    const f = resilientFetch({ baseFetch: base as unknown as typeof fetch, sleep: noSleep, retries: 0 });
    await expect(f("https://api.anutech.in/auth/v1/user?email=someone@x.in")).rejects.toThrow();
    expect(err.mock.calls.flat().join(" ")).not.toContain("someone@x.in");
  });
});

describe("isUnreachableError", () => {
  it("recognises postgrest-js's error object for a thrown fetch", () => {
    expect(isUnreachableError({ message: "TypeError: fetch failed", details: "Caused by: ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT)", code: "" })).toBe(true);
  });
  it("recognises auth-js's retryable fetch error", () => {
    expect(isUnreachableError({ name: "AuthRetryableFetchError", message: "fetch failed" })).toBe(true);
  });
  it("does not mistake a database refusal for an outage", () => {
    expect(isUnreachableError({ message: "permission denied for table users", code: "42501" })).toBe(false);
    expect(isUnreachableError(null)).toBe(false);
  });
});
