/**
 * R-1878: the co-pilot tables' CHECK lists must name the same platforms and objectives as
 * channel-specs.ts (UI rule 1: one fact, one place — the SQL can only copy it, so this test
 * keeps the copy honest). Add a platform to PLATFORMS → this fails until a migration widens
 * ad_plans.platforms / ad_copies.platform.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COPILOT_OBJECTIVES, PLATFORMS } from "./channel-specs";

const SQL = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261025001000_ad_copilot_tables.sql"),
  "utf8",
);

const quoted = (s: string) => [...s.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]).sort();

describe("R-1878 co-pilot tables match channel-specs", () => {
  it("ad_plans.objective lists exactly COPILOT_OBJECTIVES", () => {
    const m = /objective\s+text not null check \(objective in \(([^)]*)\)\)/.exec(SQL);
    expect(m).not.toBeNull();
    expect(quoted(m![1])).toEqual([...COPILOT_OBJECTIVES].sort());
  });

  it("ad_plans.platforms allows exactly PLATFORMS", () => {
    const m = /platforms <@ array\[([^\]]*)\]/.exec(SQL);
    expect(m).not.toBeNull();
    expect(quoted(m![1])).toEqual([...PLATFORMS].sort());
  });

  it("ad_copies.platform and ad_target_groups.platform allow exactly PLATFORMS", () => {
    const lists = [...SQL.matchAll(/platform in \(([^)]*)\)/g)].map((m) => quoted(m[1]));
    expect(lists.length).toBe(2);
    for (const l of lists) expect(l).toEqual([...PLATFORMS].sort());
  });

  it("every co-pilot table has RLS, the role gate and a service_role policy", () => {
    expect(SQL).toMatch(/array\['ad_plans', 'ad_target_groups', 'ad_creatives', 'ad_copies'\]/);
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/current_user_has_role\(''owner'', ''manager'', ''marketing''\)/);
    expect(SQL).toMatch(/zzz_service_role_all on public\.%I as permissive for all to service_role/);
  });
});
