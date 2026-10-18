import { beforeEach, describe, expect, it, vi } from "vitest";

/* R-1548: the Auth.js email+password login had no limit — anyone could guess a password
   forever (POST /api/auth/callback/credentials → authorize() → checkPassword). These tests
   drive the REAL authorize() with a faked account store and the in-memory limiter. */

const PASSWORD = "right-horse-battery";
const accounts = vi.hoisted(() => ({
  lastSignIn: new Map<string, string | null>(),
  checks: 0,
}));

vi.mock("./accounts", () => ({
  checkPassword: vi.fn(async (email: string, password: string) => {
    accounts.checks += 1;
    if (password !== "right-horse-battery") return { ok: false, reason: "invalid_credentials" };
    return { ok: true, user: { id: `id-${email.trim().toLowerCase()}`, email: email.trim().toLowerCase(), user_metadata: {} } };
  }),
  recordSignIn: vi.fn(async (id: string) => {
    accounts.lastSignIn.set(id.replace(/^id-/, ""), `t${accounts.lastSignIn.size}-${Math.random()}`);
  }),
  lastSignInAt: vi.fn(async (email: string) => accounts.lastSignIn.get(email.trim().toLowerCase()) ?? null),
  ensureOAuthUser: vi.fn(),
}));
vi.mock("./mfa", () => ({ hasVerifiedFactor: vi.fn(async () => false), verifyCode: vi.fn(async () => false) }));

import { resetRateLimiter } from "@/lib/security/rate-limit";
import { authConfig } from "./authjs";

type Authorize = (raw: Record<string, unknown>, req: Request) => Promise<unknown>;
const authorize = (authConfig.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;

function req(ip: string): Request {
  return new Request("http://localhost:3001/api/auth/callback/credentials", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

/** The code Auth.js sends back to the login page (CredentialsSignin.code), or "ok". */
async function attempt(email: string, password: string, ip: string): Promise<string> {
  try {
    await authorize({ email, password }, req(ip));
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "thrown";
  }
}

beforeEach(() => {
  resetRateLimiter();
  accounts.lastSignIn.clear();
  accounts.checks = 0;
  delete process.env.RATE_LIMIT_STORE;
});

describe("R-1548 — credentials login is rate limited", () => {
  it("refuses the 11th wrong password for one email even from a NEW IP, without checking it", async () => {
    for (let i = 1; i <= 10; i++) {
      expect(await attempt("owner@shop.in", "guess" + i, `10.0.0.${i}`)).toBe("invalid_credentials");
    }
    const checksBefore = accounts.checks;
    // Different IP, different case/spaces — same account.
    expect(await attempt("  Owner@Shop.in ", "guess-11", "203.0.113.77")).toBe("too_many_attempts");
    // The right password is refused too inside the window — otherwise guessing would continue.
    expect(await attempt("owner@shop.in", PASSWORD, "203.0.113.78")).toBe("too_many_attempts");
    expect(accounts.checks).toBe(checksBefore); // bcrypt never ran for the refused tries
  });

  it("limits one IP across many emails", async () => {
    for (let i = 1; i <= 30; i++) {
      expect(await attempt(`user${i}@shop.in`, "wrong", "198.51.100.9")).toBe("invalid_credentials");
    }
    expect(await attempt("fresh@shop.in", "wrong", "198.51.100.9")).toBe("too_many_attempts");
    // Another IP is not affected.
    expect(await attempt("fresh@shop.in", "wrong", "198.51.100.10")).toBe("invalid_credentials");
  });

  it("a successful login starts the email's count again", async () => {
    for (let i = 1; i <= 9; i++) await attempt("staff@shop.in", "wrong" + i, `10.1.0.${i}`);
    expect(await attempt("staff@shop.in", PASSWORD, "10.1.0.50")).toBe("ok");
    for (let i = 1; i <= 10; i++) {
      expect(await attempt("staff@shop.in", "wrong-again" + i, `10.2.0.${i}`)).toBe("invalid_credentials");
    }
    expect(await attempt("staff@shop.in", "wrong-again-11", "10.2.0.99")).toBe("too_many_attempts");
  });

  it("is time-boxed: after the window the real user can sign in again", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 1; i <= 11; i++) await attempt("boss@shop.in", "x" + i, `10.3.0.${i}`);
      expect(await attempt("boss@shop.in", PASSWORD, "10.9.9.9")).toBe("too_many_attempts");
      vi.advanceTimersByTime(15 * 60_000 + 1000);
      expect(await attempt("boss@shop.in", PASSWORD, "10.9.9.9")).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
