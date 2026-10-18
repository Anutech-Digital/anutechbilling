/**
 * Where the website's /api/enquiry and /api/agent hand a request to the app (R-1598, 18 Oct 2026).
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Both routes used to `fetch()` `${RESELLEROS_URL}/api/public/...` over the internet.
 * RESELLEROS_URL is NEXT_PUBLIC_RESELLEROS_URL or, unset, the LIVE domain — and no build
 * (Dockerfile, cloudbuild.yaml, cloudbuild.test.yaml) passes that variable. So staging's and
 * the test app's /quote form, /trial form and AI chat filed their leads in the LIVE app.
 * The hop also built a fresh payload with no pageUrl and no Referer, so every /quote and
 * /trial lead lost its gclid / utm_* / source.
 *
 * The website and the app are ONE Next service now (staging, local, and live's combined
 * service), so the default is no hop at all: the public route's own handler is called
 * in-process, on this deployment, with the visitor's headers (Referer, IP, Turnstile token)
 * and the page URL intact.
 *
 * A cross-origin hop happens only when a SERVER-side, runtime variable names a target —
 * RESELLEROS_FORWARD_URL, never a NEXT_PUBLIC_ one (those are frozen into the bundle at
 * build time, which is how this went wrong). And even then, a non-production host is
 * refused a forward to the production origin: a staging misconfiguration must not create
 * live leads, send live alerts or email real customers. Refused → logged loudly and handled
 * locally, so the visitor's request is still recorded somewhere it can be seen.
 */
import { NextRequest } from "next/server";

/** Hostnames served by the LIVE deployment. A forward INTO these from anywhere else is refused. */
export const PRODUCTION_HOSTS: readonly string[] = ["reselleros.anutech.in", "anutech.in", "www.anutech.in"];

/** The only variable that turns on a cross-origin hop. Server-side, read at request time. */
export const FORWARD_ENV = "RESELLEROS_FORWARD_URL";

export type ForwardPlan =
  | { kind: "local" }
  | { kind: "remote"; base: string }
  | { kind: "refused"; reason: string };

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isProductionHost(host: string): boolean {
  return PRODUCTION_HOSTS.includes(host.toLowerCase());
}

/**
 * Decide where a request arriving at `requestUrl` is handled. Pure: the env is passed in so
 * tests can pin it (defaults to process.env, read at call time — never at module load).
 */
export function planForward(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): ForwardPlan {
  const raw = env[FORWARD_ENV]?.trim();
  if (!raw) return { kind: "local" };

  let target: URL;
  try { target = new URL(raw); } catch { return { kind: "refused", reason: `${FORWARD_ENV} is not a URL` }; }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { kind: "refused", reason: `${FORWARD_ENV} must be http(s)` };
  }

  const fromHost = hostOf(requestUrl);
  const toHost = target.hostname.toLowerCase();
  /* Pointing at ourselves is the same service — no hop needed. */
  if (toHost === fromHost) return { kind: "local" };
  if (isProductionHost(toHost) && !isProductionHost(fromHost)) {
    return { kind: "refused", reason: `${fromHost || "this host"} is not production; refusing to forward to ${toHost}` };
  }
  return { kind: "remote", base: target.origin };
}

/** Headers of the visitor's request that the lead handlers read: attribution, rate limits, bot check. */
const PASS_HEADERS = [
  "referer", "user-agent", "accept-language",
  "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "x-forwarded-proto", "x-forwarded-host",
  "x-turnstile-token",
] as const;

export function passThroughHeaders(req: { headers: Headers }): Headers {
  const h = new Headers({ "content-type": "application/json" });
  for (const name of PASS_HEADERS) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

export type LocalHandler = (req: NextRequest) => Promise<Response>;

/**
 * Hand `payload` to the app's public route at `path`: in-process through `local` unless
 * RESELLEROS_FORWARD_URL names another (allowed) deployment.
 */
export async function deliverToApp(opts: {
  req: NextRequest;
  path: string;
  payload: unknown;
  local: LocalHandler;
  timeoutMs: number;
  tag: string;
  env?: Record<string, string | undefined>;
}): Promise<Response> {
  const { req, path, payload, local, timeoutMs, tag } = opts;
  const plan = planForward(req.url, opts.env);
  const headers = passThroughHeaders(req);
  const body = JSON.stringify(payload);

  if (plan.kind === "remote") {
    return fetch(new URL(path, plan.base), {
      method: "POST",
      headers,
      body,
      /* A lead capture that hangs is worse than one that reports failure. */
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  }
  if (plan.kind === "refused") {
    console.error(`[${tag}] FORWARD REFUSED (R-1598): ${plan.reason}. Handling on this deployment instead — fix ${FORWARD_ENV}.`);
  }
  return local(new NextRequest(new URL(path, req.url), { method: "POST", headers, body }));
}

/** A page URL / referrer from the form body, or undefined. Capped like the callback route's schema. */
export function pageField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 1000) : undefined;
}
