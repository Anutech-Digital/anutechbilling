/**
 * Who a gateway request runs as — decided exactly the way PostgREST decided it: from the
 * `Authorization: Bearer <jwt>` header, verified with the same HS256 secret GoTrue signs with
 * (SUPABASE_JWT_SECRET, the value PostgREST has as PGRST_JWT_SECRET today).
 *
 *   role authenticated → { mode: "user", userId: sub }
 *   role anon / no JWT → { mode: "anon" }
 *   role service_role  → { mode: "service" } — ONLY for in-process calls (createAdminClient);
 *                        the public HTTP route refuses it, so the browser can never reach it.
 *
 * An invalid or expired token is a 401, as with PostgREST — never a silent downgrade to anon.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Identity } from "@/server/db/gateway";
import { PgrstError } from "./parse";

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifyJwt(token: string, secret: string, now = Date.now()): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new PgrstError(401, "PGRST301", "Expected 3 parts in JWT; got " + parts.length);
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"));
    claims = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    throw new PgrstError(401, "PGRST301", "JWT cryptographic operation failed");
  }
  if (header.alg !== "HS256") throw new PgrstError(401, "PGRST301", "Wrong or unsupported encoding algorithm");
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new PgrstError(401, "PGRST301", "JWT cryptographic operation failed");
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) throw new PgrstError(401, "PGRST301", "JWT expired");
  return claims;
}

/** HS256 JWT with the same secret — used for Storage signed URLs, as Supabase Storage does. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

export function identityFromHeaders(headers: Headers, opts: { allowService: boolean }): Identity {
  const auth = headers.get("authorization") ?? "";
  const token = /^bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (!token) return { mode: "anon" };
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new PgrstError(500, "PGRST300", "Server lacks JWT secret");
  const claims = verifyJwt(token, secret);
  const role = claims.role;
  if (role === "service_role") {
    if (!opts.allowService) throw new PgrstError(401, "PGRST301", "service_role is not accepted over HTTP");
    return { mode: "service" };
  }
  if (role === "authenticated") {
    if (typeof claims.sub !== "string") throw new PgrstError(401, "PGRST301", "JWT has no subject");
    return { mode: "user", userId: claims.sub };
  }
  if (role === "anon") return { mode: "anon" };
  throw new PgrstError(401, "PGRST301", `role "${String(role)}" is not allowed`);
}
