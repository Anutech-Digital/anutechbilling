/**
 * R-833 (10 Oct 2026) — secret columns stay out of every browser role's reach.
 *
 * What happened: supabase/cloudsql/09-grant-what-policies-allow.sql (run by the staging
 * deploy-db script at step 3b on EVERY run) asked has_table_privilege(), which ignores column
 * grants. On the column-granted tables it saw "no SELECT" and granted TABLE-level SELECT — which
 * overrides every column a migration left out. attendance_settings.presence_secret (the seed of
 * the rotating office code), .ingest_key, employees.pin_hash and ad_accounts.access_token were
 * readable by every signed-in member after each run. Fix: 09 keeps a `secret_cols` denylist and
 * only ever grants columns on those tables; 20261011013300_secret_columns_hidden.sql puts the
 * tables back. This file needs no database:
 *
 *   1. SECRET_COLUMNS here == `secret_cols` in 09.
 *   2. 09's secret-table branch runs before its generic table-level grant and skips it.
 *   3. supabase/tests/secret_columns_hidden.test.sql carries a byte-identical copy of 09's block
 *      (CI never applies cloudsql/ files, so the SQL test runs the copy).
 *   4. Replaying baseline + every migration in file order, no secret table ends with a
 *      table-level SELECT for authenticated/anon, and no column grant names a secret column.
 *   5. Every column whose name looks secret (*secret*, *token*, *_hash, *password*, api_key, …)
 *      is either in SECRET_COLUMNS or in REVIEWED_NOT_SECRET with a written reason. A new one
 *      fails here until someone decides which.
 *
 * The SQL proof (as authenticated: permission denied on the secrets, normal columns readable,
 * still true after 09 runs again) is supabase/tests/secret_columns_hidden.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const NINE = "supabase/cloudsql/09-grant-what-policies-allow.sql";
const SQL_TEST = "supabase/tests/secret_columns_hidden.test.sql";
const MIG_DIR = "supabase/migrations";
const BASELINE = "supabase/baseline.sql";

/** table.column that no browser role (authenticated / anon) may read. Same list as 09. */
const SECRET_COLUMNS = [
  "attendance_settings.presence_secret",
  "attendance_settings.ingest_key",
  "employees.pin_hash",
  "ad_accounts.access_token",
  "user_google_tokens.access_token",
  "user_google_tokens.refresh_token",
  "user_google_tokens.sync_token",
  "email_verifications.token_hash",
];

/** Secret-LOOKING columns that are fine for their table's readers — each with the reason. */
const REVIEWED_NOT_SECRET: Record<string, string> = {
  "ad_accounts.token_expires_at": "an expiry time, not the token",
  "user_google_tokens.token_expiry": "an expiry time, not the token",
  "api_keys.key_hash": "SHA-256 of a random API key; owner-only by RLS; a hash cannot be used as the key",
  "assessments.public_token": "share-link token the team sends to the customer",
  "quotes.public_token": "share-link token the team sends to the customer",
  "project_sales.public_token": "share-link token the team sends to the customer",
  "team_invites.token": "invite link the owner shares (team_invites_owner_manage)",
  "quote_views.viewer_hash": "hashed viewer fingerprint for view counts, not a credential",
  "attendance_devices.credential_id": "WebAuthn credential id — a public identifier, the key never leaves the phone",
  "vault_access_log.credential_id": "id of a vault entry (foreign key), not a credential",
  "vault_passwords.password_ciphertext": "the owner's own vault rows (RLS owner_user_id = auth.uid()); vault design",
  "vault_passwords.password_fingerprint": "the owner's own vault rows (RLS owner_user_id = auth.uid()); vault design",
  "personal_vault_pin.pin_hash": "own row only (RLS user_id = auth.uid()); /api/vault/personal/pin verifies with it",
  "tenants.attendance_ingest_key": "emptied by R-607 (20261010000000) — always null, key moved to attendance_settings.ingest_key",
  "tenant_secrets.gemini_api_key": "tenant_secrets is owner-only by RLS (tenant_secrets_owner_*); the owner enters these keys",
  "tenant_secrets.razorpay_key_secret": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.razorpay_webhook_secret": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.resend_api_key": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.sandbox_api_key": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.sandbox_api_secret": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.whatsapp_access_token": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.whatsapp_app_secret": "tenant_secrets is owner-only by RLS; the owner enters these keys",
  "tenant_secrets.whatsapp_verify_token": "tenant_secrets is owner-only by RLS; the owner enters these keys",
};

const SECRET_NAME = /(secret|token|password|passcode|_hash$|api_key|ingest_key|private_key|credential)/i;
const BROWSER_ROLES = ["authenticated", "anon"];

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migrations = () =>
  readdirSync(MIG_DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
/** Baseline first, then migrations in file order — the order CI and deploy apply them. */
const allSql = () => [
  { file: BASELINE, sql: read(BASELINE) },
  ...migrations().map((f) => ({ file: f, sql: read(`${MIG_DIR}/${f}`) })),
];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const unq = (s: string) => s.replace(/"/g, "").trim().toLowerCase();
const secretTables = () => [...new Set(SECRET_COLUMNS.map((c) => c.split(".")[0]))];

function blockOf(sql: string): string {
  const m = /-- BEGIN 09 GRANT BLOCK\n[\s\S]*?-- END 09 GRANT BLOCK\n/.exec(sql);
  if (!m) throw new Error("no BEGIN/END 09 GRANT BLOCK markers");
  return m[0];
}

describe("R-833 secret columns", () => {
  it("09's secret_cols list matches SECRET_COLUMNS", () => {
    const m = /secret_cols text\[\] := array\[([\s\S]*?)\];/.exec(read(NINE));
    expect(m, "09 has no secret_cols array").toBeTruthy();
    const list = [...m![1].matchAll(/'([a-z_0-9]+\.[a-z_0-9]+)'/g)].map((x) => x[1]);
    expect(list.sort()).toEqual([...SECRET_COLUMNS].sort());
  });

  it("09 handles secret tables before (and instead of) its generic table-level grant", () => {
    const block = blockOf(read(NINE));
    const branch = block.indexOf("if rec.relname = any(secret_tables) then");
    const generic = block.indexOf("execute format('grant %s on public.%I to %I'");
    expect(branch).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(branch);
    const between = block.slice(branch, generic);
    expect(between).toMatch(/\bcontinue;/);
    // inside the branch the only table-level grant is DELETE (no columns there)
    const tableGrants = [...between.matchAll(/grant (\w+) on public\.%I/g)].map((x) => x[1]);
    expect(tableGrants).toEqual(["delete"]);
    // the sweep never grants a table-level SELECT
    expect(block).not.toMatch(/grant select on (table )?public\.%I/);
  });

  it("the SQL test runs a byte-identical copy of 09's block", () => {
    expect(blockOf(read(SQL_TEST))).toBe(blockOf(read(NINE)));
  });

  it("after baseline + every migration, no browser role has table-level SELECT on a secret table", () => {
    const tables = secretTables();
    // state[table|role] = holds table-level SELECT
    const state = new Map<string, { on: boolean; file: string }>();
    const colLeaks: string[] = [];
    const ROLE_LIST = /to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?$/i;

    for (const { file, sql } of allSql()) {
      const body = stripComments(sql);
      for (const stmt of body.split(";")) {
        const s = stmt.replace(/\s+/g, " ").trim();
        const g = /^(grant|revoke)\s+(.+?)\s+on\s+(?!function|sequence|schema|all functions|all sequences|type|domain)(?:table\s+)?(all tables in schema \S+|.+?)\s+(to|from)\s+(.+)$/i.exec(s);
        if (!g) continue;
        const [, verb, privsRaw, targetRaw, , rolesRaw] = g;
        const roles = (ROLE_LIST.exec(`to ${rolesRaw}`)?.[1] ?? rolesRaw)
          .split(",").map(unq).map((r) => (r === "public" ? "public" : r));
        const targets = /^all tables in schema/i.test(targetRaw)
          ? (/public/i.test(targetRaw) ? tables : [])
          : targetRaw.split(",").map((t) => unq(t).replace(/^public\./, ""));
        // column list: "select (a, b), insert (c)" — any "(" means column privileges
        const privs = privsRaw.toLowerCase();
        const columnGrant = privs.includes("(");
        for (const t of targets) {
          if (!tables.includes(t)) continue;
          for (const r of roles) {
            const browser = BROWSER_ROLES.includes(r) || r === "public";
            if (!browser) continue;
            if (columnGrant) {
              if (verb.toLowerCase() !== "grant") continue;
              for (const m of privs.matchAll(/(select|all|references|insert|update)\s*(?:privileges\s*)?\(([^)]*)\)/g)) {
                for (const c of m[2].split(",").map(unq)) {
                  if (SECRET_COLUMNS.includes(`${t}.${c}`) && (m[1] === "select" || m[1] === "all"))
                    colLeaks.push(`${file}: grant ${m[1]} (${c}) on ${t} to ${r}`);
                }
              }
              continue;
            }
            const touchesSelect = /\b(select|all)\b/.test(privs);
            if (!touchesSelect) continue;
            const keyRoles = r === "public" ? ["public"] : [r];
            for (const kr of keyRoles) state.set(`${t}|${kr}`, { on: verb.toLowerCase() === "grant", file });
          }
        }
      }
    }
    const open = [...state.entries()].filter(([, v]) => v.on).map(([k, v]) => `${k} (last: ${v.file})`);
    expect(open, "table-level SELECT left on a secret table").toEqual([]);
    expect(colLeaks, "a column grant names a secret column").toEqual([]);
  });

  it("every secret-looking column is either SECRET_COLUMNS or reviewed", () => {
    const found = new Set<string>();
    for (const { sql } of allSql()) {
      const body = stripComments(sql);
      for (const m of body.matchAll(/create table (?:if not exists )?(?:"?public"?\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
        for (const line of m[2].split("\n")) {
          const c = /^\s*"?([a-z_0-9]+)"?\s+"?[a-z]/i.exec(line);
          if (c && !/^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(c[1]) && SECRET_NAME.test(c[1]))
            found.add(`${m[1].toLowerCase()}.${c[1].toLowerCase()}`);
        }
      }
      for (const m of body.matchAll(/alter table (?:only )?(?:if exists )?(?:"?public"?\.)?"?([a-z_0-9]+)"?([^;]*);/gi)) {
        for (const a of m[2].matchAll(/add column (?:if not exists )?"?([a-z_0-9]+)"?/gi))
          if (SECRET_NAME.test(a[1])) found.add(`${m[1].toLowerCase()}.${a[1].toLowerCase()}`);
      }
    }
    // sanity: the scanner sees the columns this card is about
    for (const c of ["attendance_settings.presence_secret", "employees.pin_hash", "ad_accounts.access_token"])
      expect(found.has(c), `scanner missed ${c}`).toBe(true);
    const undecided = [...found].filter((c) => !SECRET_COLUMNS.includes(c) && !(c in REVIEWED_NOT_SECRET)).sort();
    expect(
      undecided,
      "new secret-looking column: add it to SECRET_COLUMNS (and 09's secret_cols) or to REVIEWED_NOT_SECRET with a reason",
    ).toEqual([]);
  });
});
