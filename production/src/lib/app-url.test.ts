/**
 * R-723 — links and auth redirects never take a caller-chosen host.
 *
 * Attack this pins: sign up as victim@corp.com, call resend-verification with
 * `X-Forwarded-Host: evil.tld` → the verify link in the victim's inbox pointed at evil.tld,
 * so the click handed the token to the attacker. Same for password reset, invites, join
 * requests, quote / invoice links and the auth callback redirect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { allowedHosts, appUrl, authRedirectUrl, isAllowedHost, normalizeHost, trustedOrigin } from "./app-url";
import { isPrismaGenerated } from "@/lib/testing/prisma-generated";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared fresh read cache

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
    if (statSync(p).isDirectory()) { if (!isPrismaGenerated(p)) walk(p, out); } // R-2564: the generated Prisma client is not our code (36 MB)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("R-723 scan — no new raw-host links", () => {
  it("x-forwarded-host is read only by the allowlisted files", () => {
    const root = process.cwd();
    const offenders = walk(join(root, "src"))
      .filter((f) => /["']x-forwarded-host["']/i.test(readSource(f)))
      .map((f) => relative(root, f).split("\\").join("/"))
      .filter((f) => !ALLOWED_READERS.has(f));
    expect(offenders).toEqual([]);
  });
});

/**
 * R-2600 — emailed auth links built in the BROWSER (GoTrue resetPasswordForEmail redirectTo)
 * used `window.location.origin`: whoever opened the page on another host (R-723 browser check:
 * http://[::1]:3001) got that host baked into the reset mail. They now come from the app URL.
 */
describe("R-2600 authRedirectUrl — never the browser's host", () => {
  it("uses NEXT_PUBLIC_APP_URL even when the page was opened on an evil host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in/");
    vi.stubGlobal("window", { location: { origin: "https://evil.tld", host: "evil.tld" } });
    try {
      const url = authRedirectUrl(`/callback?next=${encodeURIComponent("/reset-password")}`);
      expect(url).toBe("https://reselleros.anutech.in/callback?next=%2Freset-password");
      expect(url).not.toContain("evil.tld");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adds the leading slash and fails closed in production without an app URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001");
    expect(authRedirectUrl("callback")).toBe("http://localhost:3001/callback");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => authRedirectUrl("/callback")).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});

/**
 * Scan (R-2600): an auth redirect handed to the auth server (`redirectTo` / `emailRedirectTo`)
 * may not be built from `window.location.origin`. The only exceptions are OAuth sign-ins: that
 * round trip happens in the user's own browser (nothing is mailed), and the PKCE verifier
 * cookie lives on the current origin, so it must come back to the same host.
 */
const OAUTH_BROWSER_ORIGIN = new Set([
  "src/components/features/auth/google-button.tsx",                     // signInWithOAuth
  "src/components/features/contacts/google-contacts-import-dialog.tsx", // signInWithOAuth (contacts scope)
]);

describe("R-2600 scan — no auth redirect from window.location.origin", () => {
  it("redirectTo / emailRedirectTo never use the browser's origin (OAuth listed only)", () => {
    const root = process.cwd();
    const pattern = /(?:emailRedirectTo|redirectTo)\s*:\s*`?\$?\{?\s*window\.location\.origin/;
    const offenders = walk(join(root, "src"))
      .filter((f) => pattern.test(readSource(f)))
      .map((f) => relative(root, f).split("\\").join("/"))
      .filter((f) => !OAUTH_BROWSER_ORIGIN.has(f));
    expect(offenders).toEqual([]);
  });

  it("files that ask for a reset / signup mail never read window.location.origin at all", () => {
    const root = process.cwd();
    const offenders = walk(join(root, "src"))
      .filter((f) => {
        const src = readSource(f);
        return /resetPasswordForEmail\(|emailRedirectTo/.test(src) && /window\.location\.origin/.test(src);
      })
      .map((f) => relative(root, f).split("\\").join("/"));
    expect(offenders).toEqual([]);
  });
});
