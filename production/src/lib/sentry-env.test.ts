import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sentryEnvironment, sentryRelease, serverSentryTags } from "./sentry-env";

/* R-333: staging and live both reported environment "production" (NODE_ENV of any build),
   so a Sentry alert could not tell a staging error from a live one. */

describe("sentryEnvironment", () => {
  it("uses NEXT_PUBLIC_APP_ENV when set", () => {
    expect(sentryEnvironment("staging", "production")).toBe("staging");
    expect(sentryEnvironment("local", "development")).toBe("local");
    expect(sentryEnvironment(" Production ", "production")).toBe("production");
  });

  it("falls back to NODE_ENV only when APP_ENV is unset (the live build ships '')", () => {
    expect(sentryEnvironment("", "production")).toBe("production");
    expect(sentryEnvironment(undefined, "production")).toBe("production");
    expect(sentryEnvironment("  ", "test")).toBe("test");
  });

  it("never returns empty", () => {
    expect(sentryEnvironment(undefined, undefined)).toBe("development");
  });
});

describe("sentryRelease", () => {
  it("is the build commit SHA", () => {
    expect(sentryRelease("65e18727")).toBe("65e18727");
    expect(sentryRelease(" abc1234 ")).toBe("abc1234");
  });

  it("is undefined for the Dockerfile default 'dev' or no SHA", () => {
    expect(sentryRelease("dev")).toBeUndefined();
    expect(sentryRelease("")).toBeUndefined();
    expect(sentryRelease(undefined)).toBeUndefined();
  });
});

describe("serverSentryTags reads the runtime env", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("staging image → staging + its SHA", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    vi.stubEnv("BUILD_SHA", "1a2b3c4");
    expect(serverSentryTags()).toEqual({ environment: "staging", release: "1a2b3c4" });
  });

  it("live image (APP_ENV '') → production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BUILD_SHA", "dev");
    expect(serverSentryTags()).toEqual({ environment: "production", release: undefined });
  });
});

describe("every Sentry init uses it (no init left on NODE_ENV)", () => {
  const ROOT = process.cwd();
  const files = [
    "sentry.client.config.ts",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
    "src/lib/sentry.ts",
    "src/lib/sentry-client.ts",
  ];
  for (const f of files) {
    it(f, () => {
      const code = readFileSync(join(ROOT, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/environment:\s*process\.env\.NODE_ENV/);
      expect(code).toMatch(/sentryEnvironment|serverSentryTags/);
      /* serverSentryTags() carries release itself; the browser inits name it. */
      expect(code).toMatch(/release|serverSentryTags\(\)/);
    });
  }

  it("the DSN route hands the browser the release (BUILD_SHA is runtime-only)", () => {
    const route = readFileSync(join(ROOT, "src/app/api/monitoring/sentry-dsn/route.ts"), "utf8");
    expect(route).toContain("release");
    const boot = readFileSync(join(ROOT, "src/components/shared/sentry-boot.tsx"), "utf8");
    expect(boot).toMatch(/initClientSentry\(json\.dsn,\s*json\.release\)/);
  });
});
