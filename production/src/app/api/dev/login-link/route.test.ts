// R-878: local-only login link. Every gate → 404; only dev:local on a local host signs in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verifyOtp = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      verifyOtp: (...a: unknown[]) => verifyOtp(...a),
      signOut: (...a: unknown[]) => signOut(...a),
    },
  }),
}));

import { GET } from "./route";
import { loginLinkAllowed, isTestEmail, isTokenHash, hostName } from "./rules";

const HASH = "0123456789abcdef0123456789abcdef";

function req(query: string, host = "tester1.localhost:3008") {
  return new Request(`http://${host}/api/dev/login-link?${query}`, { headers: { host } }) as unknown as Parameters<typeof GET>[0];
}
const q = (email = "e2e-manager@example.test", next = "/dashboard", hash = HASH) =>
  `token_hash=${hash}&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;

beforeEach(() => {
  verifyOtp.mockReset().mockResolvedValue({ data: { user: { email: "e2e-manager@example.test" } }, error: null });
  signOut.mockReset().mockResolvedValue({ error: null });
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "local");
  vi.stubEnv("NODE_ENV", "development");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/dev/login-link — 404 unless every gate passes", () => {
  it("staging / live (APP_ENV not local) → 404, token never checked", async () => {
    for (const env of ["", "staging", "production"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
      expect((await GET(req(q()))).status).toBe(404);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });
  it("a production build → 404", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(req(q()))).status).toBe(404);
  });
  it("a non-local host → 404", async () => {
    for (const h of ["reselleros.anutech.in", "localhost.evil.com:3008", "evil.com"]) {
      expect((await GET(req(q(), h))).status).toBe(404);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("GET /api/dev/login-link — signing in", () => {
  it("valid link → verifies the hash as a magic link and 303s to next on the SAME host", async () => {
    const res = await GET(req(q("e2e-manager@example.test", "/leads")));
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: HASH });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/leads");
  });
  it("an off-site next falls back to /dashboard", async () => {
    const res = await GET(req(q("e2e-manager@example.test", "//evil.com")));
    expect(res.headers.get("location")).toBe("/dashboard");
  });
  it("a real email → 400, token never checked", async () => {
    const res = await GET(req(q("pardeep@anutech.in")));
    expect(res.status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
  it("malformed token → 400", async () => {
    expect((await GET(req(q(undefined, undefined, "x")))).status).toBe(400);
  });
  it("expired / used token → 401", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    expect((await GET(req(q()))).status).toBe(401);
  });
  it("token of a different account → 403 and that fresh session is ended", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { email: "e2e-owner@example.test" } }, error: null });
    expect((await GET(req(q()))).status).toBe(403);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("rules", () => {
  it("local hosts incl. *.localhost; nothing else", () => {
    const ok = (host: string) => loginLinkAllowed({ appEnv: "local", nodeEnv: "development", host });
    expect(ok("localhost:3001")).toBe(true);
    expect(ok("127.0.0.1:3008")).toBe(true);
    expect(ok("[::1]:3008")).toBe(true);
    expect(ok("tester2.localhost:3009")).toBe(true);
    expect(ok("localhost.evil.com")).toBe(false);
    expect(ok("")).toBe(false);
    expect(hostName("[::1]:3001")).toBe("[::1]");
  });
  it("emails and token shapes", () => {
    expect(isTestEmail("e2e-sales@example.test")).toBe(true);
    expect(isTestEmail("a@example.test.com")).toBe(false);
    expect(isTokenHash(HASH)).toBe(true);
    expect(isTokenHash("../../etc")).toBe(false);
  });
});
