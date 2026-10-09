/**
 * R-524 (9 Oct 2026) — "Try the demo": a READ-ONLY sample workspace, no signup.
 *
 * Pardeep's decision 2A. How it is kept safe — four walls, each enough on its own for its part:
 *
 *  1. DATABASE (the real wall). The visitor login is listed in public.demo_tenants. PostgREST's
 *     db_pre_request (public.demo_pre_request, migration 20261009220000) turns every request of
 *     that login into a READ ONLY transaction, so Postgres refuses every insert, update, delete —
 *     inside RPCs and triggers too. Storage refuses uploads with restrictive policies.
 *  2. FAIL CLOSED. /api/demo/session asks the database (demo_readonly_probe) right after signing
 *     the visitor in, and hands out NO session unless the answer is 'on'.
 *  3. APP ROUTES. The middleware refuses every non-GET request (API routes, server actions) and
 *     every export/download for a demo visitor — that covers routes that write with the
 *     service-role client, send email/WhatsApp, take payments or invite people.
 *  4. ISOLATION. The visitor is an ordinary member of ONE demo tenant; the existing RLS
 *     (current_tenant_id()) keeps every real tenant's rows out of reach.
 *
 * Short-lived: the ros_demo cookie carries an expiry (DEMO_SESSION_MINUTES); after it, or if
 * DEMO_ENABLED is switched off, the middleware signs the visitor out.
 *
 * Owner config: DEMO_ENABLED=1 turns the button on. Default OFF — the homepage then shows no
 * demo button at all.
 */

import { PRODUCT_HOME_ROUTE, siteKindForHost } from "@/site/lib/site-split";

/** The read-only login every visitor shares. `.invalid` = no mail can ever reach it (RFC 2606). */
export const DEMO_VISITOR_EMAIL = "visitor@demo.reselleros.invalid";
/** The login the nightly reset writes the sample data with. Never handed to a visitor. */
export const DEMO_SEEDER_EMAIL = "seeder@demo.reselleros.invalid";
export const DEMO_TENANT_NAME = "Sample Cloud Reseller (demo)";

export const DEMO_COOKIE = "ros_demo";
export const DEMO_SESSION_MINUTES = 60;

/** Per IP: a person exploring opens it once or twice; this stops a script minting sessions. */
export const DEMO_START_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;

export const DEMO_REFUSAL = "This is a demo — sign up to do this.";
/** Header the middleware sets on a refusal, so the UI can show the friendly message. */
export const DEMO_REFUSAL_HEADER = "x-demo-readonly";

export function demoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_ENABLED === "1";
}

interface MaybeUser {
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
}

/** The read-only visitor login? (Email as well as the flag: R-161's Auth.js user has no app_metadata.) */
export function isDemoVisitor(user: MaybeUser | null | undefined): boolean {
  if (!user) return false;
  if (user.app_metadata && user.app_metadata.demo_visitor === true) return true;
  return (user.email ?? "").trim().toLowerCase() === DEMO_VISITOR_EMAIL;
}

/** Cookie value = the expiry in epoch ms. */
export function demoCookieValue(now: number): string {
  return String(now + DEMO_SESSION_MINUTES * 60_000);
}

/** Still inside the demo window? A missing / malformed / past value = expired. */
export function demoCookieLive(value: string | undefined | null, now: number): boolean {
  if (!value || !/^\d{10,16}$/.test(value)) return false;
  const until = Number(value);
  return until > now && until <= now + DEMO_SESSION_MINUTES * 60_000 + 60_000;
}

/** The only writes a demo visitor may make: leaving the demo. */
const DEMO_WRITE_ALLOWED = new Set(["/api/demo/end"]);

/** Reads that still hand data out of the app or cost money — refused like a write. */
const DEMO_GET_REFUSED: RegExp[] = [
  /\/export(s)?(\/|$|\.)/i,
  /\/download(s)?(\/|$)/i,
  /^\/api\/.*\.(csv|xlsx|xls|zip|xml|json)$/i,
  /^\/api\/gst\/verify/i,          // paid GST lookup
  /^\/api\/ai\//i,                  // paid model calls
  /^\/api\/(email|whatsapp|sms)\//i,
  /^\/api\/cron\//i,
];

export type DemoVerdict = "allow" | "refuse";

/** Middleware decision for one request of a demo visitor. Pure — tested in demo-account.test.ts. */
export function demoRequestVerdict(method: string, pathname: string): DemoVerdict {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    return DEMO_WRITE_ALLOWED.has(pathname) ? "allow" : "refuse";
  }
  return DEMO_GET_REFUSED.some((re) => re.test(pathname)) ? "refuse" : "allow";
}

/** Where /api/demo/end may send the visitor afterwards — never an open redirect. */
export function demoExitTarget(next: string | null | undefined): "/signup" | "/" {
  return next === "/signup" ? "/signup" : "/";
}

/** PostgREST's answer when the read-only wall stopped a write (SQLSTATE 25006). */
export function isReadOnlyRefusal(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { code?: unknown; message?: unknown };
  return b.code === "25006" || (typeof b.message === "string" && /read-only transaction/i.test(b.message));
}

/** Public origin for a redirect — the same rule as (auth)/callback: never the container's 0.0.0.0. */
export function publicOrigin(headers: Headers, requestUrl: string): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const proto = headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(requestUrl).origin;
}

/**
 * Where the ResellerOS homepage lives on this host: "/" on reselleros.anutech.in (middleware
 * rewrite), "/reselleros" on staging/local hosts, where "/" is the company page.
 */
export function demoHomePath(host: string | null | undefined): "/" | "/reselleros" {
  return siteKindForHost(host) === "product" ? "/" : PRODUCT_HOME_ROUTE;
}

/** Does this Cookie header carry a Supabase sign-in (sb-<ref>-auth-token, possibly chunked)? */
export function hasAuthCookie(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? "").split(";").some((c) => /^sb-[^=]*-auth-token(\.\d+)?=./.test(c.trim()));
}
