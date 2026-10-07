/**
 * /api/leads/indiamart (S34) — the key goes in, and never comes back out.
 *
 * The screen /marketing/indiamart is the first caller of this route, so these pin what it
 * relies on: GET says saved / encrypted / last 4 and the pull numbers, and no response body
 * ever contains the key; POST seals it; DELETE clears it; only the owner gets in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// R-051: who createAdminClientFor() was opened for (the audit log actor).
const actors = vi.hoisted(() => [] as string[]);
import type { NextRequest } from "next/server";

const KEY = "SYNTHETIC-IM-KEY-0123456789-wxyz";
const MASTER = Buffer.alloc(32, 7).toString("base64");

const state = vi.hoisted(() => ({
  role: "owner" as string,
  stored: null as string | null,
  sync: null as Record<string, unknown> | null,
  importCount: 0 as number | null,
  upserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  eqs: [] as [string, string, unknown][],
}));

vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "owner@example.invalid" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: "T1", role: state.role }, error: null }) }) }) }),
  }),
  createAdminClientFor: (actor: string) => (actors.push(actor), {
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          state.eqs.push([table, col, v]);
          if (table === "indiamart_lead_imports") return Promise.resolve({ count: state.importCount, error: state.importCount === null ? { message: "boom" } : null });
          return b;
        },
        maybeSingle: async () => ({
          data: table === "tenant_secrets" ? (state.stored === null ? null : { indiamart_crm_key: state.stored }) : state.sync,
          error: null,
        }),
        upsert: async (row: Record<string, unknown>) => { state.upserts.push(row); return { error: null }; },
        update: (row: Record<string, unknown>) => { state.updates.push(row); return b; },
      };
      return b;
    },
  }),
}));

import { GET, POST, DELETE } from "./route";
import { sealTenantSecrets } from "@/lib/crypto/tenant-secrets";

const req = (method: string, body?: unknown) =>
  new Request("https://x.invalid/api/leads/indiamart", { method, body: body === undefined ? undefined : JSON.stringify(body) }) as unknown as NextRequest;

let originalMaster: string | undefined;
beforeEach(() => {
  actors.length = 0;
  originalMaster = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = MASTER;
  Object.assign(state, { role: "owner", stored: null, sync: null, importCount: 0, upserts: [], updates: [], eqs: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (originalMaster === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = originalMaster;
  vi.restoreAllMocks();
});

describe("GET", () => {
  it("no key: not configured, nothing to hint at", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(actors).toEqual(["U1"]); // R-051: audit log names the signed-in owner
    expect(await res.json()).toEqual({
      ok: true, configured: false, encrypted: false, key_last4: null,
      last_run_at: null, last_ok: null, last_error: null, last_imported: null, total_imported: 0,
    });
  });

  it("sealed key: saved + encrypted + last 4 only, with the pull numbers — and never the key", async () => {
    state.stored = sealTenantSecrets({ indiamart_crm_key: KEY }).row.indiamart_crm_key;
    state.sync = { last_run_at: "2026-09-29T08:45:00Z", last_ok: true, last_error: null, last_imported: 3 };
    state.importCount = 41;
    const res = await GET(req("GET"));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      configured: true, encrypted: true, key_last4: "wxyz",
      last_run_at: "2026-09-29T08:45:00Z", last_ok: true, last_imported: 3, total_imported: 41,
    });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 8));
    expect(text).not.toContain(state.stored!); // not even the envelope
    // every read is scoped to the caller's tenant (the admin client bypasses RLS)
    for (const t of ["tenant_secrets", "indiamart_sync_state", "indiamart_lead_imports"]) {
      expect(state.eqs).toContainEqual([t, "tenant_id", "T1"]);
    }
  });

  it("key stored in the clear: says so, still shows only the last 4 (the old mask showed the first 4)", async () => {
    state.stored = KEY;
    const text = await (await GET(req("GET"))).text();
    expect(JSON.parse(text)).toMatchObject({ configured: true, encrypted: false, key_last4: "wxyz" });
    expect(text).not.toContain(KEY.slice(0, 4));
  });

  it("a sealed key this server cannot open is still 'saved', with no hint and no raw value", async () => {
    state.stored = sealTenantSecrets({ indiamart_crm_key: KEY }).row.indiamart_crm_key;
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64"); // a different key
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, encrypted: true, key_last4: null });
  });

  it("the total failing to count shows '—' rather than breaking the screen", async () => {
    state.importCount = null;
    expect(await (await GET(req("GET"))).json()).toMatchObject({ ok: true, total_imported: null });
  });

  it("is owner-only, with who to ask", async () => {
    state.role = "manager";
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner se kahiye/);
  });
});

describe("POST", () => {
  it("seals the key before storing it and echoes nothing of it back", async () => {
    const res = await POST(req("POST", { crm_key: `  ${KEY}  ` }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, encrypted: true });
    expect(text).not.toContain(KEY);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].tenant_id).toBe("T1");
    expect(String(state.upserts[0].indiamart_crm_key)).not.toContain(KEY);
  });

  it("refuses a too-short paste with a next step, storing nothing", async () => {
    const res = await POST(req("POST", { crm_key: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/copy the full key from Lead Manager/);
    expect(state.upserts).toEqual([]);
  });

  it("no master key: REFUSES (503 + next step), stores nothing, never echoes the key (R-051)", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    const logs = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    const res = await POST(req("POST", { crm_key: KEY }));
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error).toMatch(/SECRETS_MASTER_KEY[\s\S]*Next step/);
    expect(text).not.toContain(KEY);
    expect(state.upserts).toEqual([]);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(KEY);
  });

  it("is owner-only", async () => {
    state.role = "sales";
    expect((await POST(req("POST", { crm_key: KEY }))).status).toBe(403);
    expect(state.upserts).toEqual([]);
  });
});

describe("DELETE", () => {
  it("clears the key for this tenant only", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(state.updates).toEqual([{ indiamart_crm_key: null }]);
    expect(state.eqs).toContainEqual(["tenant_secrets", "tenant_id", "T1"]);
  });

  it("is owner-only", async () => {
    state.role = "manager";
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect(state.updates).toEqual([]);
  });
});
