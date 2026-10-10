import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { identityFromHeaders, verifyJwt } from "./identity";

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
      .toEqual({ mode: "user", userId: USER });
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
