/**
 * R-050 — every API-key route under /api/v1 checks the key's SCOPE, not only that the key exists.
 *
 * Until 7 Oct 2026 no route read `api_keys.scopes`: a key minted to read billing (default
 * scope `{read}`) could also POST /api/v1/telecalling/make-call, which places a paid call in
 * the workspace's name. These tests call the real handlers with a key that lacks the scope and
 * expect a 403 BEFORE the database is touched; a wiring test makes a future route that forgets
 * the gate fail here instead of in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const state = vi.hoisted(() => ({
  scopes: [] as string[],
  dbTouched: 0,
}));

vi.mock("@/lib/api-keys/auth", () => ({
  authenticateApiKey: async () => ({ tenantId: "tenant-1", keyId: "key-1", scopes: state.scopes }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    state.dbTouched += 1;
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (ok: (v: unknown) => unknown) => ok({ data: null, error: null, count: 0 })
            : () => chain,
      },
    );
    return chain;
  },
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET as customers } from "./customers/route";
import { GET as customer } from "./customers/[id]/route";
import { GET as invoices } from "./customers/[id]/invoices/route";
import { GET as payments } from "./customers/[id]/payments/route";
import { GET as quotes } from "./customers/[id]/quotes/route";
import { GET as subscriptions } from "./customers/[id]/subscriptions/route";
import { POST as makeCall } from "./telecalling/make-call/route";
import { resetRateLimiter, MAKE_CALL_PER_KEY } from "@/lib/security/rate-limit";

const req = (path: string, init?: { method?: string; body?: string }) =>
  new NextRequest(`https://ros.invalid${path}`, init);
const params = { params: Promise.resolve({ id: "C-1" }) };

const READ_ROUTES: [string, () => Promise<Response>][] = [
  ["GET /customers", () => customers(req("/api/v1/customers"))],
  ["GET /customers/:id", () => customer(req("/api/v1/customers/C-1"), params)],
  ["GET /customers/:id/invoices", () => invoices(req("/api/v1/customers/C-1/invoices"), params)],
  ["GET /customers/:id/payments", () => payments(req("/api/v1/customers/C-1/payments"), params)],
  ["GET /customers/:id/quotes", () => quotes(req("/api/v1/customers/C-1/quotes"), params)],
  ["GET /customers/:id/subscriptions", () => subscriptions(req("/api/v1/customers/C-1/subscriptions"), params)],
];

const callBody = JSON.stringify({ call_type: "lead_qualification", lead_id: "L-0007" });
const placeCall = () => makeCall(req("/api/v1/telecalling/make-call", { method: "POST", body: callBody }));

beforeEach(() => {
  state.scopes = [];
  state.dbTouched = 0;
});

describe("read routes need the `read` scope", () => {
  for (const [name, call] of READ_ROUTES) {
    it(`${name}: a key without "read" gets 403 insufficient_scope, and no query runs`, async () => {
      state.scopes = ["telecalling"];
      const res = await call();
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("insufficient_scope");
      expect(body.error).toContain('"read"');
      expect(state.dbTouched).toBe(0);
    });

    it(`${name}: a key with "read" is let through the gate`, async () => {
      state.scopes = ["read"];
      const res = await call();
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  }
});

describe("make-call needs the `telecalling` scope", () => {
  it("a default read-only key cannot place a call — 403 before the body is read", async () => {
    state.scopes = ["read"];
    const res = await placeCall();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("insufficient_scope");
    expect(body.error).toContain('"telecalling"');
    expect(state.dbTouched).toBe(0);
  });

  it("a key with no scopes at all is refused too", async () => {
    state.scopes = [];
    expect((await placeCall()).status).toBe(403);
  });
});

describe("make-call is rate limited per KEY (R-050)", () => {
  it(`after ${MAKE_CALL_PER_KEY.limit} requests in the window the same key gets 429 with Retry-After`, async () => {
    resetRateLimiter();
    state.scopes = ["telecalling"];
    for (let i = 0; i < MAKE_CALL_PER_KEY.limit; i++) {
      expect((await placeCall()).status).not.toBe(429);
    }
    const res = await placeCall();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { code: string }).code).toBe("rate_limited");
  });
});

describe("wiring — every API-key route under /api/v1 calls requireScope", () => {
  const root = join(process.cwd(), "src/app/api/v1");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
    });

  it("no route authenticates a key without checking its scope right after", () => {
    const keyRoutes = walk(root).filter((p) => readFileSync(p, "utf8").includes("authenticateApiKey("));
    expect(keyRoutes.length).toBeGreaterThanOrEqual(7);
    const missing = keyRoutes.filter((p) => {
      const src = readFileSync(p, "utf8");
      const auth = src.indexOf("authenticateApiKey(req)");
      const gate = src.indexOf("requireScope(auth,");
      return gate === -1 || gate < auth;
    });
    expect(missing.map((p) => relative(root, p))).toEqual([]);
  });
});
