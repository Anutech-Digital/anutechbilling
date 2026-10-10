/**
 * R-601 guard — attendance routes never write rows, or read the office-code seed, through
 * the signed-in user's client.
 *
 * Since 20261009213000_attendance_role_writes.sql only owner / manager / accountant /
 * billing may write `attendance`, only owner / manager may write `attendance_settings`,
 * and `presence_secret` is not selectable by `authenticated` at all. A route that keeps
 * using `supabase` (the user client) for those does not error loudly — an RLS-blocked
 * UPDATE touches 0 rows and returns no error — so the selfie / consent-erasure / face-enrol
 * step would quietly stop working for every employee. That is how consent withdrawal and
 * self face-enrolment were already broken (employees writes were restricted on 30 Sep).
 *
 * The SQL side is pinned by supabase/tests/attendance_role_writes.test.sql.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src", "app", "api", "attendance");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

/** `supabase.from("<table>")` followed, before the statement ends, by a write call. */
function userClientWrites(src: string, table: string): string[] {
  const re = new RegExp(`supabase\\s*\\.from\\("${table}"\\)[^;]*?\\.(insert|update|upsert|delete)\\(`, "g");
  return Array.from(src.matchAll(re), (m) => m[0].replace(/\s+/g, " ").slice(0, 120));
}

describe("R-601 attendance routes use the server client for role-restricted writes", () => {
  const files = routeFiles(ROOT);

  it("finds the attendance routes (guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const f of files) {
    const rel = path.relative(process.cwd(), f).replace(/\\/g, "/");
    const src = readFileSync(f, "utf8");

    it(`${rel}: no user-client write to attendance / attendance_settings / employees`, () => {
      expect([
        ...userClientWrites(src, "attendance"),
        ...userClientWrites(src, "attendance_settings"),
        ...userClientWrites(src, "employees"),
      ]).toEqual([]);
    });

    it(`${rel}: presence_secret is never selected through the user client`, () => {
      const re = /supabase\s*\.from\("attendance_settings"\)[^;]*?presence_secret/g;
      expect(src.match(re) ?? []).toEqual([]);
    });
  }
});
