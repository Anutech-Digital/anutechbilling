/**
 * R-710: what the middleware answers when the auth server (api.anutech.in) cannot be reached.
 *
 * "Signed out" and "could not check" are different facts. Treating the second as the first
 * bounced signed-in people to /login (a form that needs the same unreachable server), and
 * throwing turned every page — the public homepage too — into a 5xx (9 Oct 2026, 65 × in
 * three minutes).
 *
 *   pass        public pages and session-free APIs (public, webhooks, cron, health): run
 *               as a signed-out visitor; they never needed the session.
 *   retry-page  an app page: a small page that reloads itself in a few seconds.
 *   retry-json  an API that acts on the session: 503 + Retry-After, never a guess.
 */
import { apiNeedsMfaCode } from "@/lib/auth/mfa-gate";

export type AuthOutageVerdict = "pass" | "retry-page" | "retry-json";

export function authOutageVerdict(pathname: string, isProtected: boolean): AuthOutageVerdict {
  if (pathname.startsWith("/api/")) return apiNeedsMfaCode(pathname) ? "retry-json" : "pass";
  return isProtected ? "retry-page" : "pass";
}

export const AUTH_OUTAGE_MESSAGE =
  "We could not check your sign-in just now. Please try again in a few seconds.";

/* Plain inline HTML (no app shell — the shell itself needs the session). Reloads after 5 s. */
export const AUTH_OUTAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>One moment</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#f8fafc;color:#0f172a}
main{max-width:420px;text-align:center}@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}}
a{color:inherit}</style></head>
<body><main><h1 style="font-size:20px">One moment</h1>
<p>${AUTH_OUTAGE_MESSAGE}</p><p>This page will reload by itself. <a href="">Reload now</a></p></main></body></html>`;
