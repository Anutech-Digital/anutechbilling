/**
 * R-1496 (P0): staging "Add employee" → 403. The gateway wrote every insert/update/delete as
 * `... returning a.*`, and Postgres checks SELECT on every column a RETURNING names. employees.
 * pin_hash has no SELECT for `authenticated` (column grants, R-833) — so every employee write
 * from the browser failed with 42501 "permission denied for table employees", whatever the
 * request asked back (select=id). RETURNING must name only the columns the answer needs; a
 * star in the answer means only the columns this role may read; asking for the hidden column
 * itself must still reach Postgres (and be refused there).
 */
import { describe, it, expect } from "vitest";
import type { Catalog, Column, Table } from "./catalog";
import { buildDelete, buildInsert, buildUpdate } from "./build";
import { parsePrefer, parseQuery } from "./parse";

const col = (name: string, readable = true, type = "text"): Column => ({
  name, type, hasDefault: false, generated: false, readable: { authenticated: readable, anon: readable },
});

function tbl(name: string, cols: Column[]): Table {
  return { name, kind: "table", columns: new Map(cols.map((c) => [c.name, c])), pk: ["id"], uniques: [["id"]] };
}

const employees = tbl("employees", [col("id", true, "uuid"), col("tenant_id", true, "uuid"), col("full_name"), col("pin_hash", false), col("department_id", true, "uuid")]);
const departments = tbl("departments", [col("id", true, "uuid"), col("name")]);
const cat: Catalog = {
  tables: new Map([["employees", employees], ["departments", departments]]),
  fks: [{ name: "employees_department_id_fkey", table: "employees", columns: ["department_id"], refTable: "departments", refColumns: ["id"] }],
  functions: new Map(),
};

const rep = parsePrefer("return=representation");
const minimal = parsePrefer("return=minimal");
const body = { full_name: "Asha", tenant_id: "00000000-0000-0000-0000-000000000001" };

function returning(sql: string): string {
  const m = /returning (.*?)\) select/.exec(sql);
  if (!m) throw new Error(`no RETURNING in: ${sql}`);
  return m[1];
}

describe("R-1496 — writes RETURN only what the answer needs", () => {
  it("insert ?select=id returns only id — never a.* (pin_hash is not readable)", () => {
    const b = buildInsert(cat, "employees", parseQuery(new URLSearchParams("select=id")), rep, body, false, "authenticated");
    expect(b.sql).not.toMatch(/returning a\.\*/);
    expect(returning(b.sql)).toBe('a."id"');
  });

  it("insert ?select=* returns every column the role may read, without pin_hash", () => {
    const b = buildInsert(cat, "employees", parseQuery(new URLSearchParams("select=*")), rep, body, false, "authenticated");
    const r = returning(b.sql);
    expect(r).toContain('a."full_name"');
    expect(r).toContain('a."department_id"');
    expect(r).not.toContain("pin_hash");
    expect(b.sql).not.toContain("pin_hash");
  });

  it("explicit select=pin_hash still asks Postgres for it — the column grant refuses it there", () => {
    const b = buildInsert(cat, "employees", parseQuery(new URLSearchParams("select=id,pin_hash")), rep, body, false, "authenticated");
    expect(returning(b.sql)).toContain('a."pin_hash"');
  });

  it("an embed returns the join column it needs; order columns are returned too", () => {
    const b = buildInsert(cat, "employees",
      parseQuery(new URLSearchParams("select=id,departments(name)&order=full_name.asc")), rep, body, false, "authenticated");
    const r = returning(b.sql);
    expect(r).toContain('a."department_id"');
    expect(r).toContain('a."full_name"');
    expect(r).not.toContain("pin_hash");
  });

  it("return=minimal returns no column at all", () => {
    const b = buildInsert(cat, "employees", parseQuery(new URLSearchParams("")), minimal, body, false, "authenticated");
    expect(returning(b.sql)).toBe("1");
  });

  it("update and delete follow the same rule", () => {
    const pq = parseQuery(new URLSearchParams("id=eq.00000000-0000-0000-0000-000000000009&select=id,full_name"));
    const u = buildUpdate(cat, "employees", pq, rep, { full_name: "B" }, false, "authenticated");
    expect(returning(u.sql)).toBe('a."id", a."full_name"');
    const d = buildDelete(cat, "employees", pq, rep, false, "authenticated");
    expect(returning(d.sql)).toBe('a."id", a."full_name"');
  });

  it("service (server-only) keeps every column on select=*", () => {
    const b = buildInsert(cat, "employees", parseQuery(new URLSearchParams("select=*")), rep, body, false, "service");
    expect(returning(b.sql)).toContain('a."pin_hash"');
  });
});
