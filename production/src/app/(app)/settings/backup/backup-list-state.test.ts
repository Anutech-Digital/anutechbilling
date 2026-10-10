import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { backupListState, isOwnerOnlyError } from "./backup-list-state";

describe("backupListState (R-823)", () => {
  it("a failed call is an error, never 'No backups yet'", () => {
    // The staging 400: 42702 column reference "id" is ambiguous.
    expect(backupListState({ isLoading: false, isError: true, error: { code: "42702", message: "column reference \"id\" is ambiguous" }, rowCount: 0 }))
      .toEqual({ kind: "error" });
  });
  it("the owner-only guard (42501) gets its own message", () => {
    expect(backupListState({ isLoading: false, isError: true, error: { code: "42501" }, rowCount: 0 })).toEqual({ kind: "owner_only" });
    expect(isOwnerOnlyError(new Error("x"))).toBe(false);
    expect(isOwnerOnlyError(null)).toBe(false);
  });
  it("loaded with no rows is the empty state, rows are the list", () => {
    expect(backupListState({ isLoading: false, isError: false, error: null, rowCount: 0 })).toEqual({ kind: "empty" });
    expect(backupListState({ isLoading: false, isError: false, error: null, rowCount: 2 })).toEqual({ kind: "list" });
    expect(backupListState({ isLoading: true, isError: false, error: null, rowCount: 0 })).toEqual({ kind: "loading" });
  });
  it("the page renders from backupListState (no `data ?? []` fall-through to the empty state)", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("backupListState(");
    expect(src).toContain("<LoadError");
  });
});

describe("list_tenant_backups migration (R-823)", () => {
  it("qualifies the users lookup so plpgsql cannot confuse it with the OUT column id", () => {
    const sql = fs.readFileSync(path.join(__dirname, "../../../../../supabase/migrations/20261010223000_list_tenant_backups_ambiguous_id.sql"), "utf8");
    expect(sql).toMatch(/from public\.users u where u\.id = auth\.uid\(\)/);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/where id = auth\.uid\(\)/);
    // The deploy-peek looks for this marker inside the function body (prosrc).
    expect(sql).toMatch(/as \$function\$[\s\S]*R-823[\s\S]*end \$function\$/);
    expect(sql).toContain("perform public.guard_backup_owner_only();");
    expect(sql).toMatch(/grant execute on function public\.list_tenant_backups\(\) to authenticated, service_role/);
  });
});
