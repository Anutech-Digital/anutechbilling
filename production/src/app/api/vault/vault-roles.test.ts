/**
 * R-716 — attack test: only owner / manager may reveal or add a vault credential.
 *
 * Before the fix both routes only checked "signed in": a sales / support / accountant login
 * could POST /api/vault/[id]/reveal and get a customer's admin password back in clear text,
 * or POST /api/vault to add one. The DB is mocked here; the RLS half of the fix is proven by
 * supabase/tests/r716_vault_roles.test.sql.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "sales" as string | null,
  vaultCalls: [] as string[],
  logInserts: [] as string[],
  /** R-840: every vault_passwords select, with which client made it and its filters. */
  selects: [] as { client: "user" | "admin"; columns: string; filters: Record<string, string> }[],
  inserts: [] as { client: "user" | "admin"; row: Record<string, unknown> }[],
  adminActor: [] as string[],
  rowTenant: "T1",
  /** R-1896: extra users-row fields (is_active / access_ends_on). */
  userExtra: {} as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/server", () => {
  const make = (client: "user" | "admin") => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u@example.invalid" } } }) },
    from: (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.role ? { tenant_id: "T1", role: state.role, ...state.userExtra } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "vault_passwords") {
        return {
          select: (columns: string) => {
            state.vaultCalls.push("select");
            const filters: Record<string, string> = {};
            state.selects.push({ client, columns, filters });
            const row = {
              id: "V1", tenant_id: state.rowTenant, customer_id: null, title: "Google Admin",
              username_ciphertext: "enc:admin", password_ciphertext: "enc:TEST-ONLY-NOT-A-SECRET",
              notes_ciphertext: null,
            };
            // A user client cannot read ciphertext columns at all (R-840 grants).
            const denied = client === "user" && /ciphertext/.test(columns);
            const result = async () =>
              denied
                ? { data: null, error: { code: "42501", message: "permission denied for table vault_passwords" } }
                : { data: Object.entries(filters).every(([k, v]) => (row as Record<string, unknown>)[k] === v) ? row : null, error: null };
            const chain = {
              eq: (col: string, val: string) => { filters[col] = val; return chain; },
              maybeSingle: result,
            };
            return { ...chain, order: async () => ({ data: [], error: null }) };
          },
          insert: (row: Record<string, unknown>) => {
            state.vaultCalls.push("insert");
            state.inserts.push({ client, row });
            return { select: () => ({ single: async () => ({ data: { id: "V2" }, error: null }) }) };
          },
        };
      }
      if (table === "vault_access_log") {
        return {
          insert: async (row: { action: string }) => {
            state.logInserts.push(row.action);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  });
  return {
    createClient: () => make("user"),
    createAdminClientFor: (actor: string) => { state.adminActor.push(actor); return make("admin"); },
    createAdminClient: () => make("admin"),
  };
});

vi.mock("@/lib/crypto/vault", () => ({
  isVaultConfigured: () => true,
  decryptSecret: (c: string | null) => (c ? c.replace(/^enc:/, "") : null),
  encryptSecret: (p: string) => `enc:${p}`,
  fingerprintPassword: () => "print",
}));

import { POST as reveal } from "./[id]/reveal/route";
import { POST as create, GET as list } from "./route";

const req = (body?: unknown) =>
  new Request("https://x.invalid/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: "V1" }) };

beforeEach(() => {
  state.role = "sales";
  state.vaultCalls = [];
  state.logInserts = [];
  state.selects = [];
  state.inserts = [];
  state.adminActor = [];
  state.rowTenant = "T1";
  state.userExtra = {};
});

describe("R-1896 vault after the last working day", () => {
  it("a manager whose login ended (access_ends_on in the past) gets 403 — nothing decrypted", async () => {
    state.role = "manager";
    state.userExtra = { is_active: true, access_ends_on: "2020-01-31" };
    const res = await reveal(req(), params);
    expect(res.status).toBe(403);
    expect(state.vaultCalls).toEqual([]);
  });
  it("a deactivated owner gets 403", async () => {
    state.role = "owner";
    state.userExtra = { is_active: false };
    expect((await reveal(req(), params)).status).toBe(403);
    expect(state.vaultCalls).toEqual([]);
  });
  it("last working day still ahead → works", async () => {
    state.role = "manager";
    state.userExtra = { is_active: true, access_ends_on: "2099-12-31" };
    expect((await reveal(req(), params)).status).toBe(200);
  });
});

const BLOCKED = ["sales", "sales_senior", "support", "accountant", "billing", "delivery", "partner_agent"];
const ALLOWED = ["owner", "manager"];

describe("R-716 vault reveal", () => {
  for (const role of BLOCKED) {
    it(`${role} gets 403 and nothing is read or decrypted`, async () => {
      state.role = role;
      const res = await reveal(req(), params);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.password).toBeUndefined();
      expect(state.vaultCalls).toEqual([]);
    });
  }

  for (const role of ALLOWED) {
    it(`${role} gets the secret, and the view is logged first`, async () => {
      state.role = role;
      const res = await reveal(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.password).toBe("TEST-ONLY-NOT-A-SECRET");
      expect(state.logInserts).toEqual(["view"]);
    });
  }

  it("a user with no workspace row gets 403", async () => {
    state.role = null;
    expect((await reveal(req(), params)).status).toBe(403);
  });
});

describe("R-716 vault create", () => {
  const entry = { title: "M365 admin", category: "m365_admin", password: "TEST-ONLY-NOT-A-SECRET" };

  for (const role of BLOCKED) {
    it(`${role} gets 403 and nothing is inserted`, async () => {
      state.role = role;
      const res = await create(req(entry));
      expect(res.status).toBe(403);
      expect(state.vaultCalls).toEqual([]);
    });
  }

  for (const role of ALLOWED) {
    it(`${role} can add a credential`, async () => {
      state.role = role;
      const res = await create(req(entry));
      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe("V2");
      expect(state.vaultCalls).toEqual(["insert"]);
      expect(state.logInserts).toEqual(["create"]);
    });
  }
});

describe("R-716 vault list", () => {
  it("sales gets 403 (the list is the vault menu, owner/manager only)", async () => {
    expect((await list()).status).toBe(403);
    expect(state.vaultCalls).toEqual([]);
  });
  it("owner gets the list", async () => {
    state.role = "owner";
    expect((await list()).status).toBe(200);
  });
});

describe("R-840 ciphertext stays on the server", () => {
  it("owner reveal reads the ciphertext with the admin client, pinned to tenant + id; the user client never selects it", async () => {
    state.role = "owner";
    const res = await reveal(req(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).password).toBe("TEST-ONLY-NOT-A-SECRET");
    const ct = state.selects.filter((x) => /ciphertext/.test(x.columns));
    expect(ct.length).toBe(1);
    expect(ct[0].client).toBe("admin");
    expect(ct[0].filters).toEqual({ id: "V1", tenant_id: "T1" });
    expect(state.adminActor).toEqual(["U1"]);
    expect(state.selects.filter((x) => x.client === "user" && /ciphertext/.test(x.columns))).toEqual([]);
    expect(state.logInserts).toEqual(["view"]);
  });

  it("another tenant's id returns 404 and nothing is logged or decrypted", async () => {
    state.role = "owner";
    state.rowTenant = "T2";
    const res = await reveal(req(), params);
    expect(res.status).toBe(404);
    expect((await res.json()).password).toBeUndefined();
    expect(state.logInserts).toEqual([]);
  });

  it("sales still gets 403 and the admin client is never built", async () => {
    state.role = "sales";
    expect((await reveal(req(), params)).status).toBe(403);
    expect(state.adminActor).toEqual([]);
    expect(state.selects).toEqual([]);
  });

  it("create writes the ciphertext with the admin client, tenant from the gate (not the body)", async () => {
    state.role = "manager";
    const res = await create(req({ title: "M365", password: "TEST-ONLY-NOT-A-SECRET", tenant_id: "EVIL" }));
    expect(res.status).toBe(200);
    expect(state.inserts.length).toBe(1);
    expect(state.inserts[0].client).toBe("admin");
    expect(state.inserts[0].row.tenant_id).toBe("T1");
    expect(state.inserts[0].row.password_ciphertext).toBe("enc:TEST-ONLY-NOT-A-SECRET");
  });

  it("the list never selects a ciphertext column", async () => {
    state.role = "owner";
    expect((await list()).status).toBe(200);
    expect(state.selects.every((x) => x.client === "user" && !/ciphertext/.test(x.columns))).toBe(true);
  });
});
