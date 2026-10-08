/**
 * The CSP's connect-src must name the Supabase origin the browser ACTUALLY talks to —
 * scheme, host and port.
 *
 * ─── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
 * 8 Sep 2026. next.config.mjs derived connect-src as `https://${host}`, taking the host
 * from NEXT_PUBLIC_SUPABASE_URL but hardcoding the scheme. The local stack serves
 * http://127.0.0.1:54321, so the emitted header allowed `https://127.0.0.1:54321` — an
 * origin that does not exist — and the browser refused every client-side Supabase call:
 *
 *     Connecting to 'http://127.0.0.1:54321/auth/v1/token?grant_type=password'
 *     violates the following Content Security Policy directive: connect-src 'self'
 *     https://127.0.0.1:54321 ...
 *
 * The visible symptom was LOGIN THAT FAILS SILENTLY. The fetch throws before leaving the
 * page, react-hook-form gets `TypeError: Failed to fetch`, and nothing renders — no toast,
 * no field error, no server log, because no request was ever sent.
 *
 * The comment on that code said it was derived from the env "so it can never drift from
 * the client again". It drifted anyway, in the one direction the comment did not consider.
 * CSP is matched by ORIGIN, and an origin is scheme + host + port — not host alone.
 *
 * The audit that added the CSP (C1, 1 Sep 2026) shipped it with no test. That is the gap
 * this file closes: a header nobody asserts on is a header that breaks quietly, and this
 * one breaks the login page specifically.
 */
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_URL;

type ConfigWithHeaders = {
  headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
};

/** Return next.config.mjs's connect-src directive for a given Supabase URL.
 *  No module cache-busting needed: headers() reads the env when it is CALLED, which is
 *  the property that makes this testable at all. */
async function connectSrcFor(supabaseUrl: string | undefined): Promise<string> {
  if (supabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;

  const groups = await (nextConfig as ConfigWithHeaders).headers();
  const csp = groups
    .flatMap((g) => g.headers)
    .find((h) => h.key === "Content-Security-Policy");
  if (!csp) throw new Error("no Content-Security-Policy header emitted");
  const directive = csp.value.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  if (!directive) throw new Error(`no connect-src in CSP: ${csp.value}`);
  return directive;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL;
});

describe("CSP connect-src names the real Supabase origin", () => {
  it("allows the http origin for a local stack — the bug that broke login", async () => {
    const d = await connectSrcFor("http://127.0.0.1:54321");
    expect(d).toContain("http://127.0.0.1:54321");
    expect(d).toContain("ws://127.0.0.1:54321");
    /* The precise regression: an https:// entry for a host that only serves http is
       not merely useless, it is what made the header look correct while blocking. */
    expect(d).not.toContain("https://127.0.0.1:54321");
  });

  it("still emits https + wss for a hosted project — prod output is unchanged", async () => {
    const d = await connectSrcFor("https://ontpnqjoysjgrlsukecm.supabase.co");
    expect(d).toContain("https://ontpnqjoysjgrlsukecm.supabase.co");
    expect(d).toContain("wss://ontpnqjoysjgrlsukecm.supabase.co");
    expect(d).not.toContain("http://ontpnqjoysjgrlsukecm.supabase.co");
  });

  it("keeps the *.supabase.co wildcard so a rollback to hosted Supabase works", async () => {
    const d = await connectSrcFor("https://api.anutech.in");
    expect(d).toContain("https://api.anutech.in");
    expect(d).toContain("https://*.supabase.co");
    expect(d).toContain("wss://*.supabase.co");
  });

  it("falls back to the wildcard when the env var is missing or malformed", async () => {
    for (const bad of [undefined, "", "not-a-url"]) {
      const d = await connectSrcFor(bad);
      expect(d).toContain("https://*.supabase.co");
    }
  });

  it("always allows 'self'", async () => {
    const d = await connectSrcFor("http://127.0.0.1:54321");
    expect(d).toContain("'self'");
  });

  /* R-365, 7 Oct 2026: @react-pdf's layout engine (yoga-layout 3) ships its wasm inlined and
     loads it with fetch("data:application/octet-stream;base64,AGFzbQ…"). Without data: in
     connect-src that fetch is refused — yoga then decodes the bytes itself, so the PDF still
     downloads, but every Download PDF printed a CSP violation and AI Help recorded an
     "API FAILED … network error". A data: URL never leaves the browser, so it opens no
     exfiltration path. */
  it("allows data: so the PDF engine can load its inlined wasm", async () => {
    const d = await connectSrcFor("https://api.anutech.in");
    expect(d.split(/\s+/)).toContain("data:");
  });
});

describe("R-365 did not loosen the rest of the CSP", () => {
  async function cspDirectives(): Promise<Map<string, string>> {
    const groups = await (nextConfig as ConfigWithHeaders).headers();
    const csp = groups.flatMap((g) => g.headers).find((h) => h.key === "Content-Security-Policy");
    if (!csp) throw new Error("no Content-Security-Policy header emitted");
    return new Map(
      csp.value.split(";").map((d) => d.trim()).filter(Boolean).map((d): [string, string] => {
        const [name, ...rest] = d.split(/\s+/);
        return [name, rest.join(" ")];
      }),
    );
  }

  it("script-src and default-src gain no data:, blob: or bare *; object-src stays 'none'", async () => {
    const m = await cspDirectives();
    for (const name of ["script-src", "default-src"]) {
      expect(m.get(name) ?? "").not.toMatch(/(^|\s)(data:|blob:|\*)(\s|$)/);
    }
    expect(m.get("object-src")).toBe("'none'");
  });

  it("connect-src gets data: only — no blob: or bare *", async () => {
    expect((await cspDirectives()).get("connect-src") ?? "").not.toMatch(/(^|\s)(blob:|\*)(\s|$)/);
  });
});
