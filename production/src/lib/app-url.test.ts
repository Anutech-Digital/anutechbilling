/**
 * R-723 — links and auth redirects never take a caller-chosen host.
 *
 * Attack this pins: sign up as victim@corp.com, call resend-verification with
 * `X-Forwarded-Host: evil.tld` → the verify link in the victim's inbox pointed at evil.tld,
 * so the click handed the token to the attacker. Same for password reset, invites, join
 * requests, quote / invoice links and the auth callback redirect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { allowedHosts, appUrl, isAllowedHost, normalizeHost, trustedOrigin } from "./app-url";

function h(init: Record<string, string>): Headers {
  return new Headers(init);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appUrl", () => {
  it("returns NEXT_PUBLIC_APP_URL as a bare origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in/");
    expect(appUrl()).toBe("https://reselleros.anutech.in");
  });

  it("fails closed in production when the env var is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => appUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("fails closed in production when the env var is not a URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "javascript:alert(1)");
    expect(() => appUrl()).toThrow();
  });

  it("falls back to localhost outside production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appUrl()).toBe("http://localhost:3000");
  });
});

describe("trustedOrigin — forged headers", () => {
  const APP = "https://resellersos-staging-njvk4nxhdq-as.a.run.app";

  it.each([
    [{ "x-forwarded-host": "evil.tld" }],
    [{ host: "evil.tld" }],
    [{ host: "evil.tld", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "http" }],
    [{ "x-forwarded-host": "reselleros.anutech.in.evil.tld" }],
    [{ "x-forwarded-host": "evil.tld, reselleros.anutech.in" }],
    [{ "x-forwarded-host": "evil.tld/path" }],
    [{ "x-forwarded-host": "attacker-xyz.a.run.app" }],
    [{ "x-forwarded-host": "localhost-evil.com" }],
    [{}],
  ])("%o → the app URL", (headers) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    expect(trustedOrigin(h(headers))).toBe(APP);
  });

  it("a forged X-Forwarded-Host falls through to the real (allowlisted) Host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    expect(trustedOrigin(h({ host: "reselleros.anutech.in", "x-forwarded-host": "evil.tld" })))
      .toBe("https://reselleros.anutech.in");
  });

  it("in production, localhost is not allowlisted either", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
    expect(trustedOrigin(h({ host: "localhost:3000" }))).toBe("https://reselleros.anutech.in");
  });

  it("never downgrades a real host to http because of x-forwarded-proto", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
    expect(trustedOrigin(h({ "x-forwarded-host": "anutech.in", "x-forwarded-proto": "http" })))
      .toBe("https://anutech.in");
  });

  it("production with no NEXT_PUBLIC_APP_URL throws instead of trusting headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => trustedOrigin(h({ "x-forwarded-host": "evil.tld" }))).toThrow();
  });
});

describe("trustedOrigin — allowlisted hosts are kept", () => {
  it("the app's own host (staging run.app) is used as-is", () => {
    const app = "https://resellersos-staging-njvk4nxhdq-as.a.run.app";
    vi.stubEnv("NEXT_PUBLIC_APP_URL", app);
    expect(trustedOrigin(h({ "x-forwarded-host": new URL(app).host, "x-forwarded-proto": "https" }))).toBe(app);
  });

  it.each(["reselleros.anutech.in", "anutech.in", "www.anutech.in", "ReSellerOS.anutech.IN"])("%s", (host) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
    expect(trustedOrigin(h({ "x-forwarded-host": host }))).toBe(`https://${host.toLowerCase()}`);
  });

  it("APP_ALLOWED_HOSTS adds hosts", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
    vi.stubEnv("APP_ALLOWED_HOSTS", " preview.example.com , ");
    expect(trustedOrigin(h({ host: "preview.example.com" }))).toBe("https://preview.example.com");
    expect(allowedHosts().has("preview.example.com")).toBe(true);
  });

  it("localhost in dev keeps its port and http", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001");
    expect(trustedOrigin(h({ host: "localhost:3001" }))).toBe("http://localhost:3001");
    expect(trustedOrigin(h({ host: "127.0.0.1:3001" }))).toBe("http://127.0.0.1:3001");
  });
});

describe("normalizeHost / isAllowedHost", () => {
  it("rejects junk", () => {
    expect(normalizeHost("evil.tld/x")).toBeNull();
    expect(normalizeHost("a b")).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(isAllowedHost(null)).toBe(false);
  });
});

/**
 * Scan: no route or lib file may build a link from a raw host header again. The only
 * remaining readers map the host to a FIXED origin (site-split: siteKindForHost / sitemapFor /
 * demoHomePath) or log it — they are listed here and may only shrink.
 */
const ALLOWED_READERS = new Set([
  "src/lib/app-url.ts",
  "src/app/(marketing)/page.tsx",          // siteKindForHost → fixed origin
  "src/app/robots.ts",                     // sitemapFor → fixed origin
  "src/app/sitemap.ts",                    // sitemapFor → fixed origin
  "src/middleware.ts",                     // site split + demoHomePath → fixed paths
  "src/app/api/demo/end/route.ts",         // demoHomePath → fixed path
  "src/app/api/public/demo-session/route.ts", // demoHomePath → fixed path
  "src/app/api/attendance/device/_server.ts", // logged only
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("R-723 scan — no new raw-host links", () => {
  it("x-forwarded-host is read only by the allowlisted files", () => {
    const root = process.cwd();
    const offenders = walk(join(root, "src"))
      .filter((f) => /["']x-forwarded-host["']/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).split("\\").join("/"))
      .filter((f) => !ALLOWED_READERS.has(f));
    expect(offenders).toEqual([]);
  });
});
