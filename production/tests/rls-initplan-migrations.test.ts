/**
 * Guards for S13 (RLS InitPlan wrap) and S14 (hot tenant/date indexes).
 *
 * supabase/tests/rls_initplan_and_hot_indexes.test.sql carries both migrations inline, because
 * the SQL harness can only run self-contained files. An inline copy that drifts from its
 * migration proves something the database will not do — so the copy is checked here, in the
 * gate that actually runs on a branch.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { PEER_SCOPED_ROLES } from "../src/lib/team/visibility";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const SUPA = path.join(process.cwd(), "supabase");
const S13 = "20260928100000_rls_initplan_wrap.sql";
const S14 = "20260928101000_hot_tenant_date_indexes.sql";
const read = (...p: string[]) => readSource(path.join(SUPA, ...p)).replace(/\r\n/g, "\n");
const SQL_TEST = read("tests", "rls_initplan_and_hot_indexes.test.sql");

function inlineCopy(name: string): string | undefined {
  const esc = name.replace(/\./g, "\\.");
  return new RegExp(`-- >>> INLINE ${esc} >>>\\n([\\s\\S]*?)\\n-- <<< INLINE ${esc} <<<`).exec(SQL_TEST)?.[1];
}

describe("S13/S14 migrations", () => {
  for (const name of [S13, S14]) {
    it(`the SQL regression test carries ${name} verbatim`, () => {
      const copy = inlineCopy(name);
      expect(copy, `no INLINE block for ${name} in the SQL test`).toBeDefined();
      expect(copy, `the inline copy of ${name} has drifted — re-copy it`).toBe(
        read("migrations", name).replace(/\s+$/, ""),
      );
    });
  }

  it("keeps the SQL test safe to run anywhere (rollback, never commit)", () => {
    expect(SQL_TEST.trimEnd().endsWith("rollback;")).toBe(true);
    expect(SQL_TEST).not.toMatch(/^\s*commit\s*;/im);
    expect(SQL_TEST).toContain("set local role authenticated");
  });

  it("scopes the same roles in hierarchy_sees_all() as the UI", () => {
    const body = /create or replace function public\.hierarchy_sees_all\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$/
      .exec(read("migrations", S13))?.[1];
    expect(body, "hierarchy_sees_all body is missing").toBeTruthy();
    expect(body).toContain("current_customer_id() is not null");
    const branch = /u\.role not in \(([^)]*)\)/.exec(body!);
    expect(branch, "hierarchy_sees_all has no role branch").toBeTruthy();
    const roles = branch![1].split(",").map((r) => r.trim().replace(/'/g, "")).sort();
    expect(roles).toEqual([...PEER_SCOPED_ROLES].sort());
  });

  it("recreates all nine hierarchy policies AS RESTRICTIVE, none via can_see_record", () => {
    const stmts = read("migrations", S13)
      .split(";")
      .map((s) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim())
      .filter((s) => /^create policy \w+_hierarchy_/i.test(s));
    const names = stmts.map((s) => /^create policy (\S+)/i.exec(s)![1]).sort();
    const expected = ["leads", "quotes", "customers"]
      .flatMap((t) => ["select", "write", "delete"].map((k) => `${t}_hierarchy_${k}`))
      .sort();
    expect(names).toEqual(expected);
    for (const s of stmts) {
      expect(s.toLowerCase(), s.slice(0, 60)).toContain("as restrictive");
      expect(s, s.slice(0, 60)).not.toContain("can_see_record");
      expect(s, s.slice(0, 60)).toContain("(select public.hierarchy_sees_all())");
    }
  });

  it("builds no index CONCURRENTLY inside the (transactional) migration", () => {
    const runnable = read("migrations", S14)
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    expect(runnable).not.toMatch(/concurrently/i);
    expect(runnable.match(/create index if not exists/gi)?.length).toBe(15);
  });
});
