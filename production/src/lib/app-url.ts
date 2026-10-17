/**
 * R-723 — the ONE place that decides the public origin for emailed links and auth redirects.
 *
 * THE HOLE IT CLOSES
 *   Verification, password-reset, invite and join links were built from
 *   `x-forwarded-host ?? host`. Both are request headers, so the caller chooses them:
 *   sign up as victim@corp.com, call resend-verification with `X-Forwarded-Host: evil.tld`,
 *   and the victim's "confirm" click hands the token to evil.tld. Same shape for
 *   password reset (account takeover) and every other link that leaves this server.
 *
 * THE RULE
 *   - A request host is used ONLY when it is on the allowlist: the host of
 *     NEXT_PUBLIC_APP_URL (staging's run.app URL on staging, reselleros.anutech.in on live —
 *     baked per trigger), the two public site hosts (site-split.ts), extra hosts in
 *     APP_ALLOWED_HOSTS (comma list, optional), and localhost/127.0.0.1/[::1] outside
 *     production. Everything else falls back to NEXT_PUBLIC_APP_URL.
 *   - `x-forwarded-proto` is not trusted either: non-local hosts are always https.
 *   - Production with NEXT_PUBLIC_APP_URL missing or not a URL → throw (fail closed). The
 *     old fallback chain ended in `new URL(request.url).origin` or "", i.e. dead or
 *     attacker-chosen links.
 *
 * No `server-only` import: middleware and edge code may use it too. Pure + env-only.
 */
import { COMPANY_HOSTS, PRODUCT_HOSTS } from "@/site/lib/site-split";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
/** host[:port] only — letters, digits, dot, dash, brackets for IPv6. Anything else is not a host. */
const HOST_SHAPE = /^[a-z0-9.\-[\]:]+$/;

const DEV_FALLBACK = "http://localhost:3000";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function envOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The canonical public origin (no trailing slash). Production without a valid
 * NEXT_PUBLIC_APP_URL throws rather than guess.
 */
export function appUrl(): string {
  const origin = envOrigin();
  if (origin) return origin;
  if (isProduction()) {
    throw new Error("NEXT_PUBLIC_APP_URL is missing or invalid — refusing to build links from request headers (R-723)");
  }
  return DEV_FALLBACK;
}

/** Normalise a raw Host / X-Forwarded-Host value: first entry, trimmed, lower-case. */
export function normalizeHost(raw: string | null | undefined): string | null {
  const host = (raw ?? "").split(",")[0].trim().toLowerCase();
  if (!host || host.length > 255 || !HOST_SHAPE.test(host)) return null;
  return host;
}

/** Hosts a request may name and still get links on its own host. */
export function allowedHosts(): Set<string> {
  const set = new Set<string>([...PRODUCT_HOSTS, ...COMPANY_HOSTS].map((h) => h.toLowerCase()));
  const env = envOrigin();
  if (env) set.add(new URL(env).host.toLowerCase());
  for (const h of (process.env.APP_ALLOWED_HOSTS ?? "").split(",")) {
    const n = normalizeHost(h);
    if (n) set.add(n);
  }
  return set;
}

export function isAllowedHost(raw: string | null | undefined): boolean {
  const host = normalizeHost(raw);
  if (!host) return false;
  if (!isProduction() && LOCAL_HOST.test(host)) return true;
  return allowedHosts().has(host);
}

/**
 * Public origin for a link or redirect made while answering this request.
 * Uses the request's host only when it is allowlisted; otherwise NEXT_PUBLIC_APP_URL.
 */
export function trustedOrigin(headers: Pick<Headers, "get">): string {
  const host = trustedHost(headers);
  if (!host) return appUrl();
  const env = envOrigin();
  if (env && new URL(env).host.toLowerCase() === host) return env;
  if (LOCAL_HOST.test(host)) {
    return `${headers.get("x-forwarded-proto") === "https" ? "https" : "http"}://${host}`;
  }
  return `https://${host}`;
}

/**
 * The request's host (`x-forwarded-host`, then `host`), normalised — only when it is
 * allowlisted, otherwise null. For code that needs the host itself rather than an origin
 * (R-1468: host-brand picks a logo from it), so it never reads the raw header.
 */
export function trustedHost(headers: Pick<Headers, "get">): string | null {
  for (const raw of [headers.get("x-forwarded-host"), headers.get("host")]) {
    const host = normalizeHost(raw);
    if (host && isAllowedHost(host)) return host;
  }
  return null;
}
