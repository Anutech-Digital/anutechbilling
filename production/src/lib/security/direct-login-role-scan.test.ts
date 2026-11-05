/**
 * R-2485 (5 Nov 2026) — DB guards ask ONE helper "is this a direct request login?".
 *
 * The Cloud SQL data gateway (src/server/db/gateway.ts) runs a signed-in browser request as the
 * LOGIN app_runtime, a visitor as app_anon and cron jobs as app_jobs — no `set role`. Guards that
 * kept their own `current_user in ('authenticated', 'anon')` list were skipped there: R-2482
 * (users insert → any company's owner) and R-2485 (attendance times). The lists also disagreed.
 * 20261105004823_r2485_direct_request_login_helper.sql added public.is_direct_request_login() and
 * moved every guard to it.
 *
 * This scan fails when:
 *   1. the LATEST definition of any public function (newest migration wins, file order) compares
 *      current_user with a request role ('authenticated', 'anon', 'authenticator', 'app_runtime',
 *      'app_anon', 'app_jobs') — except the helper itself;
 *   2. any migration after R-2485 does so anywhere (a DO block, a policy, a function);
 *   3. the helper's list in the newest definition is not exactly the six logins.
 * Fix: call public.is_direct_request_login() (SECURITY INVOKER — it reads current_user).
 *
 * Not covered on purpose: `session_user` checks (current_tenant_id() and friends read app.user_id
 * for the app_* logins — a different question) and the RPC "v_trusted" checks
 * (auth.role() is null and session_user not in (...)) — "is this a trusted server path", R-2487.
 * The SQL half (supabase/tests/r2485_direct_request_login_guards.test.sql) proves the guards on a
 * real database.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs ops script, no types (stripComments below gives it its type)
import { stripSqlComments } from "../../../scripts/ops/sql-comments.mjs";

const DIR = "supabase/migrations";
const R2485 = "20261105004823";
const HELPER = "is_direct_request_login";
const LOGINS = ["authenticated", "anon", "authenticator", "app_runtime", "app_anon", "app_jobs"];

const WHO = String.raw`\bcurrent_(?:user|role)\b(?:\s*::\s*(?:text|name))?`;
const LOGIN = `'(?:${LOGINS.join("|")})'`;
const SHAPES = [
  // current_user = 'authenticated'   /  'authenticated' <> current_user
  new RegExp(`${WHO}\\s*(?:=|<>|!=)\\s*${LOGIN}`, "i"),
  new RegExp(`${LOGIN}\\s*(?:=|<>|!=)\\s*${WHO}`, "i"),
  // current_user [not] in ('postgres', 'authenticated', …) — a request login anywhere in the list
  new RegExp(`${WHO}\\s*(?:not\\s+)?in\\s*\\([^)]*${LOGIN}`, "i"),
  // current_user = any(array['authenticated', …])  /  = any('{authenticated,…}')
  new RegExp(`${WHO}\\s*(?:=|<>|!=)\\s*(?:any|all)\\s*\\(\\s*(?:array\\s*\\[[^\\]]*${LOGIN}|'\\{[^}]*\\b(?:${LOGINS.join("|")})\\b)`, "i"),
];

/** current_user / current_role compared with a request login, in any of the shapes above. */
export const RAW_ROLE_CHECK = { test: (sql: string) => SHAPES.some((re) => re.test(sql)) };

/** Comments stripped — migrations quote the old form to explain it. One pass, so a `/*` inside
 *  a `--` line (e.g. "-- /accounting/* by prefix") is not read as a block comment, and quoted
 *  text ('--') is kept. R-2491: the one shared copy (gen-deploy-db / localhost-update use it too). */
export function stripComments(sql: string): string {
  return stripSqlComments(sql) as string;
}

/** Every `create [or replace] function public.X(...) ... as $tag$ body $tag$`, in order. */
export function functionBodies(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out.push({ name: m[1].toLowerCase(), body: m[4] });
  return out;
}

const files = readdirSync(DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
const src = (f: string) => stripComments(readFileSync(`${DIR}/${f}`, "utf8"));

describe("R-2485: the scan itself", () => {
  it("catches the shapes that bit (and not the helper call)", () => {
    expect(RAW_ROLE_CHECK.test("if current_user <> 'authenticated' then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user::text not in ('authenticated', 'anon', 'app_runtime') then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user in ('authenticated', 'anon') then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("and current_user = 'app_jobs'")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user not in ('postgres', 'authenticated') then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if 'authenticated' = current_user then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user = any(array['authenticated','anon']) then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user::text = any('{postgres,app_runtime}') then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_role in ('authenticated') then")).toBe(true);
    expect(RAW_ROLE_CHECK.test("if current_user in ('postgres', 'supabase_admin') then")).toBe(false);
    expect(RAW_ROLE_CHECK.test("if not public.is_direct_request_login() then")).toBe(false);
    expect(RAW_ROLE_CHECK.test("if current_user = 'postgres' or pg_has_role(current_user, 'postgres', 'member')")).toBe(false);
    expect(RAW_ROLE_CHECK.test("when session_user = 'app_runtime' then")).toBe(false);
  });

  it("strips comments in one pass (a /* inside a -- line is not a block comment)", () => {
    const s = stripComments("-- /accounting/* by prefix\nif current_user <> 'authenticated' then /* x */ raise 'a--b';");
    expect(RAW_ROLE_CHECK.test(s)).toBe(true);
    expect(s).toContain("'a--b'");
    expect(s).not.toContain("accounting");
  });

  it("reads function bodies, newest wins", () => {
    const sql = "create or replace function public.g() returns trigger language plpgsql as $f$ begin if current_user <> 'authenticated' then return new; end if; end $f$;\n" +
      "create or replace function public.g() returns trigger language plpgsql as $$ begin if not public.is_direct_request_login() then return new; end if; end $$;";
    const bodies = functionBodies(stripComments(sql));
    expect(bodies.map((b) => b.name)).toEqual(["g", "g"]);
    expect(RAW_ROLE_CHECK.test(bodies[0].body)).toBe(true);
    expect(RAW_ROLE_CHECK.test(bodies[1].body)).toBe(false);
  });

  it("scanned the real tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith(R2485))).toBe(true);
  });
});

describe("R-2485: no guard keeps its own request-role list", () => {
  const latest = new Map<string, { file: string; body: string }>();
  for (const f of files) for (const b of functionBodies(src(f))) latest.set(b.name, { file: f, body: b.body });

  it("the latest body of every public function uses the helper, not a raw current_user list", () => {
    const raw = [...latest.entries()]
      .filter(([name, d]) => name !== HELPER && RAW_ROLE_CHECK.test(d.body))
      .map(([name, d]) => `${name} (${d.file})`);
    expect(raw, "call public.is_direct_request_login() instead of listing roles against current_user (R-2485)").toEqual([]);
  });

  it("no migration after R-2485 adds a raw current_user role check anywhere", () => {
    const bad = files
      .filter((f) => f.slice(0, 14) > R2485)
      .filter((f) => {
        let s = src(f);
        for (const b of functionBodies(s)) if (b.name === HELPER) s = s.replace(b.body, "");
        return RAW_ROLE_CHECK.test(s);
      });
    expect(bad, "use public.is_direct_request_login() (R-2485)").toEqual([]);
  });

  it("the helper's newest body names exactly the six request logins", () => {
    const h = latest.get(HELPER);
    expect(h, "public.is_direct_request_login() is defined").toBeDefined();
    const listed = [...(h!.body.match(/'([a-z_]+)'/g) ?? [])].map((s) => s.slice(1, -1)).sort();
    expect(listed).toEqual([...LOGINS].sort());
  });

  it("the guards that were fixed keep using it", () => {
    for (const fn of ["attendance_direct_write_guard", "role_column_write_guard", "r720_tenants_column_guard",
      "r720_tenant_domains_guard", "r2445_tenants_owner_guard", "r1903_users_phone_verified_guard",
      "tg_quote_insert_approval_guard", "tg_users_insert_server_only"]) {
      expect(latest.get(fn)?.body ?? "", fn).toContain("public.is_direct_request_login()");
    }
  });
});
