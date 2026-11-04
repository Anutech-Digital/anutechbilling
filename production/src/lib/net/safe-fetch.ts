/**
 * safeFetch — the ONE way the server fetches a URL that someone else chose (R-735, 23 Oct 2026).
 *
 * SSRF: the GSTIN route sent the tenant's Sandbox key + secret to whatever `sandbox_api_base`
 * was saved (the metadata server at 169.254.169.254 included) and returned the answer; Lead
 * Finder opened AI-given URLs and followed redirects anywhere. A URL is fetched here only when:
 *   1. it is https (http only where the caller says so — Lead Finder tries http once),
 *   2. it carries no user:password and its host is not a literal private IP or a local name,
 *   3. its host is on the caller's allowlist, when one is given (Sandbox: two hosts),
 *   4. EVERY address its name resolves to is public (no 10/8, 127/8, 169.254/16, fc00::/7 …),
 *   5. redirects are followed by hand (max 3), each new target re-checked from step 1.
 *
 * Known gap: the check resolves the name, then fetch resolves it again (DNS rebinding between
 * the two is possible in theory). The allowlist closes it for Sandbox; for open URLs (Lead
 * Finder) the response is only parsed for contacts, never handed back to the caller.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SANDBOX_DEFAULT_BASE } from "./sandbox-base";

/** Sandbox.co.in: live and test API hosts (docs.sandbox.co.in). */
export const SANDBOX_HOSTS = ["api.sandbox.co.in", "test-api.sandbox.co.in"] as const;
/* R-2168: the key-prefix helpers live in ./sandbox-base (no node imports — the Settings dialog uses them too). */
export { SANDBOX_DEFAULT_BASE, SANDBOX_TEST_BASE, sandboxKeyKind, sandboxBaseForKey, sandboxKeyBaseProblem } from "./sandbox-base";

export interface UrlPolicy {
  /** Exact host names allowed (lower-case). Omitted = any public host. */
  allowHosts?: readonly string[];
  /** Allow http:// as well as https://. */
  allowHttp?: boolean;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };
export type Lookup = (host: string) => Promise<string[]>;

export class UnsafeUrlError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Refused to fetch ${url.slice(0, 120)}: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/* ─── addresses ─────────────────────────────────────────────────────────── */

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)        // carrier-grade NAT
    || (a === 169 && b === 254)                  // link-local / cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && p[2] === 0)
    || (a === 198 && (b === 18 || b === 19))     // benchmarking
    || a >= 224;                                 // multicast, reserved, broadcast
}

/** "::ffff:7f00:1" → eight 16-bit groups, or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const q = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
  if (all.length !== 8) return null;
  const g = all.map((x) => parseInt(x, 16));
  return g.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : g;
}

export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = isIP(bare);
  if (kind === 4) return v4Private(bare);
  if (kind !== 6) return true; // not an address at all — never "public"
  const g = v6Groups(bare);
  if (!g) return true;
  if (g.every((n) => n === 0)) return true;                                  // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;         // ::1
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return v4Private(embedded()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(embedded());          // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;                                // multicast
  return false;
}

/* ─── URLs ──────────────────────────────────────────────────────────────── */

const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Everything that can be decided without DNS. */
export function checkUrlShape(raw: string, policy: UrlPolicy = {}): UrlCheck {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return { ok: false, reason: policy.allowHttp ? "only http(s) URLs" : "only https URLs" };
  }
  if (url.username || url.password) return { ok: false, reason: "URL must not carry a user name or password" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "no host" };
  if (policy.allowHosts && !policy.allowHosts.includes(host)) {
    return { ok: false, reason: `host ${host} is not allowed` };
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) return { ok: false, reason: "private or local address" };
  } else if (LOCAL_NAME.test(host) || !host.includes(".")) {
    return { ok: false, reason: "local host name" };
  }
  return { ok: true, url };
}

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** checkUrlShape + every resolved address must be public. */
export async function checkUrl(raw: string, policy: UrlPolicy = {}, lookup: Lookup = defaultLookup): Promise<UrlCheck> {
  const shape = checkUrlShape(raw, policy);
  if (!shape.ok) return shape;
  const host = shape.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return shape;
  let addrs: string[];
  try { addrs = await lookup(host); } catch { return { ok: false, reason: `host ${host} does not resolve` }; }
  if (addrs.length === 0) return { ok: false, reason: `host ${host} does not resolve` };
  if (addrs.some(isPrivateAddress)) return { ok: false, reason: `host ${host} points to a private address` };
  return shape;
}

export interface SafeFetchOptions extends UrlPolicy {
  /** Redirects followed by hand, each re-checked. Default 3; 0 = return the 3xx as is. */
  maxRedirects?: number;
  lookup?: Lookup;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** fetch() for a URL someone else chose. Throws UnsafeUrlError instead of fetching an unsafe one. */
export async function safeFetch(raw: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = raw;
  let reqInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const check = await checkUrl(current, opts, opts.lookup);
    if (!check.ok) throw new UnsafeUrlError(current, check.reason);
    const res = await doFetch(check.url.toString(), reqInit);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location || hop >= maxRedirects) return res;
    const method = (reqInit.method ?? "GET").toUpperCase();
    // A redirect re-sends only a body-less GET/HEAD; a POST's 3xx goes back to the caller as is.
    if (method !== "GET" && method !== "HEAD") return res;
    current = new URL(location, check.url).toString();
    reqInit = { ...reqInit };
  }
}

/** Settings → Integrations → Sandbox: null when the base URL may be saved, else a §24 message. */
export function sandboxBaseProblem(raw: string): string | null {
  const check = checkUrlShape(raw.trim(), { allowHosts: SANDBOX_HOSTS });
  if (check.ok) return null;
  return `This API base URL cannot be saved (${check.reason}). Use ${SANDBOX_DEFAULT_BASE} for live keys `
    + `or https://test-api.sandbox.co.in for Sandbox test keys — or clear the field to use the default, then Save.`;
}
