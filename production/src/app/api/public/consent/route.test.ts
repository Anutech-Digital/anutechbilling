/**
 * R-2010 (27 Oct 2026, G-DPDP): POST /api/public/consent — the server record of a visitor's
 * cookie choice. Insert-only, the website tenant's row, IP kept only as a keyed hash, rate
 * limited per IP; a malformed body is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ inserts: [] as { table: string; row: Record<string, unknown> }[], error: null as unknown, tenant: "T-WEB" as string | null }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return { error: db.error }; },
      update: () => { throw new Error("consent_events is insert-only"); },
      delete: () => { throw new Error("consent_events is insert-only"); },
    }),
  }),
}));
vi.mock("@/lib/website-tenant", () => ({ websiteTenantId: () => db.tenant }));

import { POST } from "./route";
import { resetRateLimiter } from "@/lib/security/rate-limit";

const ANON = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";
const post = (body: unknown, ip = "1.2.3.4") =>
  POST(new NextRequest("https://x.invalid/api/public/consent", { method: "POST", body: JSON.stringify(body), headers: { "user-agent": "Mozilla/5.0 Test", "x-forwarded-for": ip } }));

beforeEach(() => {
  db.inserts = []; db.error = null; db.tenant = "T-WEB";
  resetRateLimiter();
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("R-2010 consent API", () => {
  it("records the choice for the website tenant: purpose, choice, notice version, UA, hashed IP", async () => {
    const res = await post({ anonId: ANON, choice: "essential", noticeVersion: "2026-10-27", page: "/buy/workspace" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.inserts).toHaveLength(1);
    const { table, row } = db.inserts[0];
    expect(table).toBe("consent_events");
    expect(row).toMatchObject({
      tenant_id: "T-WEB", anon_id: ANON, purpose: "meta_ads", choice: "denied",
      notice_version: "2026-10-27", user_agent: "Mozilla/5.0 Test", page: "/buy/workspace", source: "banner",
    });
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("1.2.3.4");
  });

  it("'all' is stored as granted", async () => {
    await post({ anonId: ANON, choice: "all", noticeVersion: "2026-10-27" });
    expect(db.inserts[0].row.choice).toBe("granted");
  });

  it("the same IP hashes the same way (so repeat visits can be grouped), different IPs differ", async () => {
    await post({ anonId: ANON, choice: "all", noticeVersion: "v" });
    await post({ anonId: ANON, choice: "all", noticeVersion: "v" });
    await post({ anonId: ANON, choice: "all", noticeVersion: "v" }, "9.9.9.9");
    const [a, b, c] = db.inserts.map((i) => i.row.ip_hash);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("a malformed body is refused with 400 and nothing is written", async () => {
    for (const bad of [{ anonId: "x", choice: "all", noticeVersion: "v" }, { anonId: ANON, choice: "maybe", noticeVersion: "v" }, null]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(db.inserts).toEqual([]);
  });

  it("no website tenant → nothing written, still a quiet ok", async () => {
    db.tenant = null;
    expect((await post({ anonId: ANON, choice: "all", noticeVersion: "v" })).status).toBe(200);
    expect(db.inserts).toEqual([]);
  });

  it("is rate limited per IP (429 after 20 in ten minutes)", async () => {
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await post({ anonId: ANON, choice: "all", noticeVersion: "v" }, "7.7.7.7")).status;
    expect(last).toBe(429);
    expect(db.inserts).toHaveLength(20);
  });
});
