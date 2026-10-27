import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* R-1824 (24 Oct 2026): scripts/ops/r1823-repair-reports.sql is run by the manager on staging
   and live to count the rows each R-1823 data-repair decision would touch. It must only READ:
   SELECT / WITH, inside `begin; set transaction read only; … rollback;`. This test fails if a
   write or DDL keyword appears anywhere outside a comment, or a contact field is selected. */

const FILE = fileURLToPath(new URL("../../scripts/ops/r1823-repair-reports.sql", import.meta.url));

/** The SQL with -- comments, block comments and string literals blanked (keywords in text are fine). */
function codeOnly(sql: string): string {
  // One pass, left to right, so "--" inside a string or a quote inside a comment is read right.
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}

const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop",
  "grant", "revoke", "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze",
  "reindex", "cluster", "refresh", "lock", "listen", "notify", "commit", "savepoint", "reset",
  "security", "into", "nextval", "setval", "dblink", "lo_import", "lo_export", "pg_terminate_backend",
  "pg_cancel_backend", "pg_advisory_lock", "set_config", "pg_read_file", "pg_write_file",
];

/** The forbidden words found; "set" is allowed only as `set transaction read only`. */
function forbidden(sql: string): string[] {
  const code = codeOnly(sql).toLowerCase();
  const hits = WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code));
  for (const s of code.match(/(^|[^\\\w])set\b[^;]*/g) ?? []) {
    if (!/set\s+transaction\s+read\s+only\s*$/.test(s.trim())) hits.push(`set: ${s.trim().slice(0, 40)}`);
  }
  // psql meta-commands other than \echo / \pset could run a file, a shell, or a \copy.
  for (const m of code.match(/\\[a-z!]+/g) ?? []) {
    if (m !== "\\echo" && m !== "\\pset") hits.push(m);
  }
  return hits;
}

describe("R-1824 repair reports — read-only", () => {
  const sql = readFileSync(FILE, "utf8");

  it("has no write, DDL or side-effect keyword outside comments", () => {
    expect(forbidden(sql)).toEqual([]);
  });

  it("runs inside begin; set transaction read only; … rollback;", () => {
    const code = codeOnly(sql).toLowerCase().replace(/\s+/g, " ").trim();
    expect(code.startsWith("begin; set transaction read only;")).toBe(true);
    expect(code.endsWith("rollback;")).toBe(true);
    expect(code.match(/\bbegin\b/g)?.length).toBe(1);
  });

  it("never selects an email or phone column", () => {
    expect(codeOnly(sql)).not.toMatch(/email|phone|mobile/i);
  });

  it("has one labelled section per R-1823 item, each with a count and max 20 samples", () => {
    const items = ["R-1711", "R-1635", "R-1716 + R-1653", "R-1652", "R-1709", "R-1643", "R-1708"];
    items.forEach((id, n) => expect(sql).toContain(`'=== ${n + 1}. ${id}:`));
    expect(sql.match(/limit 20;/g)?.length).toBe(items.length);
  });

  it("the checker itself catches a write (mutation check)", () => {
    expect(forbidden("begin; set transaction read only; update public.invoices set amount = 0; rollback;")).toContain("update");
    expect(forbidden("select 1; drop table x;")).toContain("drop");
    expect(forbidden("set role postgres;")).not.toEqual([]);
    expect(forbidden("\\i other.sql")).toContain("\\i");
    expect(forbidden("select x into t from y;")).toContain("into");
    expect(forbidden("select updated_at, created_at from t -- update here is a comment")).toEqual([]);
    expect(forbidden("select 'please update' as note")).toEqual([]);
  });
});
