/**
 * R-735: Settings → Integrations → Sandbox saved any api_base (169.254.169.254 too), and the
 * GSTIN route then sent the tenant's key + secret there. Only Sandbox's own hosts are saved now.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const upserts: unknown[] = [];
const client = {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
  from: () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.single = () => Promise.resolve({ data: { tenant_id: "t1", role: "owner" }, error: null });
    q.upsert = (row: unknown) => { upserts.push(row); return Promise.resolve({ error: null }); };
    return q;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client, createAdminClientFor: () => client }));

import { POST } from "./route";

const req = (body: unknown) => ({ json: () => Promise.resolve(body) }) as unknown as Parameters<typeof POST>[0];

beforeEach(() => { upserts.length = 0; });

describe("R-735 — Sandbox base URL allowlist", () => {
  it.each([
    "http://169.254.169.254", "https://169.254.169.254/latest/meta-data", "https://127.0.0.1",
    "https://evil.example.com", "http://api.sandbox.co.in", "https://api.sandbox.co.in.evil.com",
  ])("%s is refused with a next step, nothing saved", async (api_base) => {
    const res = await POST(req({ api_key: "k", api_secret: "s", api_base }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/https:\/\/api\.sandbox\.co\.in/);
    expect(upserts).toEqual([]);
  });

  it.each(["https://api.sandbox.co.in", "https://test-api.sandbox.co.in/"])("%s is saved (no trailing slash)", async (api_base) => {
    const res = await POST(req({ api_key: "k", api_secret: "s", api_base }));
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect((upserts[0] as { sandbox_api_base: string }).sandbox_api_base).toBe(api_base.replace(/\/$/, ""));
  });

  it("no base → the default", async () => {
    await POST(req({ api_key: "k", api_secret: "s" }));
    expect((upserts[0] as { sandbox_api_base: string }).sandbox_api_base).toBe("https://api.sandbox.co.in");
  });
});

/* R-2168: the base follows the key prefix; a saved URL that contradicts it is refused at Save. */
describe("R-2168 — key prefix vs base URL at Save", () => {
  it("live key + test host → refused, clear message, nothing saved, key not echoed", async () => {
    const res = await POST(req({ api_key: "key_live_ABC123", api_secret: "secret_live_XYZ", api_base: "https://test-api.sandbox.co.in" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/live API key/i);
    expect(json.error).toMatch(/https:\/\/api\.sandbox\.co\.in/);
    expect(JSON.stringify(json)).not.toContain("key_live_ABC123");
    expect(JSON.stringify(json)).not.toContain("secret_live_XYZ");
    expect(upserts).toEqual([]);
  });

  it.each([undefined, "", "https://api.sandbox.co.in"])("test key + base %s → saved as the test host", async (api_base) => {
    const res = await POST(req({ api_key: "key_test_ABC", api_secret: "s", api_base }));
    expect(res.status).toBe(200);
    expect((upserts[0] as { sandbox_api_base: string }).sandbox_api_base).toBe("https://test-api.sandbox.co.in");
  });

  it("live key + blank base → the live host", async () => {
    await POST(req({ api_key: "key_live_ABC", api_secret: "s", api_base: "" }));
    expect((upserts[0] as { sandbox_api_base: string }).sandbox_api_base).toBe("https://api.sandbox.co.in");
  });
});
