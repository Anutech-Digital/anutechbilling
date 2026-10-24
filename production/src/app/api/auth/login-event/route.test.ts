import { beforeEach, describe, expect, it, vi } from "vitest";

/* R-1010: with GoTrue the password check happens at GoTrue, so this route is the app's first
   server contact after a sign-in. It records the sign-in GoTrue reports (user + last_sign_in_at)
   with the request's IP and device — the browser sends nothing it could fake. */

const st = vi.hoisted(() => ({
  user: null as null | { id: string; last_sign_in_at?: string | null },
  provider: "gotrue" as "gotrue" | "authjs",
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user }, error: null }) } }),
}));
vi.mock("@/server/auth/authjs", () => ({ authProvider: () => st.provider }));
vi.mock("@/server/auth/login-log", () => ({
  recordLogin: vi.fn(async (input: { userId: string; method: string; signedInAt?: string | null; headers: Headers }) => {
    st.calls.push({ userId: input.userId, method: input.method, signedInAt: input.signedInAt, ip: input.headers.get("x-forwarded-for") });
    return "recorded";
  }),
}));

import { POST } from "./route";

const call = (body?: unknown) =>
  POST(new Request("http://localhost:3001/api/auth/login-event", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never);

beforeEach(() => {
  st.user = null;
  st.provider = "gotrue";
  st.calls.length = 0;
});

describe("POST /api/auth/login-event", () => {
  it("not signed in → 401, nothing written", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(st.calls).toEqual([]);
  });

  it("records the sign-in GoTrue reports, keyed on its last_sign_in_at", async () => {
    st.user = { id: "u1", last_sign_in_at: "2026-10-23T10:00:00Z" };
    const res = await call();
    expect(res.status).toBe(200);
    expect(st.calls).toEqual([{ userId: "u1", method: "session", signedInAt: "2026-10-23T10:00:00Z", ip: "203.0.113.7" }]);
  });

  it("ignores anything the browser sends (user id, time, IP in the body)", async () => {
    st.user = { id: "u1", last_sign_in_at: "2026-10-23T10:00:00Z" };
    await call({ userId: "someone-else", signedInAt: "1999-01-01", ip: "1.2.3.4", action: "login" });
    expect(st.calls).toEqual([{ userId: "u1", method: "session", signedInAt: "2026-10-23T10:00:00Z", ip: "203.0.113.7" }]);
  });

  it("no last_sign_in_at → nothing to key the row on, nothing written", async () => {
    st.user = { id: "u1", last_sign_in_at: null };
    expect((await call()).status).toBe(200);
    expect(st.calls).toEqual([]);
  });

  it("Auth.js already recorded the sign-in on the server → no second row", async () => {
    st.provider = "authjs";
    st.user = { id: "u1", last_sign_in_at: "2026-10-23T10:00:00Z" };
    expect((await call()).status).toBe(200);
    expect(st.calls).toEqual([]);
  });
});
