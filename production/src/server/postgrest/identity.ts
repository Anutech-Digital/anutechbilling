/**
 * Who a gateway request runs as — decided exactly the way PostgREST decided it: from the
 * `Authorization: Bearer <jwt>` header, verified with the same HS256 secret GoTrue signs with
 * (SUPABASE_JWT_SECRET, the value PostgREST has as PGRST_JWT_SECRET today).
 *
 *   role authenticated → { mode: "user", userId: sub, aal }   (aal2 only when the claim says so, R-731)
 *   role anon / no JWT → { mode: "anon" }
 *   role service_role  → { mode: "service" } — ONLY for in-process calls (createAdminClient);
 *                        the public HTTP route refuses it, so the browser can never reach it.
 *
 * An invalid or expired token is a 401, as with PostgREST — never a silent downgrade to anon.
 *
 * ══ ES256 — LOCALHOST ONLY (R-2175, 30 Oct 2026) ════════════════════════════════════════════
 *   What real environments issue (checked in config + deploy docs, not guessed):
 *     staging  AUTH_PROVIDER=authjs + DATA_GATEWAY=1 (supabase/cloudsql/staging/r161-step4-switch-on.sh)
 *              → every session token is minted by server/auth/supabase-jwt.ts: HS256, SUPABASE_JWT_SECRET.
 *     live     the R-909 cutover sets the same two switches (docs/R-909-LIVE-CUTOVER.md §2.1,
 *              scripts/ops/live-env-map.json) → same HS256 mint. Until then live has the gateway
 *              off and the VM's GoTrue (supabase/gotrue:v2.151.0, phase2/docker-compose.yml) signs
 *              HS256 with GOTRUE_JWT_SECRET — no GOTRUE_JWT_KEYS, so no asymmetric key at all.
 *   Only the LOCAL Supabase CLI stack signs sessions ES256 (its own P-256 key; config.toml leaves
 *   signing_keys_path unset). So ES256 is a localhost-only fact and is handled the narrowest way:
 *     · accepted only when scripts/dev-local.mjs passed the local stack's PUBLIC keys in
 *       GATEWAY_LOCAL_JWKS (read once from the local API's /auth/v1/.well-known/jwks.json at
 *       start) AND NEXT_PUBLIC_APP_ENV is "local" AND not on Cloud Run (K_SERVICE unset);
 *     · alg allowlist: HS256 always, ES256 only with those keys — none / RS* / PS* / ES384 /
 *       HS384/512 are refused; the HMAC path never sees an EC key (no alg confusion);
 *     · the key is chosen by `kid` from that fixed set only — never from the token (jwk / jku /
 *       x5u headers are ignored); only EC P-256 public keys are kept, private ones are dropped;
 *     · no network call in the request path (nothing to point at another issuer, no SSRF).
 *   If a real environment ever moves to asymmetric keys, that is a new card: verify via JWKS
 *   from the configured issuer with the same allowlist — do not widen this switch.
 */
import "server-only";
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import type { Identity } from "@/server/db/gateway";
import { PgrstError } from "./parse";

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** A local Supabase CLI signing key, public half only (EC P-256). */
export type LocalJwk = JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string };

let jwksCache: { raw: string | undefined; gate: string; keys: LocalJwk[] } | null = null;

/** Test hook: forget the parsed GATEWAY_LOCAL_JWKS. */
export function __resetLocalJwksCache(): void { jwksCache = null; }

/**
 * The local stack's ES256 public keys — [] unless this is the local app (see the header).
 * Parsed once per env value; junk, private keys and anything not EC P-256 with a kid are dropped.
 */
export function localJwks(): LocalJwk[] {
  const raw = process.env.GATEWAY_LOCAL_JWKS;
  const gate = `${process.env.NEXT_PUBLIC_APP_ENV ?? ""}|${process.env.K_SERVICE ?? ""}`;
  if (jwksCache && jwksCache.raw === raw && jwksCache.gate === gate) return jwksCache.keys;
  let keys: LocalJwk[] = [];
  if (raw && process.env.NEXT_PUBLIC_APP_ENV === "local" && !process.env.K_SERVICE) {
    try {
      const parsed = JSON.parse(raw) as { keys?: unknown };
      const list: unknown[] = Array.isArray(parsed?.keys) ? parsed.keys : [];
      keys = list.flatMap((k): LocalJwk[] => {
        if (!k || typeof k !== "object") return [];
        const j = k as Record<string, unknown>;
        if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string") return [];
        if (typeof j.kid !== "string" || !j.kid) return [];
        if ("d" in j) return [];                                   // a private key has no business here
        if (j.alg !== undefined && j.alg !== "ES256") return [];
        if (j.use !== undefined && j.use !== "sig") return [];
        return [{ kty: "EC", crv: "P-256", x: j.x, y: j.y, kid: j.kid }];
      });
    } catch {
      keys = [];
    }
  }
  jwksCache = { raw, gate, keys };
  return keys;
}

function verifyEs256(h: string, p: string, s: string, kid: unknown): void {
  const fail = () => new PgrstError(401, "PGRST301", "JWT cryptographic operation failed");
  const jwk = typeof kid === "string" ? localJwks().find((k) => k.kid === kid) : undefined;
  if (!jwk) throw fail();
  const sig = b64urlDecode(s);
  if (sig.length !== 64) throw fail();                         // raw r||s for P-256
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw fail();
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
  /* Alg allowlist (R-2175): HS256 always; ES256 only on the local app with the local keys. */
  if (header.alg === "ES256" && localJwks().length > 0) {
    verifyEs256(h, p, s, header.kid);
  } else if (header.alg === "HS256") {
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const given = b64urlDecode(s);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new PgrstError(401, "PGRST301", "JWT cryptographic operation failed");
    }
  } else {
    throw new PgrstError(401, "PGRST301", "Wrong or unsupported encoding algorithm");
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
    return { mode: "user", userId: claims.sub, aal: claims.aal === "aal2" ? "aal2" : "aal1" };
  }
  if (role === "anon") return { mode: "anon" };
  throw new PgrstError(401, "PGRST301", `role "${String(role)}" is not allowed`);
}
