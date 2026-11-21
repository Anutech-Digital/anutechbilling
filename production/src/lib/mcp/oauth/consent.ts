/**
 * The authorize request (from Claude) → a consent ticket (signed, 10 min) the consent form posts
 * back. The ticket pins the user who saw the screen and the exact client / redirect / PKCE
 * challenge / state / scope, so the POST cannot be replayed for another user or retargeted.
 */
import "server-only";
import { z } from "zod";
import { CONSENT_TICKET_TTL_SECONDS } from "@/lib/mcp/config";
import { signToken, verifyToken } from "@/lib/mcp/crypto";
import { readClient, redirectUriAllowed, type McpClient } from "./clients";

export interface AuthorizeRequest {
  client: McpClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
}

export type AuthorizeParse =
  | { ok: true; req: AuthorizeRequest }
  /** Client or redirect URI cannot be trusted: show the error, never redirect. */
  | { ok: false; kind: "show"; message: string }
  /** A trusted redirect URI exists: send the error back to the client. */
  | { ok: false; kind: "redirect"; redirectUri: string; error: string; description: string; state: string | null };

export function parseAuthorize(params: Record<string, string | undefined>, secret: string, resourceUrl: string): AuthorizeParse {
  const client = readClient(params.client_id, secret);
  if (!client) return { ok: false, kind: "show", message: "This connection request is not valid (unknown client). Start again from Claude." };
  if (!redirectUriAllowed(client, params.redirect_uri)) {
    return { ok: false, kind: "show", message: "This connection request is not valid (redirect address does not match). Start again from Claude." };
  }
  const redirectUri = params.redirect_uri;
  const state = params.state && params.state.length <= 500 ? params.state : null;
  const back = (error: string, description: string): AuthorizeParse => ({ ok: false, kind: "redirect", redirectUri, error, description, state });
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (params.code_challenge_method !== "S256" || !params.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (params.resource && params.resource.replace(/\/$/, "") !== resourceUrl) return back("invalid_target", "Unknown resource.");
  return { ok: true, req: { client, redirectUri, codeChallenge: params.code_challenge, state, scope: (params.scope ?? "").slice(0, 200) } };
}

const TICKET = z.object({
  u: z.string().uuid(), c: z.string(), r: z.string(), ch: z.string(), st: z.string().nullable(), sc: z.string(), exp: z.number().int(),
});
export type ConsentTicket = z.infer<typeof TICKET>;

export function issueTicket(userId: string, a: AuthorizeRequest, secret: string, nowSec: number): string {
  return signToken("mcpct", { u: userId, c: a.client.clientId, r: a.redirectUri, ch: a.codeChallenge, st: a.state, sc: a.scope, exp: nowSec + CONSENT_TICKET_TTL_SECONDS }, secret);
}

export function readTicket(ticket: string | null, secret: string, nowSec: number): ConsentTicket | null {
  if (!ticket) return null;
  const p = verifyToken("mcpct", ticket, secret);
  const t = TICKET.safeParse(p);
  if (!t.success || t.data.exp < nowSec) return null;
  return t.data;
}

/** redirect_uri + query params, keeping any query the client registered. */
export function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * R-2974: a 200 page on OUR origin that goes on to the client's redirect URI by itself. Meta
 * refresh and script navigation are not form submissions, so `form-action 'self'` does not
 * apply; with scripts off the <noscript> meta refresh goes, else the script — never both (one
 * navigation per one-use code); the link is the fallback. The URI was checked against the
 * client's registered list (https or localhost, no fragment) before it got here.
 */
export function continueTo(target: string, clientName: string): Response {
  const esc = (v: string) => v.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const url = esc(target);
  const name = esc(clientName);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Back to ${name}</title>
<noscript><meta http-equiv="refresh" content="0;url=${url}"></noscript><meta name="robots" content="noindex">
<style>body{font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#b45309}</style></head>
<body><p>Taking you back to ${name}…</p><p><a href="${url}">Continue to ${name}</a> if nothing happens.</p>
<script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
