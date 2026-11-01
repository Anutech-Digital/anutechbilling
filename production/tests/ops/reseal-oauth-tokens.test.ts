/**
 * R-2351 — the one-time re-seal of plaintext OAuth / provider tokens
 * (scripts/ops/reseal-oauth-tokens*.mjs). In-memory db fake; fake tokens; no database.
 *
 * Proves: the dry run reports COUNTS only and writes nothing; --apply seals every plain value
 * so the APP (lib/crypto/vault.ts) opens it; already-sealed values are untouched; a missing or
 * WRONG key stops before any write; a row changed meanwhile is skipped, not overwritten; the
 * envelope is byte-compatible with vault.ts both ways; tenant_secrets' list == SECRET_COLUMNS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "@/lib/crypto/vault";
import { SECRET_COLUMNS } from "@/lib/crypto/tenant-secrets";
import * as lib from "../../scripts/ops/reseal-oauth-tokens-lib.mjs";

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER = crypto.randomBytes(32).toString("base64");
const PLAIN_A = "ya29.FAKE-plain-access-r2351";
const PLAIN_R = "1//0gFAKE-plain-refresh-r2351";
const PLAIN_META = "EAAB-FAKE-meta-r2351";

type Row = Record<string, string | null>;
function fakeDb(tables: Record<string, Row[]>) {
  const writes: string[] = [];
  const db = {
    writes,
    tables,
    async hasColumn(t: string, c: string) { return (tables[t] ?? []).length === 0 ? t in tables : c in tables[t][0]; },
    async counts(t: string, c: string) {
      const vals = (tables[t] ?? []).map((r) => r[c]).filter((v): v is string => !!v);
      return { total: vals.length, sealed: vals.filter((v) => v.startsWith("rosv1:")).length };
    },
    async sampleSealed(t: string, c: string, n: number) {
      return (tables[t] ?? []).map((r) => r[c]).filter((v): v is string => !!v && v.startsWith("rosv1:")).slice(0, n);
    },
    async plainBatch(t: string, k: string, c: string, limit: number) {
      return (tables[t] ?? []).filter((r) => r[c] && !r[c]!.startsWith("rosv1:")).slice(0, limit).map((r) => ({ id: r[k], value: r[c] }));
    },
    async updateIf(t: string, k: string, c: string, id: string, old: string, next: string) {
      const row = (tables[t] ?? []).find((r) => r[k] === id);
      if (!row || row[c] !== old) return false;
      row[c] = next; writes.push(`${t}.${c}`);
      return true;
    },
  };
  return db;
}

let saved: string | undefined;
beforeEach(() => { saved = process.env.SECRETS_MASTER_KEY; process.env.SECRETS_MASTER_KEY = KEY; });
afterEach(() => { if (saved === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = saved; });

function world() {
  return fakeDb({
    user_google_tokens: [
      { user_id: "u1", access_token: PLAIN_A, refresh_token: PLAIN_R },
      { user_id: "u2", access_token: null, refresh_token: encryptSecret("1//0gALREADY-sealed") },
    ],
    ad_accounts: [{ id: "a1", access_token: PLAIN_META }],
    tenant_secrets: [{ tenant_id: "t1", ...Object.fromEntries(SECRET_COLUMNS.map((c) => [c, null])), gemini_api_key: "AIza-FAKE-r2351" }],
  });
}
const runIt = async (db: ReturnType<typeof fakeDb>, argv: string[], ...keyArg: (string | undefined)[]) => {
  const key = keyArg.length ? keyArg[0] : KEY;   // an explicit undefined = no key
  const out: string[] = [];
  let code: number;
  try { code = await lib.run({ argv, env: { SECRETS_MASTER_KEY: key }, db, log: (s: string) => out.push(s) }); }
  catch (e) { code = (e as { exitCode?: number }).exitCode ?? 1; out.push(String((e as Error).message)); }
  return { code, text: out.join("\n") };
};
const secretsIn = (s: string) => [PLAIN_A, PLAIN_R, PLAIN_META, "AIza-FAKE-r2351", KEY].filter((v) => s.includes(v));

describe("R-2351 re-seal script", () => {
  it("tenant_secrets list matches SECRET_COLUMNS (no credential left out)", () => {
    const ts = lib.TARGETS.find((t: { table: string }) => t.table === "tenant_secrets");
    expect([...ts.columns].sort()).toEqual([...SECRET_COLUMNS].sort());
  });

  it("envelope is byte-compatible with vault.ts both ways", () => {
    const key = lib.parseMasterKey(KEY);
    expect(decryptSecret(lib.seal(PLAIN_R, key))).toBe(PLAIN_R);
    expect(lib.open(encryptSecret(PLAIN_R), key)).toBe(PLAIN_R);
    expect(lib.parseMasterKey("short")).toBeNull();
    expect(lib.parseMasterKey("")).toBeNull();
  });

  it("dry run: counts per column, no values, nothing written", async () => {
    const db = world();
    const { code, text } = await runIt(db, []);
    expect(code).toBe(0);
    expect(text).toMatch(/user_google_tokens\.access_token: total 1, sealed 0, plain 1/);
    expect(text).toMatch(/user_google_tokens\.refresh_token: total 2, sealed 1, plain 1/);
    expect(text).toMatch(/ad_accounts\.access_token: total 1, sealed 0, plain 1/);
    expect(text).toMatch(/tenant_secrets\.gemini_api_key: total 1, sealed 0, plain 1/);
    expect(text).toMatch(/=> 4 plaintext value\(s\) to seal/);
    expect(text).toMatch(/key check: ok/);
    expect(db.writes).toEqual([]);
    expect(secretsIn(text)).toEqual([]);
  });

  it("dry run works without a key and says it is needed for --apply", async () => {
    const db = world();
    const { code, text } = await runIt(db, [], undefined);
    expect(code).toBe(0);
    expect(text).toMatch(/SECRETS_MASTER_KEY not set/);
    expect(db.writes).toEqual([]);
  });

  it("--apply seals every plain value; the app opens them; sealed ones untouched; 2nd run = 0", async () => {
    const db = world();
    const sealedBefore = db.tables.user_google_tokens[1].refresh_token;
    const { code, text } = await runIt(db, ["--apply", "--confirm=RESEAL"]);
    expect(code).toBe(0);
    const u1 = db.tables.user_google_tokens[0];
    expect(u1.access_token!.startsWith("rosv1:")).toBe(true);
    expect(decryptSecret(u1.access_token)).toBe(PLAIN_A);
    expect(decryptSecret(u1.refresh_token)).toBe(PLAIN_R);
    expect(decryptSecret(db.tables.ad_accounts[0].access_token)).toBe(PLAIN_META);
    expect(decryptSecret(db.tables.tenant_secrets[0].gemini_api_key)).toBe("AIza-FAKE-r2351");
    expect(db.tables.user_google_tokens[1].refresh_token).toBe(sealedBefore);
    expect(text).toMatch(/plaintext left: 0/);
    expect(secretsIn(text)).toEqual([]);
    const again = await runIt(db, ["--apply", "--confirm=RESEAL"]);
    expect(again.text).toMatch(/Nothing to seal/);
    expect(db.writes).toHaveLength(4);
  });

  it("WRONG key → exit 3, clear message, nothing written", async () => {
    const db = world();
    const { code, text } = await runIt(db, ["--apply", "--confirm=RESEAL"], OTHER);
    expect(code).toBe(3);
    expect(text).toMatch(/does not open the tokens already sealed/);
    expect(db.writes).toEqual([]);
    expect(db.tables.user_google_tokens[0].access_token).toBe(PLAIN_A);
  });

  it("missing / short key → exit 2, nothing written", async () => {
    for (const k of [undefined, "", Buffer.alloc(16).toString("base64")]) {
      const db = world();
      const { code, text } = await runIt(db, ["--apply", "--confirm=RESEAL"], k);
      expect(code).toBe(2);
      expect(text).toMatch(/SECRETS_MASTER_KEY is not set/);
      expect(db.writes).toEqual([]);
    }
  });

  it("--apply without --confirm=RESEAL → refused, nothing written", async () => {
    const db = world();
    const { code } = await runIt(db, ["--apply"]);
    expect(code).toBe(2);
    expect(db.writes).toEqual([]);
  });

  it("no envelope anywhere to prove the key → needs --first-seal", async () => {
    const db = fakeDb({ user_google_tokens: [{ user_id: "u1", access_token: PLAIN_A, refresh_token: PLAIN_R }] });
    expect((await runIt(db, ["--apply", "--confirm=RESEAL"])).code).toBe(2);
    expect(db.writes).toEqual([]);
    expect((await runIt(db, ["--apply", "--confirm=RESEAL", "--first-seal"])).code).toBe(0);
    expect(decryptSecret(db.tables.user_google_tokens[0].refresh_token)).toBe(PLAIN_R);
  });

  it("a row the app re-wrote meanwhile is skipped, never overwritten", async () => {
    const db = world();
    const real = db.updateIf.bind(db);
    db.updateIf = async (t, k, c, id, old, next) => {
      if (t === "ad_accounts") { db.tables.ad_accounts[0].access_token = "rosv1:app-wrote-this"; }
      return real(t, k, c, id, old, next);
    };
    const { text } = await runIt(db, ["--apply", "--confirm=RESEAL"]);
    expect(db.tables.ad_accounts[0].access_token).toBe("rosv1:app-wrote-this");
    expect(text).toMatch(/skipped 1 changed meanwhile/);
  });
});
