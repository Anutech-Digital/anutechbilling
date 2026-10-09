/**
 * R-450 (9 Oct 2026) — every RLS table made since the Cloud SQL cut-over needs a
 * service_role policy.
 *
 * What happened: Subscriptions → Manage seats → "Add 5 seats" failed with a 503 —
 * "new row violates row-level security policy for table seat_increase_claims". The route
 * writes its idempotency claim with the server (service_role) client. On hosted Supabase
 * service_role has BYPASSRLS and never reads a policy, so every local test was green. On
 * Cloud SQL (staging/live, since 6 Sep 2026) no role may have BYPASSRLS: the stand-in is one
 * permissive `zzz_service_role_all ... to service_role using (true)` policy per table
 * (supabase/cloudsql/01b-grants-and-policies.sql). That loop ran ONCE, for the tables that
 * existed then — every table created afterwards has to bring its own, and
 * 20260930177000_seat_increase_claims.sql (and 20260928140000 rate_limit_buckets) did not.
 * Fix: 20261009150000_service_role_policy_gaps.sql.
 *
 * The rule, for every `create [unlogged] table public.X` in a migration from 20260906
 * onward whose RLS is enabled: some migration creates a policy on X that names
 * service_role — either a plain `create policy ... on public.X ... to service_role`, or the
 * house loop `foreach t in array array['X', ...] loop ... to service_role ... end loop`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
/** Cloud SQL cut-over (8a25d726, 6 Sep 2026). Older tables got the 01b loop. */
const FROM = "20260906";

/** Tables that may skip the policy, each with a written reason. Keep it empty if you can. */
const EXEMPT: Record<string, string> = {};

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const TABLE = String.raw`(?:public\.)?"?(\w+)"?`;

function scanServiceRoleGaps(files: Array<{ name: string; sql: string }>): string[] {
  const createdIn = new Map<string, string>();
  const rls = new Set<string>();
  const covered = new Set<string>();

  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = stripComments(f.sql).toLowerCase();

    for (const m of sql.matchAll(new RegExp(String.raw`create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${TABLE}`, "g"))) {
      if (!createdIn.has(m[1])) createdIn.set(m[1], f.name);
    }
    for (const m of sql.matchAll(new RegExp(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${TABLE}\s+enable\s+row\s+level\s+security`, "g"))) {
      rls.add(m[1]);
    }
    for (const m of sql.matchAll(new RegExp(String.raw`create\s+policy\s+(?:"[^"]+"|\w+)\s+on\s+${TABLE}([^;]*);`, "g"))) {
      if (/\bto\s+[^;]*\bservice_role\b/.test(m[2])) covered.add(m[1]);
    }
    for (const m of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]\s+loop([\s\S]*?)end\s+loop/g)) {
      if (!/zzz_service_role_all|\bto\s+service_role\b/.test(m[2])) continue;
      for (const n of m[1].matchAll(/'(?:public\.)?(\w+)'/g)) covered.add(n[1]);
    }
  }

  const gaps: string[] = [];
  for (const [table, file] of createdIn) {
    if (file < FROM || !rls.has(table) || covered.has(table) || table in EXEMPT) continue;
    gaps.push(`${table} (${file})`);
  }
  return gaps.sort();
}

function readMigrations() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(`${DIR}/${name}`, "utf8") }));
}

describe("R-450: every RLS table since the Cloud SQL cut-over has a service_role policy", () => {
  it("no table is missing one", () => {
    expect(scanServiceRoleGaps(readMigrations())).toEqual([]);
  });

  it("catches a table with RLS and no service_role policy", () => {
    const gaps = scanServiceRoleGaps([{
      name: "20261009000000_x.sql",
      sql: "create table public.thing (id int);\nalter table public.thing enable row level security;\n" +
           "create policy thing_select on public.thing for select using (true);",
    }]);
    expect(gaps).toEqual(["thing (20261009000000_x.sql)"]);
  });

  it("accepts a plain policy, the foreach loop, and an unlogged table", () => {
    const gaps = scanServiceRoleGaps([
      { name: "20261009000000_a.sql", sql:
        "create unlogged table if not exists public.a (id int);\nalter table public.a enable row level security;\n" +
        "create policy zzz_service_role_all on public.a as permissive for all to service_role using (true) with check (true);" },
      { name: "20261009000001_b.sql", sql:
        "create table public.b (id int); create table public.c (id int);\n" +
        "alter table public.b enable row level security; alter table public.c enable row level security;\n" +
        "do $$ declare t text; begin foreach t in array array['b', 'c'] loop\n" +
        "execute format('create policy zzz_service_role_all on public.%I for all to service_role using (true)', t);\n" +
        "end loop; end $$;" },
    ]);
    expect(gaps).toEqual([]);
  });

  it("ignores tables older than the cut-over (the 01b loop covered them)", () => {
    const gaps = scanServiceRoleGaps([{
      name: "20260801000000_old.sql",
      sql: "create table public.old (id int); alter table public.old enable row level security;",
    }]);
    expect(gaps).toEqual([]);
  });
});
