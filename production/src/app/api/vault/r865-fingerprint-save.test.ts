/**
 * R-865 — the owner could not save any vault credential while SECRETS_MASTER_KEY was set.
 *
 * fingerprintPassword() returns a full HMAC-SHA256 hex digest (64 chars); the DB check on
 * vault_passwords.password_fingerprint allowed <= 32, so every insert failed. This test uses
 * the REAL crypto module with a throwaway test key, and the mocked admin client enforces the
 * check exactly as the newest migration that (re)defines it says — so it fails against the
 * old <= 32 rule (baseline.sql) and passes once 20261011100500_r865 widens it to 64.
 * The real-DB half is supabase/tests/r865_vault_fingerprint.test.sql.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONSTRAINT = "vault_passwords_password_fingerprint_check";

/** The max length allowed by the latest definition of the check (migrations, else baseline). */
function dbFingerprintLimit(): number {
  const root = path.resolve(__dirname, "../../../../supabase");
  const migDir = path.join(root, "migrations");
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort().reverse();
  const re = /check\s*\(\s*\(*\s*"?password_fingerprint"?\s+is\s+null\s*\)?\s+or\s+\(*\s*(?:"?char_length"?|"?length"?)\s*\(\s*"?password_fingerprint"?\s*\)\s*<=\s*(\d+)/i;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), "utf8");
    if (!sql.includes(CONSTRAINT)) continue;
    const m = sql.match(re);
    if (m) return Number(m[1]);
  }
  const m = fs.readFileSync(path.join(root, "baseline.sql"), "utf8").match(re);
  if (!m) throw new Error("fingerprint check not found");
  return Number(m[1]);
}

const state = vi.hoisted(() => ({
  limit: 0,
  inserts: [] as { client: "user" | "admin"; row: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => {
  const make = (client: "user" | "admin") => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u@example.invalid" } } }) },
    from: (table: string) => {
      if (table === "users") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: "T1", role: "owner" }, error: null }) }) }) };
      }
      if (table === "vault_passwords") {
        return {
          insert: (row: Record<string, unknown>) => {
            state.inserts.push({ client, row });
            const fp = row.password_fingerprint as string | null;
            const bad = fp !== null && fp !== undefined && fp.length > state.limit;
            return {
              select: () => ({
                single: async () => bad
                  ? { data: null, error: { code: "23514", message: `new row for relation "vault_passwords" violates check constraint "${CONSTRAINT}"` } }
                  : { data: { id: "V9" }, error: null },
              }),
            };
          },
        };
      }
      if (table === "vault_access_log") return { insert: async () => ({ error: null }) };
      throw new Error(`unexpected table ${table}`);
    },
  });
  return {
    createClient: () => make("user"),
    createAdminClientFor: () => make("admin"),
    createAdminClient: () => make("admin"),
  };
});

import { POST as create } from "./route";

const req = (body: unknown) =>
  new Request("https://x.invalid/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = crypto.randomBytes(32).toString("base64"); // throwaway test key
  state.limit = dbFingerprintLimit();
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.SECRETS_MASTER_KEY;
  else process.env.SECRETS_MASTER_KEY = savedKey;
});

describe("R-865 vault create with a master key set", () => {
  it("the DB check allows the real fingerprint length (64 hex)", () => {
    expect(state.limit).toBeGreaterThanOrEqual(64);
  });

  it("owner saves a credential: admin-client insert with a 64-char hex fingerprint, 200", async () => {
    const res = await create(req({ title: "M365 admin", category: "m365_admin", password: "TEST-ONLY-NOT-A-SECRET" }));
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.id).toBe("V9");
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].client).toBe("admin");
    const fp = state.inserts[0].row.password_fingerprint as string;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // never the plaintext anywhere in the row
    expect(JSON.stringify(state.inserts[0].row)).not.toContain("TEST-ONLY-NOT-A-SECRET");
  });
});
