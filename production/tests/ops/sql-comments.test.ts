/* R-2491: one-pass SQL comment stripping, shared by gen-deploy-db / localhost-update / the R-2485 scan. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stripSqlComments } from "../../scripts/ops/sql-comments.mjs";
import { redefinedObjects, supersededEntries, parseDeployHeaders } from "../../scripts/ops/gen-deploy-db.mjs";
import { deployEntries, redefinedObjects as luRedefined } from "../../scripts/ops/localhost-update.mjs";

const MIG = path.join(__dirname, "..", "..", "supabase", "migrations");
const R719 = "20261011083000_r719_table_write_roles.sql";
const R2485 = "20261105004823_r2485_direct_request_login_helper.sql";
const read = (f: string) => fs.readFileSync(path.join(MIG, f), "utf8");

describe("R-2491 stripSqlComments", () => {
  it("a /* inside a -- line is not a block comment", () => {
    const sql = "-- /accounting/* by prefix\ncreate or replace function public.g() returns int as $$ select 1 $$;\n-- */ end\n";
    expect(stripSqlComments(sql)).toContain("create or replace function public.g()");
    expect(stripSqlComments(sql)).not.toContain("accounting");
  });

  it("a -- inside a block comment is not a line comment; a block comment is one space", () => {
    expect(stripSqlComments("a/* x -- y */b")).toBe("a b");
    expect(stripSqlComments("a /* x -- y\n create function f() */ b").includes("create")).toBe(false);
  });

  it("comment marks inside a string literal stay text ('' is a quote)", () => {
    const s = stripSqlComments("select 'a--b', 'it''s /* not */ a comment' -- gone\n");
    expect(s).toContain("'a--b'");
    expect(s).toContain("'it''s /* not */ a comment'");
    expect(s).not.toContain("gone");
  });

  it("unterminated block comment / literal run to the end (no throw)", () => {
    expect(stripSqlComments("x /* never closed")).toBe("x  ");
    expect(stripSqlComments("x 'never closed -- y")).toBe("x 'never closed -- y");
    expect(stripSqlComments(null as unknown as string)).toBe("");
  });
});

describe("R-2491 the real r719 file + R-2485 migration", () => {
  it("r719's role_column_write_guard is seen (was hidden by '-- /accounting/* by prefix')", () => {
    expect(redefinedObjects(read(R719))).toContain("function role_column_write_guard");
  });

  it("SUPS lists R-2485 as r719's later redefiner (gen-deploy-db and localhost-update agree)", () => {
    const files = [R719, R2485];
    const entries = files.map((f) => ({ ...parseDeployHeaders(read(f), f), sql: read(f) }));
    const k2485 = entries[1].key;
    const sup = supersededEntries(entries).find((s: { key: string }) => s.key === entries[0].key);
    expect(sup?.later).toContain(k2485);
    const lu = deployEntries(files.map((file) => ({ file, sql: read(file) })));
    expect(lu.find((e: { file: string }) => e.file === R719)?.later).toContain(k2485);
    expect(luRedefined).toBe(redefinedObjects);
  });
});
