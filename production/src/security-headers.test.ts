/**
 * R-738 (23 Oct 2026) — browser security headers.
 *
 *  - HSTS: production answers with Strict-Transport-Security, so after one visit the browser
 *    never tries plain http again (no SSL-strip on the café Wi-Fi). Not in dev — localhost is
 *    http. No includeSubDomains: this app also answers on companies' OWN domains (documents
 *    under the company's domain, middleware), and includeSubDomains there would force https on
 *    every subdomain of a customer's domain that we do not run.
 *  - script-src: production drops 'unsafe-eval'. The only eval the production bundle needs is
 *    WebAssembly (yoga-layout in the PDF renderer, R-365), which 'wasm-unsafe-eval' allows
 *    without letting strings run as JavaScript. Dev keeps 'unsafe-eval' — Next's dev runtime
 *    (React Refresh, eval source maps) needs it.
 *  - 'unsafe-inline' stays for now: see the comment in next.config.mjs (nonce needs every page
 *    rendered dynamically in Next 15).
 *  - The third parties that must keep working are pinned: Razorpay, Turnstile, Google Fonts,
 *    Sentry.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";

type ConfigWithHeaders = {
  headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
};

async function headerList(): Promise<Array<{ key: string; value: string }>> {
  const groups = await (nextConfig as ConfigWithHeaders).headers();
  return groups.flatMap((g) => g.headers);
}

async function directives(): Promise<Map<string, string[]>> {
  const csp = (await headerList()).find((h) => h.key === "Content-Security-Policy");
  if (!csp) throw new Error("no Content-Security-Policy header emitted");
  const map = new Map<string, string[]>();
  for (const d of csp.value.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...sources] = d.split(/\s+/);
    map.set(name, sources);
  }
  return map;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("HSTS (R-738)", () => {
  it("production sends Strict-Transport-Security for a year, without includeSubDomains/preload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const hsts = (await headerList()).find((h) => h.key === "Strict-Transport-Security");
    expect(hsts?.value).toBe("max-age=31536000");
  });

  it("dev (http://localhost) does not send it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await headerList()).find((h) => h.key === "Strict-Transport-Security")).toBeUndefined();
  });
});

describe("CSP script-src (R-738)", () => {
  it("production: no 'unsafe-eval'; WebAssembly only via 'wasm-unsafe-eval'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const script = (await directives()).get("script-src") ?? [];
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).toContain("'wasm-unsafe-eval'");
  });

  it("dev keeps 'unsafe-eval' (Next's dev runtime needs it)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await directives()).get("script-src")).toContain("'unsafe-eval'");
  });

  it("Razorpay, Turnstile, Google Fonts and Sentry stay allowed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const d = await directives();
    expect(d.get("script-src")).toEqual(expect.arrayContaining(["https://checkout.razorpay.com", "https://challenges.cloudflare.com"]));
    expect(d.get("frame-src")).toEqual(expect.arrayContaining(["https://api.razorpay.com", "https://checkout.razorpay.com", "https://challenges.cloudflare.com"]));
    expect(d.get("style-src")).toContain("https://fonts.googleapis.com");
    expect(d.get("font-src")).toContain("https://fonts.gstatic.com");
    expect(d.get("connect-src")).toEqual(expect.arrayContaining(["https://api.razorpay.com", "https://*.ingest.sentry.io"]));
  });
});
