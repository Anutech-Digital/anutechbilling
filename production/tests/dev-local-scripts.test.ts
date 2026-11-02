// R-878: the LOCAL tester scripts refuse anything that is not this laptop's test setup.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// @ts-expect-error — plain .mjs dev script, no types
import { dbUrlLocalReason, appHostLocalReason, testEmailReason, buildLoginLink, parseLoginLinkArgs, safeNextPath } from "../scripts/dev/local-guard.mjs";

const PROD = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a script with a fake NON-local Supabase in env — it must refuse before any network call. */
function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: PROD,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      SUPABASE_URL: "http://127.0.0.1:59999",
      SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("local-guard: database must be local", () => {
  it("accepts the local stack", () => {
    for (const u of [
      "http://127.0.0.1:54321",
      "http://localhost:54321",
      "postgresql://postgres:x@127.0.0.1:54322/postgres",
      "postgresql://postgres:x@host.docker.internal:54322/postgres",
      "http://[::1]:54321",
    ]) expect(dbUrlLocalReason(u)).toBeNull();
  });
  it("refuses staging / live / anything remote or unparseable", () => {
    for (const u of [
      "https://ontpnqjoysjgrlsukecm.supabase.co",
      "postgresql://postgres:x@10.20.0.3:5432/postgres",
      "https://resellersos-staging-abc.a.run.app",
      "http://localhost.evil.com:54321",
      "not a url",
      "",
      undefined,
    ]) expect(dbUrlLocalReason(u)).toMatch(/.+/);
  });
});

describe("local-guard: app host must be local", () => {
  it("accepts localhost, 127.0.0.1 and *.localhost with a port", () => {
    for (const h of ["localhost:3001", "127.0.0.1:3008", "tester1.localhost:3008", "a.b.localhost", "[::1]:3006"]) {
      expect(appHostLocalReason(h)).toBeNull();
    }
  });
  it("refuses real hosts and look-alikes", () => {
    for (const h of [
      "reselleros.anutech.in", "localhost.evil.com:3001", "evil.com/localhost", "user@localhost",
      "staging.example.com:3008", "localhost:99999", "", undefined,
    ]) expect(appHostLocalReason(h)).toMatch(/.+/);
  });
});

describe("local-guard: only @example.test accounts", () => {
  it("accepts the E2E roles", () => {
    for (const e of ["e2e-manager@example.test", "E2E-Owner@Example.Test", "aitest+1@example.test"]) {
      expect(testEmailReason(e)).toBeNull();
    }
  });
  it("refuses real addresses and look-alikes", () => {
    for (const e of [
      "pardeep@anutech.in", "someone@gmail.com", "x@example.test.evil.com", "x@sub.example.test",
      "x@example.testing", "", undefined,
    ]) expect(testEmailReason(e)).toMatch(/.+/);
  });
});

describe("local-guard: the link", () => {
  it("points at the local route on the given host, with a safe next path", () => {
    const link = buildLoginLink({ host: "tester1.localhost:3008", tokenHash: "abc123", email: "E2E-Manager@example.test", next: "//evil.com" });
    const u = new URL(link);
    expect(u.origin).toBe("http://tester1.localhost:3008");
    expect(u.pathname).toBe("/api/dev/login-link");
    expect(u.searchParams.get("email")).toBe("e2e-manager@example.test");
    expect(u.searchParams.get("next")).toBe("/dashboard");
    expect(safeNextPath("/leads")).toBe("/leads");
  });
  it("parses <email> --host --next", () => {
    expect(parseLoginLinkArgs(["e2e-sales@example.test", "--host", "t.localhost:3009", "--next", "/leads"]))
      .toEqual({ email: "e2e-sales@example.test", host: "t.localhost:3009", next: "/leads" });
    expect(parseLoginLinkArgs(["x@example.test"]).host).toBe("localhost:3001");
  });
});

describe("scripts refuse end to end (exit 1, nothing on stdout)", () => {
  it("local-login-link: real email", () => {
    const r = run("scripts/dev/local-login-link.mjs", ["pardeep@anutech.in", "--host", "localhost:3008"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/example\.test/);
  });
  it("local-login-link: non-local host", () => {
    const r = run("scripts/dev/local-login-link.mjs", ["e2e-manager@example.test", "--host", "reselleros.anutech.in"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/not local/);
  });
  it("local-login-link: non-local database", () => {
    const r = run("scripts/dev/local-login-link.mjs", ["e2e-manager@example.test", "--host", "localhost:3008"], {
      SUPABASE_URL: "https://ontpnqjoysjgrlsukecm.supabase.co",
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/not local/);
    expect(r.err).not.toContain("not-a-real-key");
  });
  it("seed-e2e-catalog: non-local database", () => {
    const r = run("scripts/dev/seed-e2e-catalog.mjs", [], { SUPABASE_URL: "postgresql://postgres:x@10.20.0.3:5432/postgres" });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/not local/);
    expect(r.err).not.toContain("not-a-real-key");
  });
  it("seed-e2e-approval (R-2318): non-local database", () => {
    const r = run("scripts/dev/seed-e2e-approval.mjs", [], { SUPABASE_URL: "https://ontpnqjoysjgrlsukecm.supabase.co" });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/not local/);
    expect(r.err).not.toContain("not-a-real-key");
  });
});
