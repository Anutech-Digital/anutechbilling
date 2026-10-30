/**
 * R-2113 / GP-03 (30 Oct 2026, G-PERSONAL): account consent rows in consent_events.
 * recordAccountConsent writes one insert-only row per purpose for a USER (tenant may be null at
 * password signup); attachConsentTenant fills tenant_id at the verify step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { recordAccountConsent, attachConsentTenant, accountConsentRows } from "./account-consent.server";

const USER = "aaaaaaaa-0000-4000-8000-000000211301";
const TENANT = "dddddddd-0000-4000-8000-000000211301";
const SECRET = Buffer.alloc(32, 7).toString("base64");

function fakeAdmin(error: { message: string } | null = null) {
  const calls: { table: string; op: string; payload?: unknown; filters: [string, string, unknown][] }[] = [];
  const admin = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, op: "", filters: [] };
      calls.push(call);
      const chain = {
        insert(payload: unknown) { call.op = "insert"; call.payload = payload; return Promise.resolve({ error }); },
        update(payload: unknown) { call.op = "update"; call.payload = payload; return chain; },
        eq(col: string, v: unknown) { call.filters.push(["eq", col, v]); return chain; },
        is(col: string, v: unknown) { call.filters.push(["is", col, v]); return chain; },
        then(res: (v: { error: typeof error }) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve({ error }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return { admin: admin as never, calls };
}

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3001/signup", {
    headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "UA-test", ...headers },
  });
}

describe("GP-03 recordAccountConsent", () => {
  beforeEach(() => vi.stubEnv("SECRETS_MASTER_KEY", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("writes one row per purpose with the version, the user, a null tenant and a 64-hex ip_hash", async () => {
    const { admin, calls } = fakeAdmin();
    const ok = await recordAccountConsent(admin, {
      userId: USER, tenantId: null, version: "2026-10-30",
      purposes: ["account_terms", "personal_finance_processing", { purpose: "marketing", granted: false }],
      req: req(), page: "/signup",
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("consent_events");
    expect(calls[0].op).toBe("insert");
    const rows = calls[0].payload as Record<string, unknown>[];
    expect(rows.map((r) => `${r.purpose}=${r.choice}`)).toEqual([
      "account_terms=granted", "personal_finance_processing=granted", "marketing=denied",
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        user_id: USER, tenant_id: null, anon_id: null, lead_id: null,
        notice_version: "2026-10-30", source: "signup", page: "/signup", user_agent: "UA-test",
      });
      expect(r.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(String(r.ip_hash)).not.toContain("203.0.113.9");
    }
  });

  it("an upgrade carries its tenant and source", () => {
    const rows = accountConsentRows({
      userId: USER, tenantId: TENANT, version: "v2", purposes: ["account_terms"], source: "upgrade",
      ip: null, userAgent: null, secret: SECRET,
    });
    expect(rows).toEqual([expect.objectContaining({ tenant_id: TENANT, source: "upgrade", ip_hash: null })]);
  });

  it("refuses bad input instead of writing a half-proof", () => {
    const base = { userId: USER, tenantId: null, version: "v1", purposes: ["account_terms" as const], ip: null, userAgent: null, secret: SECRET };
    expect(accountConsentRows({ ...base, userId: "not-a-uuid" })).toEqual([]);
    expect(accountConsentRows({ ...base, version: "" })).toEqual([]);
    expect(accountConsentRows({ ...base, purposes: ["newsletter" as never] })).toEqual([]);
    expect(accountConsentRows({ ...base, purposes: [] })).toEqual([]);
  });

  it("a DB error is reported (false), never thrown", async () => {
    const { admin } = fakeAdmin({ message: "boom" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordAccountConsent(admin, { userId: USER, tenantId: null, version: "v1", purposes: ["account_terms"], req: req() })).resolves.toBe(false);
    spy.mockRestore();
  });
});

describe("GP-03 attachConsentTenant", () => {
  it("fills tenant_id on this user's rows that have none", async () => {
    const { admin, calls } = fakeAdmin();
    await expect(attachConsentTenant(admin, USER, TENANT)).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ table: "consent_events", op: "update", payload: { tenant_id: TENANT } });
    expect(calls[0].filters).toEqual([["eq", "user_id", USER], ["is", "tenant_id", null]]);
  });

  it("bad ids → no write", async () => {
    const { admin, calls } = fakeAdmin();
    await expect(attachConsentTenant(admin, "x", TENANT)).resolves.toBe(false);
    await expect(attachConsentTenant(admin, USER, "")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("the migration lets only tenant_id change (DB keeps it insert-only)", () => {
    const sql = readFileSync("supabase/migrations/20261030033952_gp03_consent_account.sql", "utf8");
    expect(sql).toMatch(/grant update \(tenant_id\) on public\.consent_events to service_role/);
    expect(sql).toMatch(/on delete set null/);
  });
});
