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
 *   2. the shim block in the SQL test (run twice there: install + re-run) is not byte-equal to
 *      the migration's — the test must test what ships;
 *   3. the bodies the migration agrees to replace are not exactly 01a's shims;
 *   4. the shims' login → role / login → uid mapping differs from the LATEST
 *      public.current_request_role() / current_user_id() (staging's answer is the proven one);
 *   5. the migration stops being Cloud SQL only / postgres-run;
 *   6. a migration after R-2487 adds a new raw trusted-server list
 *      (`auth.role() is null … session_user … not in (`) — or the number of latest function
 *      bodies that still carry one goes UP (ratchet; R-2488/R-2489 move them to a helper).
 *      The `public.current_request_role() is null and session_user … not in (…)` form (CLAUDE.md
 *      §17c) is allowed: that helper maps every gateway login by session_user, so its list never
 *      decides for app_anon / app_jobs. R-2488's is_trusted_server_path() will replace both.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
const R2487 = "20261105021052";
const MIG = `${DIR}/${R2487}_r2487_cloudsql_auth_shims_gateway_logins.sql`;
const TEST = "supabase/tests/r2487_cloudsql_auth_shims.test.sql";
/** Latest bodies (each overload apart: name + argument text) with the raw list, measured
 *  5 Nov 2026 (R-2487 card `measure`). Only falls — lower it when you move some. */
const RAW_TRUSTED_BASELINE = 151; // the card says ~153: its one-off measure used a looser parser

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

/** Every `create function public.X(args) returns … $tag$ body $tag$`. `sig` = name + argument
 *  text, so overloads stay apart (code review: a name-only key let one overload hide another). */
function functionBodies(sql: string): { name: string; sig: string; body: string }[] {
  const out: { name: string; sig: string; body: string }[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*returns[\s\S]*?\$(\w*)\$([\s\S]*?)\$\3\$/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const name = m[1].toLowerCase();
    out.push({ name, sig: `${name}(${m[2].replace(/\s+/g, " ").trim().toLowerCase()})`, body: m[4] });
  }
  return out;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const squash = (s: string) => s.replace(/\s+/g, "");
const mig = norm(readFileSync(MIG, "utf8"));
const blocks = (s: string) => [...s.matchAll(/-- r2487-shim-begin\n([\s\S]*?)\n-- r2487-shim-end/g)].map((m) => m[1]);
/** The two shim bodies inside the migration's format() strings: $b$ … $b$, uid first. */
const shimBodies = [...mig.matchAll(/\$b\$([\s\S]*?)\$b\$/g)].map((m) => m[1]);

const files = readdirSync(DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
const latestByName = new Map<string, string>();
const latestBySig = new Map<string, string>();
for (const f of files) {
  for (const b of functionBodies(stripComments(readFileSync(`${DIR}/${f}`, "utf8")))) {
    latestByName.set(b.name, b.body);
    latestBySig.set(b.sig, b.body);
  }
}

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

  it("runs as postgres, only on Cloud SQL, and says R-2487 in both bodies", () => {
    expect(mig).toMatch(/^-- deploy-user: postgres$/m);
    expect(mig).toMatch(/^-- deploy-peek: not exists\(select 1 from pg_roles where rolname = 'cloudsqlsuperuser'\) or /);
    expect(mig).toContain("if not exists (select 1 from pg_roles where rolname = 'cloudsqlsuperuser') then");
    expect(shimBodies).toHaveLength(2);
    for (const b of shimBodies) {
      expect(b).toContain("R-2487");
      expect(b).toMatch(/request\.jwt\.claims/); // the claims fallback is kept
    }
  });

  it("replaces only 01a's exact shim bodies (or its own, on a re-run)", () => {
    expect(mig).toContain("refusing to overwrite them");
    const a01 = readFileSync("supabase/cloudsql/01a-roles-and-auth.sql", "utf8");
    const body01 = (fn: string) => {
      const m = a01.match(new RegExp(`function auth\\.${fn}\\(\\) returns \\w+ language sql stable as \\$\\$([\\s\\S]*?)\\$\\$`));
      expect(m, `01a defines the ${fn} shim`).not.toBeNull();
      return squash(m![1]);
    };
    const known = [...mig.matchAll(/\$k\$([\s\S]*?)\$k\$/g)].map((m) => m[1]);
    expect(known).toContain(body01("uid"));
    expect(known).toContain(body01("role"));
  });

  it("the SQL test runs the same block the migration ships (twice: install + re-run)", () => {
    const a = blocks(mig);
    const b = blocks(norm(readFileSync(TEST, "utf8")));
    expect(a, "migration has one r2487-shim block").toHaveLength(1);
    expect(b, "the SQL test runs it twice").toHaveLength(2);
    for (const x of b) expect(x).toBe(a[0]);
  });

  it("maps every gateway login exactly like the latest current_request_role() / current_user_id()", () => {
    const crr = latestByName.get("current_request_role");
    const cui = latestByName.get("current_user_id");
    expect(crr && cui, "R-161 helpers defined in supabase/migrations").toBeTruthy();
    const wantRole = roleMap(crr!);
    const wantUid = uidMap(cui!);
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
    expect(bad, "write public.current_request_role() (CLAUDE.md §17c) — never a new auth.role() list").toEqual([]);
  });

  it(`latest bodies with a raw list stay <= ${RAW_TRUSTED_BASELINE} (lower the baseline when you move some)`, () => {
    const n = [...latestBySig.values()].filter((b) => RAW_TRUSTED.test(b)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(RAW_TRUSTED_BASELINE);
  });
});
