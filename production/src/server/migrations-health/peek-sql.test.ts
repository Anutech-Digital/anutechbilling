import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPeekSql, missingKeys, CATALOG_COLUMNS_SQL, CATALOG_COLUMN_FIELDS } from "./peek-sql";
import { MIGRATION_PEEKS } from "./peeks.generated";

/* R-1721: one read-only query, one boolean per migration, built only from the build-time list. */
describe("peek SQL", () => {
  const p = [{ key: "a", peek: "true" }, { key: "b", peek: "to_regclass('public.b') is not null" }];

  it("is one select returning a boolean array, peeks in list order", () => {
    expect(buildPeekSql(p)).toBe("select array[(true), (to_regclass('public.b') is not null)]::boolean[] as r");
  });

  it("missing = keys whose value is not exactly true (short array counts as missing)", () => {
    expect(missingKeys(p, [true, true])).toEqual([]);
    expect(missingKeys(p, [false, true])).toEqual(["a"]);
    expect(missingKeys(p, [true])).toEqual(["b"]);
  });

  it("the generated list is not empty and its keys are unique", () => {
    expect(MIGRATION_PEEKS.length).toBeGreaterThan(100);
    expect(new Set(MIGRATION_PEEKS.map((x) => x.key)).size).toBe(MIGRATION_PEEKS.length);
  });

  it("refuses a peek that could end the statement or start another", () => {
    expect(() => buildPeekSql([{ key: "x", peek: "true); drop table t; --" }])).toThrow(/x/);
  });
});

/* R-2695 (12 Nov 2026): staging 3afa13f — DB step said paidcampaignplatformlinks = true (run as the
   table owner), the app said it is missing. information_schema.columns hides columns the login has
   no privilege on, and the app's login (app_service → service_role) had none on
   marketing_campaigns. The app must ask pg_catalog instead, with the peek text unchanged. */
describe("peek SQL — the app's login must not change the answer (R-2695)", () => {
  const real = MIGRATION_PEEKS.find((x) => x.key === "paidcampaignplatformlinks");

  it("the built SQL never reads the privilege-filtered information_schema.columns", () => {
    expect(real).toBeDefined();
    const sql = buildPeekSql([real!]);
    expect(sql).not.toMatch(/information_schema/i);
    expect(sql.startsWith(`with isc_columns as ${CATALOG_COLUMNS_SQL} select array[`)).toBe(true);
    expect(sql).toContain(
      "exists(select 1 from isc_columns where table_schema = 'public' and table_name = 'marketing_campaigns' and column_name = 'ads_manager_url')",
    );
  });

  it("no peek in the whole generated list reaches information_schema, and the stand-in is defined once", () => {
    const sql = buildPeekSql(MIGRATION_PEEKS);
    expect(sql).not.toMatch(/information_schema/i);
    expect(sql.split(CATALOG_COLUMNS_SQL).length - 1).toBe(1);
  });

  /* The rewrite is plain text, so every generated peek must use information_schema only as
     `from information_schema.columns where <fields the stand-in has>`, never inside a quoted
     string, never aliased or quoted. A new peek written otherwise fails here, not on staging. */
  it("every generated peek uses information_schema.columns only in the shape the app can swap", () => {
    const allowed = new Set<string>(CATALOG_COLUMN_FIELDS);
    const bad: string[] = [];
    let seen = 0;
    for (const p of MIGRATION_PEEKS) {
      const all = p.peek.match(/information_schema/gi)?.length ?? 0;
      const swappable = p.peek.match(/\bfrom information_schema\.columns where\b/gi)?.length ?? 0;
      const outsideQuotes = p.peek.replace(/'(?:[^']|'')*'/g, "''").match(/\bfrom information_schema\.columns where\b/gi)?.length ?? 0;
      if (all !== swappable || swappable !== outsideQuotes) bad.push(`${p.key}: shape`);
      for (const m of p.peek.matchAll(/\bfrom information_schema\.columns where ([^)]*)\)/gi)) {
        const fields = [...m[1].replace(/'(?:[^']|'')*'/g, "''").matchAll(/\b([a-z_][a-z0-9_.]*)\s*(?:=|<>|!=|\bis\b|\bin\b|\blike\b|\bilike\b)/gi)].map((f) => f[1].toLowerCase());
        seen += fields.length;
        for (const f of fields) if (!allowed.has(f)) bad.push(`${p.key}: field ${f}`);
      }
    }
    expect(bad).toEqual([]);
    expect(seen).toBeGreaterThan(400); /* 140 uses × 3+ fields — the guard is really reading them */
  });

  it("a peek without information_schema is left exactly as written", () => {
    expect(buildPeekSql([{ key: "b", peek: "to_regclass('public.b') is not null" }])).toBe(
      "select array[(to_regclass('public.b') is not null)]::boolean[] as r",
    );
  });

  it("the catalog stand-in is itself a safe single expression", () => {
    expect(CATALOG_COLUMNS_SQL).not.toMatch(/;|--|\/\*/);
  });

  it("the SQL proof file runs the exact same catalog text (rewrite one, the other fails)", () => {
    const sqlTest = readFileSync(join(process.cwd(), "supabase/tests/r2695_migration_peek_login_blind.test.sql"), "utf8");
    /* Every copy in the proof file (blocks A and B) is the shipped text — none left behind. */
    const copies = sqlTest.split("from pg_catalog.pg_attribute a").length - 1;
    expect(copies).toBe(2);
    expect(sqlTest.split(CATALOG_COLUMNS_SQL).length - 1).toBe(copies);
  });
});
