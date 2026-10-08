// R-281: local-only test login. Every gate → 404; only dev:local on localhost signs in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const signInWithPassword = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a) } }),
}));
/* No .env.test is read in tests — env alone decides. */
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), existsSync: () => false }));

import { POST } from "./route";
import {
  testLoginAllowed, hostName, testLoginCreds, e2eVarsFromEnvText, TEST_LOGIN_ROLES,
} from "./rules";
import { E2E_ROLES, roleCreds } from "../../../../../e2e/fixtures/e2e-roles.mjs";

function req(body: unknown, host = "localhost:3001") {
  return new Request("http://" + host + "/api/dev/test-login", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "local");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("E2E_OWNER_PASSWORD", "x-test-only-x");
  vi.stubEnv("E2E_OWNER_EMAIL", "");
  vi.stubEnv("E2E_SALES_PASSWORD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/dev/test-login — 404 unless every gate passes", () => {
  it("staging / live (APP_ENV not local) → 404", async () => {
    for (const env of ["", "staging", "production"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect((await POST(req({ role: "owner" }))).status).toBe(404);
    }
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("host not localhost → 404", async () => {
    for (const h of ["reselleros.anutech.in", "192.168.1.5:3001", "localhost.evil.com"]) {
      expect((await POST(req({ role: "owner" }, h))).status).toBe(404);
    }
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("NODE_ENV production → 404", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(req({ role: "owner" }))).status).toBe(404);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("local owner → 200, signs in the seeded test account; password never in the response", async () => {
    const res = await POST(req({ role: "owner" }));
    expect(res.status).toBe(200);
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "e2e-owner@example.test", password: "x-test-only-x" });
    expect(await res.text()).not.toContain("x-test-only-x");
  });

  it("works on 127.0.0.1 and [::1] too", async () => {
    expect((await POST(req({ role: "owner" }, "127.0.0.1:3001"))).status).toBe(200);
    expect((await POST(req({ role: "owner" }, "[::1]:3001"))).status).toBe(200);
  });

  it("unknown role (billing, admin, an email) → 400, no sign-in", async () => {
    for (const role of ["billing", "admin", "pardeep@anutech.in", undefined]) {
      expect((await POST(req({ role }))).status).toBe(400);
    }
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("missing password → 412 naming the variable", async () => {
    const res = await POST(req({ role: "sales" }));
    expect(res.status).toBe(412);
    expect((await res.json()).error).toContain("E2E_SALES_PASSWORD");
  });

  it("refuses a non-.test email even if env points at a real account", async () => {
    vi.stubEnv("E2E_OWNER_EMAIL", "pardeep@anutech.in");
    expect((await POST(req({ role: "owner" }))).status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("a failed sign-in → 401", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    expect((await POST(req({ role: "owner" }))).status).toBe(401);
  });
});

describe("rules", () => {
  it("hostName strips the port, keeps IPv6 brackets", () => {
    expect(hostName("localhost:3001")).toBe("localhost");
    expect(hostName("[::1]:3001")).toBe("[::1]");
    expect(hostName(null)).toBe("");
  });
  it("testLoginAllowed needs all three", () => {
    expect(testLoginAllowed({ appEnv: "local", nodeEnv: "development", host: "localhost:3001" })).toBe(true);
    expect(testLoginAllowed({ appEnv: undefined, nodeEnv: "development", host: "localhost" })).toBe(false);
  });
  it("same roles, env names and default emails as e2e-roles.mjs (the seed)", () => {
    expect([...TEST_LOGIN_ROLES].sort()).toEqual([...E2E_ROLES].sort());
    const env = { E2E_MANAGER_EMAIL: "M@Example.test", E2E_MANAGER_PASSWORD: "p1" };
    for (const r of TEST_LOGIN_ROLES) {
      const a = testLoginCreds(r, env), b = roleCreds(r, env);
      expect(a).toEqual({ email: b.email, password: b.password });
    }
  });
  it("reads only E2E_* lines from .env.test text", () => {
    const vars = e2eVarsFromEnvText("SUPABASE_SERVICE_ROLE_KEY=abc\n# E2E_X=1\nE2E_OWNER_PASSWORD=\"q\"\r\nE2E_SALES_EMAIL = s@x.test\n");
    expect(vars).toEqual({ E2E_OWNER_PASSWORD: "q", E2E_SALES_EMAIL: "s@x.test" });
  });
});

describe("no password or env name reaches the login page bundle", () => {
  const dir = join(process.cwd(), "src/app/(auth)/login");
  for (const f of ["page.tsx", "local-test-login.tsx"]) {
    it(f, () => {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/E2E_/);
      expect(src).not.toMatch(/\bpassword\w*\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i);
      expect(src).not.toMatch(/pardeep@anutech\.in/);
    });
  }
  it("the buttons are gated on APP_ENV local + localhost", () => {
    const src = readFileSync(join(dir, "local-test-login.tsx"), "utf8");
    expect(src).toMatch(/appEnv === "local"/);
    expect(src).toMatch(/hostname === "localhost"/);
  });
});
