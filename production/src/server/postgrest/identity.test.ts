import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { identityFromHeaders, verifyJwt, localJwks, __resetLocalJwksCache } from "./identity";

const SECRET = "unit-test-secret-at-least-32-characters!!";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims: Record<string, unknown>, opts: { alg?: string; secret?: string } = {}): string {
  const h = b64({ alg: opts.alg ?? "HS256", typ: "JWT" });
  const p = b64(claims);
  const s = createHmac("sha256", opts.secret ?? SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
const bearer = (t: string) => new Headers({ authorization: `Bearer ${t}` });
const USER = "8b14edad-578d-4fca-8f9a-747c6276177a";

beforeEach(() => { process.env.SUPABASE_JWT_SECRET = SECRET; });
afterEach(() => { delete process.env.SUPABASE_JWT_SECRET; });

describe("who a gateway request runs as", () => {
  test("no token → anon", () => {
    expect(identityFromHeaders(new Headers(), { allowService: false })).toEqual({ mode: "anon" });
  });

  test("a valid signed-in token → that user", () => {
    expect(identityFromHeaders(bearer(sign({ role: "authenticated", sub: USER })), { allowService: false }))
      .toEqual({ mode: "user", userId: USER, aal: "aal1" });
  });

  test("the aal claim travels with the identity (R-731): aal2 only when the token says so", () => {
    expect(identityFromHeaders(bearer(sign({ role: "authenticated", sub: USER, aal: "aal2" })), { allowService: false }))
      .toEqual({ mode: "user", userId: USER, aal: "aal2" });
    expect(identityFromHeaders(bearer(sign({ role: "authenticated", sub: USER, aal: "AAL2" })), { allowService: false }))
      .toEqual({ mode: "user", userId: USER, aal: "aal1" });
  });

  test("the anon key → anon", () => {
    expect(identityFromHeaders(bearer(sign({ role: "anon" })), { allowService: false })).toEqual({ mode: "anon" });
  });

  test("the service-role key is refused over HTTP, accepted in-process", () => {
    const t = sign({ role: "service_role" });
    expect(() => identityFromHeaders(bearer(t), { allowService: false })).toThrow(/not accepted over HTTP/);
    expect(identityFromHeaders(bearer(t), { allowService: true })).toEqual({ mode: "service" });
  });

  test("a token signed with another secret is a 401, not anon", () => {
    expect(() => identityFromHeaders(bearer(sign({ role: "authenticated", sub: USER }, { secret: "x".repeat(40) })), { allowService: false }))
      .toThrow(/cryptographic/);
  });

  test("alg=none and other algorithms are refused", () => {
    const h = b64({ alg: "none", typ: "JWT" });
    const p = b64({ role: "service_role" });
    expect(() => verifyJwt(`${h}.${p}.`, SECRET)).toThrow(/algorithm/);
    expect(() => verifyJwt(sign({ role: "anon" }, { alg: "HS512" }), SECRET)).toThrow(/algorithm/);
  });

  test("an expired token is refused", () => {
    expect(() => verifyJwt(sign({ role: "anon", exp: 1000 }), SECRET)).toThrow(/expired/);
  });

  test("a tampered payload (role raised to service_role) fails the signature", () => {
    const [h, , s] = sign({ role: "authenticated", sub: USER }).split(".");
    expect(() => verifyJwt(`${h}.${b64({ role: "service_role" })}.${s}`, SECRET)).toThrow(/cryptographic/);
  });

  test("an unknown role is refused", () => {
    expect(() => identityFromHeaders(bearer(sign({ role: "postgres" })), { allowService: true })).toThrow(/not allowed/);
  });
});

/* ══ R-2175: local Supabase CLI session tokens are ES256 ═══════════════════════════════════════
 * Staging and live never issue ES256: there the gateway runs with AUTH_PROVIDER=authjs and every
 * session token is minted by server/auth/supabase-jwt.ts as HS256 with SUPABASE_JWT_SECRET (the
 * old live VM's GoTrue v2.151.0 signs HS256 with GOTRUE_JWT_SECRET and has no signing keys). The
 * local Supabase CLI stack signs sessions ES256 with its own key. So ES256 is accepted ONLY when
 * scripts/dev-local.mjs hands the local stack's PUBLIC keys over (GATEWAY_LOCAL_JWKS) AND the app
 * runs as the local app (NEXT_PUBLIC_APP_ENV=local, not on Cloud Run) — anywhere else it is the
 * same 401 as before. No network call in the request path, no key taken from the token. */

describe("ES256 on localhost only (R-2175)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-1", alg: "ES256", use: "sig" };
  const otherJwk = { ...other.publicKey.export({ format: "jwk" }), kid: "local-1", alg: "ES256", use: "sig" };

  function es256(claims: Record<string, unknown>, opts: { kid?: string | null; key?: typeof privateKey; alg?: string } = {}) {
    const header: Record<string, unknown> = { alg: opts.alg ?? "ES256", typ: "JWT" };
    if (opts.kid !== null) header.kid = opts.kid ?? "local-1";
    const h = b64(header);
    const p = b64(claims);
    const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), { key: opts.key ?? privateKey, dsaEncoding: "ieee-p1363" });
    return `${h}.${p}.${sig.toString("base64url")}`;
  }
  const keys = { keys: [jwk] };

  const saved = { ...process.env };
  function localEnv(jwks: unknown = keys) {
    process.env.NEXT_PUBLIC_APP_ENV = "local";
    process.env.GATEWAY_LOCAL_JWKS = JSON.stringify(jwks);
    delete process.env.K_SERVICE;
    __resetLocalJwksCache();
  }
  afterEach(() => {
    for (const k of ["NEXT_PUBLIC_APP_ENV", "GATEWAY_LOCAL_JWKS", "K_SERVICE"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    __resetLocalJwksCache();
  });

  test("a local ES256 session token → that user (dev:local)", () => {
    localEnv();
    expect(identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER, aal: "aal1" })), { allowService: false }))
      .toEqual({ mode: "user", userId: USER, aal: "aal1" });
  });

  test("HS256 still works next to it (anon key, Auth.js-minted tokens)", () => {
    localEnv();
    expect(identityFromHeaders(bearer(sign({ role: "anon" })), { allowService: false })).toEqual({ mode: "anon" });
  });

  test("without the local keys (staging / live / plain npm run dev) ES256 stays a 401", () => {
    __resetLocalJwksCache();
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER })), { allowService: false }))
      .toThrow(/algorithm/);
  });

  test("keys present but the app is not the local app → ignored (401)", () => {
    localEnv();
    process.env.NEXT_PUBLIC_APP_ENV = "staging";
    __resetLocalJwksCache();
    expect(localJwks()).toEqual([]);
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER })), { allowService: false }))
      .toThrow(/algorithm/);
  });

  test("keys present on Cloud Run (K_SERVICE) → ignored (401), even if APP_ENV says local", () => {
    localEnv();
    process.env.K_SERVICE = "resellersos-staging";
    __resetLocalJwksCache();
    expect(localJwks()).toEqual([]);
  });

  test("signed by another key with the same kid → 401", () => {
    localEnv({ keys: [otherJwk] });
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER })), { allowService: false }))
      .toThrow(/cryptographic/);
  });

  test("a kid that is not in the local set, or no kid → 401", () => {
    localEnv();
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER }, { kid: "nope" })), { allowService: false }))
      .toThrow(/cryptographic|key/);
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER }, { kid: null })), { allowService: false }))
      .toThrow(/cryptographic|key/);
  });

  test("tampered payload (role raised to service_role) → 401", () => {
    localEnv();
    const [h, , s] = es256({ role: "authenticated", sub: USER }).split(".");
    expect(() => identityFromHeaders(bearer(`${h}.${b64({ role: "service_role" })}.${s}`), { allowService: true }))
      .toThrow(/cryptographic/);
  });

  test("alg none / RS256 / ES384 / HS512 are refused even with local keys", () => {
    localEnv();
    const p = b64({ role: "service_role" });
    expect(() => verifyJwt(`${b64({ alg: "none", typ: "JWT" })}.${p}.`, SECRET)).toThrow(/algorithm/);
    for (const alg of ["RS256", "ES384", "HS512", "PS256", "ES256K"]) {
      expect(() => verifyJwt(`${b64({ alg, kid: "local-1" })}.${p}.AAAA`, SECRET)).toThrow(/algorithm/);
    }
  });

  test("an HS256 header cannot be checked against the EC public key (alg confusion) → 401", () => {
    localEnv();
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const h = b64({ alg: "HS256", kid: "local-1" });
    const p = b64({ role: "service_role" });
    const s = createHmac("sha256", pem).update(`${h}.${p}`).digest("base64url");
    expect(() => verifyJwt(`${h}.${p}.${s}`, SECRET)).toThrow(/cryptographic/);
  });

  test("an expired local token → 401", () => {
    localEnv();
    expect(() => identityFromHeaders(bearer(es256({ role: "authenticated", sub: USER, exp: 1000 })), { allowService: false }))
      .toThrow(/expired/);
  });

  test("a private key, a non-P-256 key or junk in GATEWAY_LOCAL_JWKS is dropped, never used", () => {
    const priv = { ...privateKey.export({ format: "jwk" }), kid: "p", alg: "ES256" };
    const rsa = { kty: "RSA", n: "AQAB", e: "AQAB", kid: "r" };
    const p384 = { ...generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ format: "jwk" }), kid: "q" };
    const hs = { kty: "oct", k: "c2VjcmV0", kid: "o", alg: "HS256" };
    localEnv({ keys: [priv, rsa, p384, hs, jwk] });
    expect(localJwks().map((k) => k.kid)).toEqual(["local-1"]);
    localEnv("not json" as unknown);
    process.env.GATEWAY_LOCAL_JWKS = "not json";
    __resetLocalJwksCache();
    expect(localJwks()).toEqual([]);
  });
});
