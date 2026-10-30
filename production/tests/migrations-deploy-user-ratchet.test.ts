import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { parseDeployHeaders, splitScript } from "../scripts/ops/gen-deploy-db.mjs";

// R-2118 (30 Oct 2026): the staging DB step stopped at 20261030053741_gp16a_personal_identity_link.sql
// with "permission denied for table users" — the file created `auth_user_id … references auth.users(id)`
// but the deploy script runs every file as resellersos_migration, which on Cloud SQL has only SELECT
// on auth.users (cloudsql/06), never REFERENCES / ownership of auth.*. DDL that points INTO the auth
// schema (a foreign key to it, a grant/policy/trigger on it, creating/altering/dropping an auth object)
// must run as postgres: the file needs `-- deploy-user: postgres`.
//
// Function bodies ($$ … $$) are left out on purpose: they are only read when called, and the owner's
// SELECT on auth.users is enough there (R-721, R-1615, R-1834 do exactly that as resellersos_migration).

const supabaseDir = path.resolve(__dirname, "..", "supabase");
const migDir = path.join(supabaseDir, "migrations");
const prismaDir = path.resolve(__dirname, "..", "prisma", "migrations");
const scripts = ["staging", "live"].map((env) => path.join(supabaseDir, "cloudsql", env, "deploy-db-2026-10-07.sh"));

/** Same lookup as the script's migsrc(): supabase/migrations, else prisma/migrations/<name>/migration.sql. */
function migsrc(file: string): string {
  const a = path.join(migDir, file);
  return fs.existsSync(a) ? a : path.join(prismaDir, file.replace(/\.sql$/, ""), "migration.sql");
}

/** MIGS lines → { file, user } exactly as the deploy script will run them. */
function migsOf(scriptPath: string): { file: string; user: string }[] {
  const body: string[] = splitScript(fs.readFileSync(scriptPath, "utf8"), scriptPath).body;
  return body
    .map((l) => /^\s*"[^|]+\|([^|]+)\|([^|]+)\|/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[1], user: m[2] }));
}

/** SQL with comments and dollar-quoted bodies removed (only the DDL text itself is left). */
function ddlOnly(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(\$[A-Za-z0-9_]*\$)[\s\S]*?\1/g, " ")
    .replace(/--[^\n]*/g, " ");
}

const AUTH_DDL: RegExp[] = [
  /\breferences\s+auth\.\w+/i, // foreign key into auth.*
  /\bon\s+(?:table\s+)?auth\.\w+/i, // grant/revoke/policy/trigger/index ON auth.*
  /\b(?:alter|drop)\s+(?:table|view|function|trigger|policy|index|type|sequence)\s+(?:if\s+exists\s+)?auth\.\w+/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|view|function|trigger|policy|index|type|sequence)\s+(?:if\s+not\s+exists\s+)?auth\.\w+/i,
];

/** The first DDL fragment that needs postgres, or null. */
function authDdlHit(sql: string): string | null {
  const ddl = ddlOnly(sql);
  for (const re of AUTH_DDL) {
    const m = re.exec(ddl);
    if (m) return m[0].replace(/\s+/g, " ");
  }
  return null;
}

/** Deployed files whose DDL touches auth.* but which would run as someone other than postgres. */
function missingPostgres(files: { file: string; sql: string; user?: string }[]): string[] {
  return files
    .filter(({ file, sql, user }) => authDdlHit(sql) && (user ?? parseDeployHeaders(sql, file).user) !== "postgres")
    .map(({ file, sql }) => `${file}: "${authDdlHit(sql)}" needs -- deploy-user: postgres`);
}

// The failing gp16a head as it was in a12b12259 (no deploy-user line).
const OLD_GP16A = `-- deploy-peek: to_regclass('public.personal_identity_link') is not null
-- deploy-key: gp16apersonalidentitylink
begin;
create table if not exists public.personal_identity_link (
  auth_user_id        uuid primary key references auth.users(id) on delete cascade,
  personal_tenant_id  uuid not null references public.tenants(id) on delete cascade
);
create or replace function public.link_personal_identity(p_user uuid) returns jsonb language plpgsql as $$
begin
  perform 1 from auth.users u where u.id = p_user;
  return '{}'::jsonb;
end;
$$;
commit;
`;
const GP16A = "20261030053741_gp16a_personal_identity_link.sql";

describe("R-2118 ratchet: auth.* DDL runs as postgres", () => {
  it("catches the old gp16a file (FK to auth.users as resellersos_migration)", () => {
    expect(authDdlHit(OLD_GP16A)).toMatch(/references auth\.users/i);
    expect(missingPostgres([{ file: GP16A, sql: OLD_GP16A }])).toHaveLength(1);
    const fixed = OLD_GP16A.replace("-- deploy-key:", "-- deploy-user: postgres\n-- deploy-key:");
    expect(missingPostgres([{ file: GP16A, sql: fixed }])).toEqual([]);
  });

  it("ignores auth.* in comments and function bodies (runtime reads are fine)", () => {
    const sql = "-- deploy-peek: true\n-- no references auth.users here\ncreate function f() returns int language sql as $f$ select 1 from auth.users $f$;\n/* grant select on auth.users */\n";
    expect(authDdlHit(sql)).toBeNull();
    expect(authDdlHit("-- deploy-peek: true\ngrant select on auth.users to resellersos_migration;\n")).toMatch(/on auth\.users/);
    expect(authDdlHit("-- deploy-peek: true\nalter table auth.users add column x int;\n")).toMatch(/alter table auth\.users/);
  });

  it.each(scripts)("every migration in %s that touches auth.* in DDL runs as postgres", (scriptPath) => {
    const migs = migsOf(scriptPath);
    expect(migs.length).toBeGreaterThan(100);
    const files = migs.map(({ file, user }) => ({ file, user, sql: fs.readFileSync(migsrc(file), "utf8") }));
    expect(missingPostgres(files)).toEqual([]);
    // gp16a is in the script and runs as postgres.
    expect(migs.find((m) => m.file === GP16A)?.user).toBe("postgres");
  });

  it("the existing postgres files stay postgres", () => {
    for (const f of [
      "20261009220100_demo_readonly_wiring.sql",
      "20261011133000_r724_storage_roles.sql",
      "20261016103000_r731_session_mfa_ok.sql",
      "20261017020500_r731_mfa_ok_grants.sql",
      "20261018031506_r1546_storage_mime_allowlists.sql",
    ]) {
      expect(parseDeployHeaders(fs.readFileSync(path.join(migDir, f), "utf8"), f).user).toBe("postgres");
    }
  });
});
