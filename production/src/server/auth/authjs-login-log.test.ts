import { beforeEach, describe, expect, it, vi } from "vitest";

/* R-1010: with Auth.js the SERVER records each sign-in — password (authorize) and Google
   (jwt step) — with the request's headers. A refused password writes nothing. */

const log = vi.hoisted(() => ({ calls: [] as Array<{ userId: string; method: string; ip: string | null; ua: string | null }> }));

vi.mock("./login-log", () => ({
  recordLogin: vi.fn(async (input: { userId: string; method: string; headers: Headers | null | undefined }) => {
    log.calls.push({
      userId: input.userId,
      method: input.method,
      ip: input.headers?.get("x-forwarded-for") ?? null,
      ua: input.headers?.get("user-agent") ?? null,
    });
    return "recorded";
  }),
}));
vi.mock("./accounts", () => ({
  checkPassword: vi.fn(async (email: string, password: string) =>
    password === "right" ? { ok: true, user: { id: "u-pass", email, user_metadata: {} } } : { ok: false, reason: "invalid_credentials" }),
  recordSignIn: vi.fn(async () => {}),
  lastSignInAt: vi.fn(async () => null),
  ensureOAuthUser: vi.fn(async () => ({ ok: true, user: { id: "u-google", email: "g@shop.in" } })),
}));
vi.mock("./mfa", () => ({ hasVerifiedFactor: vi.fn(async () => false), verifyCode: vi.fn(async () => false) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.4", "user-agent": "UA-google" }),
}));

import { resetRateLimiter } from "@/lib/security/rate-limit";
import { authConfig } from "./authjs";

type Authorize = (raw: Record<string, unknown>, req: Request) => Promise<unknown>;
const authorize = (authConfig.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;
type Jwt = (args: Record<string, unknown>) => Promise<unknown>;
const jwt = authConfig.callbacks!.jwt as unknown as Jwt;

const req = () => new Request("http://localhost:3001/api/auth/callback/credentials", {
  method: "POST",
  headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "UA-password" },
});

beforeEach(() => {
  resetRateLimiter();
  log.calls.length = 0;
});

describe("R-1010 — Auth.js records the sign-in server-side", () => {
  it("password sign-in → one row with the request's IP and device", async () => {
    await authorize({ email: "o@shop.in", password: "right" }, req());
    expect(log.calls).toEqual([{ userId: "u-pass", method: "password", ip: "203.0.113.7", ua: "UA-password" }]);
  });

  it("a wrong password records no sign-in", async () => {
    await expect(authorize({ email: "o@shop.in", password: "wrong" }, req())).rejects.toBeTruthy();
    expect(log.calls).toEqual([]);
  });

  it("Google sign-in → one row (headers of the callback request)", async () => {
    await jwt({
      token: {},
      account: { provider: "google", providerAccountId: "sub-1", access_token: "at", expires_at: 1 },
      profile: { email: "g@shop.in", email_verified: true, sub: "sub-1" },
    });
    expect(log.calls).toEqual([{ userId: "u-google", method: "google", ip: "198.51.100.4", ua: "UA-google" }]);
  });

  it("a token refresh / session update is not a sign-in", async () => {
    await jwt({ token: { uid: "u-pass", aal: "aal1" }, trigger: "update", session: { refreshMfa: true } });
    await jwt({ token: { uid: "u-pass", aal: "aal1" } });
    expect(log.calls).toEqual([]);
  });
});
