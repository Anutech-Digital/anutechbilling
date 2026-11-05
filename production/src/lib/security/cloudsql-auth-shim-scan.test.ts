/**
 * R-2487 (5 Nov 2026) — on Cloud SQL the auth uid()/role() shims answer for the data gateway
 * logins, so the raw calls in ~153 RPC "v_trusted" checks and the trigger guards behave on live
 * as their sed-rewritten twins do on staging.
 * Migration: supabase/migrations/20261105021052_r2487_cloudsql_auth_shims_gateway_logins.sql.
 * SQL half (real database, superuser): supabase/tests/r2487_cloudsql_auth_shims.test.sql.
 *
 * This scan fails when:
 *   1. the migration contains the literal auth-prefixed uid()/role() call — staging's deploy
 *      script sed-rewrites that text to public.current_user_id()/current_request_role(), which
 *      would turn the shim into a public helper that calls itself;
 *   2. the shim block in the SQL test is not byte-equal to the migration's (the test must test
 *      what ships);
 *   3. the shims' login → role / login → uid mapping differs from the LATEST
 *      public.current_request_role() / current_user_id() (staging's answer is the proven one);
 *   4. the migration stops being Cloud SQL only / postgres-run;
 *   5. a migration after R-2487 adds a new raw trusted-server list
 *      (`auth.role() is null … session_user … not in (`) — or the number of latest function
 *      bodies that still carry one goes UP (ratchet; R-2488/R-2489 move them to a helper).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
const R2487 = "20261105021052";
const MIG = `${DIR}/${R2487}_r2487_cloudsql_auth_shims_gateway_logins.sql`;
const TEST = "supabase/tests/r2487_cloudsql_auth_shims.test.sql";
/** Latest bodies (by function name; overloads count once) with the raw list, measured 5 Nov 2026 —
 *  138 (153 counting each overload, R-2487 card `measure`). Only falls. */
const RAW_TRUSTED_BASELINE = 138;

/** Comments stripped in one pass (same as direct-login-role-scan.test.ts; shared module: R-2491). */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

function functionBodies(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out.push({ name: m[1].toLowerCase(), body: m[4] });
  return out;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const mig = norm(readFileSync(MIG, "utf8"));
const block = (s: string) => {
  const m = s.match(/-- r2487-shim-begin\n([\s\S]*?)\n-- r2487-shim-end/);
  return m ? m[1] : null;
};
/** The two shim bodies inside the migration's format() strings: $b$ … $b$, uid first. */
const shimBodies = [...mig.matchAll(/\$b\$([\s\S]*?)\$b\$/g)].map((m) => m[1]);

const files = readdirSync(DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
const latest = new Map<string, { file: string; body: string }>();
for (const f of files) for (const b of functionBodies(stripComments(readFileSync(`${DIR}/${f}`, "utf8")))) latest.set(b.name, { file: f, body: b.body });

/** login → role from a `case session_user when 'x' then 'y'` body. */
function roleMap(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/when\s+'(\w+)'\s+then\s+'(\w+)'/gi)) out[m[1]] = m[2];
  return out;
}
/** login → "user_id" | "null" from `when session_user in ('a','b') then <app.user_id | null>`. */
function uidMap(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/when\s+session_user\s+in\s*\(([^)]*)\)\s*then\s+(null|nullif\(current_setting\('app\.user_id')/gi)) {
    for (const l of m[1].match(/'(\w+)'/g) ?? []) out[l.slice(1, -1)] = m[2].toLowerCase() === "null" ? "null" : "user_id";
  }
  return out;
}

const RAW_TRUSTED = /auth\.role\(\)\s+is\s+null[\s\S]{0,200}?session_user(?:::text)?\s+not\s+in\s*\(/i;

describe("R-2487: the Cloud SQL auth shim migration", () => {
  it("never spells the auth-prefixed uid()/role() call (staging's sed would rewrite it)", () => {
    expect(mig).not.toMatch(/auth\s*\.\s*(?:uid|role)\s*\(\s*\)/i);
    expect(mig).toContain("$f$, 'auth', 'uid')");
    expect(mig).toContain("$f$, 'auth', 'role')");
  });

  it("runs as postgres, only on Cloud SQL, refuses unknown shims, and says R-2487 in both bodies", () => {
    expect(mig).toMatch(/^-- deploy-user: postgres$/m);
    expect(mig).toMatch(/^-- deploy-peek: not exists\(select 1 from pg_roles where rolname = 'cloudsqlsuperuser'\) or /);
    expect(mig).toContain("if not exists (select 1 from pg_roles where rolname = 'cloudsqlsuperuser') then");
    expect(mig).toContain("refusing to overwrite them");
    expect(shimBodies).toHaveLength(2);
    for (const b of shimBodies) {
      expect(b).toContain("R-2487");
      expect(b).toMatch(/request\.jwt\.claims/); // claims fallback kept (and the re-run check reads it)
    }
  });

  it("the SQL test runs the same block the migration ships", () => {
    const a = block(mig);
    const b = block(norm(readFileSync(TEST, "utf8")));
    expect(a, "migration has the r2487-shim markers").not.toBeNull();
    expect(b, "SQL test has the r2487-shim markers").not.toBeNull();
    expect(b).toBe(a);
  });

  it("maps every gateway login exactly like the latest current_request_role() / current_user_id()", () => {
    const crr = latest.get("current_request_role");
    const cui = latest.get("current_user_id");
    expect(crr && cui, "R-161 helpers defined in supabase/migrations").toBeTruthy();
    const wantRole = roleMap(crr!.body);
    const wantUid = uidMap(cui!.body);
    expect(Object.keys(wantRole).sort()).toEqual(["app_anon", "app_jobs", "app_runtime", "app_service"]);
    expect(roleMap(shimBodies[1])).toEqual(wantRole);
    expect(uidMap(shimBodies[0])).toEqual(wantUid);
    expect(Object.keys(wantUid).sort()).toEqual(Object.keys(wantRole).sort());
  });
});

describe("R-2487: raw trusted-server lists only shrink", () => {
  it("the scan sees the shape", () => {
    expect(RAW_TRUSTED.test("v_trusted := coalesce(auth.role(), '') = 'service_role'\n or (auth.role() is null\n and session_user::text not in ('authenticator', 'anon'))")).toBe(true);
    expect(RAW_TRUSTED.test("or (public.current_request_role() is null and session_user::text not in ('authenticator'))")).toBe(false);
  });

  it("no migration after R-2487 adds a raw `auth.role() is null … session_user not in (…)` list", () => {
    const bad = files.filter((f) => f.slice(0, 14) > R2487 && RAW_TRUSTED.test(stripComments(readFileSync(`${DIR}/${f}`, "utf8"))));
    expect(bad, "ask public.current_request_role() (or R-2488's helper) — never a new private session_user list").toEqual([]);
  });

  it(`latest bodies with a raw list stay <= ${RAW_TRUSTED_BASELINE} (lower the baseline when you move some)`, () => {
    const n = [...latest.values()].filter((d) => RAW_TRUSTED.test(d.body)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(RAW_TRUSTED_BASELINE);
  });
});
