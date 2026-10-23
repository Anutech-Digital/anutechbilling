import { describe, expect, it, vi } from "vitest";

/* R-1010: a sign-in is recorded by the SERVER — user, company, IP (trusted proxy hop), a short
   device summary and the time. The browser can no longer write that row. */

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => { throw new Error("admin client must be injected in these tests"); },
}));

import { deviceSummary, loginRow, recordLogin } from "./login-log";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0";

describe("deviceSummary", () => {
  it("names browser and system, not the raw user-agent", () => {
    expect(deviceSummary(CHROME_WIN)).toBe("Chrome on Windows");
    expect(deviceSummary(EDGE_WIN)).toBe("Edge on Windows");
    expect(deviceSummary(SAFARI_IPHONE)).toBe("Safari on iPhone");
    expect(deviceSummary(CHROME_ANDROID)).toBe("Chrome on Android");
    expect(deviceSummary(FIREFOX_MAC)).toBe("Firefox on Mac");
  });
  it("unknown / empty → a plain word, never the raw string", () => {
    expect(deviceSummary(null)).toBe("Unknown device");
    expect(deviceSummary("")).toBe("Unknown device");
    expect(deviceSummary("curl/8.4.0 <script>")).toBe("Unknown device");
  });
});

const hdrs = (xff: string, ua = CHROME_WIN) => new Headers({ "x-forwarded-for": xff, "user-agent": ua });

describe("loginRow", () => {
  it("one activity_log row: who, which company, IP from the trusted proxy hop, device, time", () => {
    const row = loginRow({
      userId: "u1", tenantId: "t1", headers: hdrs("6.6.6.6, 203.0.113.7"), method: "password",
      signedInAt: "2026-10-23T10:00:00.000Z",
    });
    expect(row).toEqual({
      tenant_id: "t1",
      user_id: "u1",
      action: "login",
      entity: "session",
      entity_id: null,
      label: "Chrome on Windows · IP 203.0.113.7 · password",
      changes: { ip: "203.0.113.7", device: "Chrome on Windows", method: "password", signed_in_at: "2026-10-23T10:00:00.000Z" },
    });
  });
  it("never carries a password, token, cookie or email — only the listed keys", () => {
    const row = loginRow({ userId: "u1", tenantId: "t1", headers: hdrs("203.0.113.7"), method: "google", signedInAt: "x" });
    expect(Object.keys(row.changes).sort()).toEqual(["device", "ip", "method", "signed_in_at"]);
    expect(JSON.stringify(row)).not.toMatch(/password|token|cookie|@/i);
  });
  it("label stays within log_activity's 120 characters", () => {
    const row = loginRow({ userId: "u", tenantId: "t", headers: hdrs("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"), method: "session", signedInAt: "x" });
    expect(row.label.length).toBeLessThanOrEqual(120);
    expect(row.label).toBe("Chrome on Windows · IP 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff");
  });
});

import type { LoginActivityRow, LoginLogStore } from "./login-log";

function fakeAdmin(opts: { user?: { tenant_id: string | null; is_active: boolean } | null; insertError?: { code?: string; message: string } | null }) {
  const inserted: LoginActivityRow[] = [];
  const admin: LoginLogStore = {
    async userOf() {
      return opts.user ?? null;
    },
    async insert(row) {
      if (opts.insertError) return opts.insertError;
      inserted.push(row);
      return null;
    },
  };
  return { admin, inserted };
}

describe("recordLogin", () => {
  it("writes one row with the server's view of the request", async () => {
    const { admin, inserted } = fakeAdmin({ user: { tenant_id: "t1", is_active: true } });
    const r = await recordLogin({ userId: "u1", headers: hdrs("203.0.113.7"), method: "password", signedInAt: "2026-10-23T10:00:00Z" }, admin);
    expect(r).toBe("recorded");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ tenant_id: "t1", user_id: "u1", action: "login", entity: "session" });
  });
  it("a deactivated user or one without a company writes nothing (same rule as log_activity)", async () => {
    for (const user of [null, { tenant_id: null, is_active: true }, { tenant_id: "t1", is_active: false }]) {
      const { admin, inserted } = fakeAdmin({ user });
      expect(await recordLogin({ userId: "u1", headers: hdrs("1.1.1.1"), method: "password" }, admin)).toBe("no-tenant");
      expect(inserted).toHaveLength(0);
    }
  });
  it("the same sign-in twice (23505 on the once-per-sign-in index) is not an error", async () => {
    const { admin } = fakeAdmin({ user: { tenant_id: "t1", is_active: true }, insertError: { code: "23505", message: "dup" } });
    expect(await recordLogin({ userId: "u1", headers: hdrs("1.1.1.1"), method: "session", signedInAt: "x" }, admin)).toBe("duplicate");
  });
  it("never throws — a sign-in must not fail because the log could not be written", async () => {
    const { admin } = fakeAdmin({ user: { tenant_id: "t1", is_active: true }, insertError: { message: "db down" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await recordLogin({ userId: "u1", headers: hdrs("1.1.1.1"), method: "password" }, admin)).toBe("failed");
    expect(await recordLogin({ userId: "u1", headers: null, method: "password" })).toBe("failed"); // real admin client throws here
    warn.mockRestore();
  });
});
