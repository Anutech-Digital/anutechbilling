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
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u@example.invalid" } } }) },
    from: (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.role ? { tenant_id: "T1", role: state.role } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "vault_passwords") {
        return {
          select: () => {
            state.vaultCalls.push("select");
            return {
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "V1", tenant_id: "T1", customer_id: null, title: "Google Admin",
                    username_ciphertext: "enc:admin", password_ciphertext: "enc:TEST-ONLY-NOT-A-SECRET",
                    notes_ciphertext: null,
                  },
                  error: null,
                }),
              }),
              order: async () => ({ data: [], error: null }),
            };
          },
          insert: () => {
            state.vaultCalls.push("insert");
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
  }),
}));

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
