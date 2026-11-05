import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { parseDeployHeaders, supersedePeeks, pgProcPeekChecks, functionsDefined, defaultKey, selectFiles, filesInScript, replaceMigs, splitScript, generate, buildMigsBody, ENVS, peeksFromScript, renderPeeksModule, PEEKS_FILE, healthPeeks, supsFromScript } from "../scripts/ops/gen-deploy-db.mjs";

// R-385 (7 Oct 2026): the MIGS array of the day's staging + live deploy-db scripts is generated
// from `-- deploy-peek:` headers in the migrations instead of hand-edited (6 hand edits on 7 Oct).
const supabaseDir = path.resolve(__dirname, "..", "supabase");
type Gen = { files: string[]; scripts: Record<string, { before: string; after: string }> };

describe("gen-deploy-db headers", () => {
  it("reads key, peek and user from the top comment block", () => {
    const h = parseDeployHeaders("-- deploy-key: oneterm\r\n-- deploy-peek: exists(select 1 from pg_trigger where tgname='t')\r\n-- note\r\ncreate table x();\r\n", "20261007160000_quote_one_billing_term.sql");
    expect(h).toEqual({ file: "20261007160000_quote_one_billing_term.sql", key: "oneterm", user: "resellersos_migration", peek: "exists(select 1 from pg_trigger where tgname='t')", skip: null });
    expect(parseDeployHeaders("-- deploy-peek: true\n-- deploy-user: postgres\n", "20261008000000_a_b.sql").user).toBe("postgres");
  });

  it("defaults the key from the file name", () => {
    expect(defaultKey("20261008000000_Quote_one-term.sql")).toBe("quoteoneterm");
    expect(parseDeployHeaders("-- deploy-peek: true\n", "20261008000000_page_test_runs_more.sql").key).toBe("pagetestruns");
  });

  it("fails loudly when deploy-peek is missing — or only appears below the SQL", () => {
    expect(() => parseDeployHeaders("-- R-999 something\ncreate table x();\n", "20261008000000_x.sql")).toThrow(/20261008000000_x\.sql: no "-- deploy-peek:/);
    expect(() => parseDeployHeaders("create table x();\n-- deploy-peek: true\n", "20261008000000_x.sql")).toThrow(/deploy-peek/);
  });

  it("refuses a peek that would break the bash line", () => {
    for (const bad of ["a|b", 'x="1"', "$x", "`x`"]) {
      expect(() => parseDeployHeaders(`-- deploy-peek: ${bad}\n`, "20261008000000_x.sql")).toThrow(/may not contain/);
    }
  });

  it("reads deploy-skip (R-531: a file kept in the repo but out of every deploy)", () => {
    expect(parseDeployHeaders("-- deploy-peek: true\n-- deploy-skip: R-531 redesign\n", "20261008000000_a_b.sql").skip).toBe("R-531 redesign");
    expect(parseDeployHeaders("-- deploy-peek: true\n", "20261008000000_a_b.sql").skip).toBeNull();
  });

  it("refuses two migrations with the same key", () => {
    const e = { key: "k", user: "u", peek: "true" };
    expect(() => buildMigsBody([{ ...e, file: "a.sql" }, { ...e, file: "b.sql" }])).toThrow(/used by both a\.sql and b\.sql/);
  });
});

describe("gen-deploy-db file choice + rewrite", () => {
  const files = ["20261006130000_a.sql", "20261007000000_b.sql", "20261007100000_c.sql", "20261005000000_old.sql", "README.md"];

  it("--since takes every migration from that version", () => {
    expect(selectFiles(files, { since: "20261007000000" })).toEqual(["20261007000000_b.sql", "20261007100000_c.sql"]);
  });

  it("no flag: what the script lists + every newer migration (a new file lands by itself)", () => {
    expect(selectFiles(files, { listed: ["20261006130000_a.sql", "20261007000000_b.sql"] })).toEqual(["20261006130000_a.sql", "20261007000000_b.sql", "20261007100000_c.sql"]);
    expect(() => selectFiles(files, { listed: ["20261009000000_gone.sql"] })).toThrow(/do not exist/);
  });

  it("replaces only the MIGS lines, keeping everything else byte-identical", () => {
    const text = "#!/usr/bin/env bash\nx=1\nMIGS=(\n  \"a|f.sql|u|true\"\n)\nfield() { :; }\n# sed -e 's/auth\\.uid()/x/g'\n";
    const out = replaceMigs(text, ['  "b|g.sql|u|false"'], "t");
    expect(out).toBe(text.replace('"a|f.sql|u|true"', '"b|g.sql|u|false"'));
    expect(filesInScript(text, "t")).toEqual(["f.sql"]);
    expect(() => splitScript("no block\n", "t")).toThrow(/no "MIGS=\("/);
  });
});

/* Copy both migration homes: supabase/migrations, and prisma/migrations where the staging
   branch (R-161) keeps applied ones — so these tests pass on either branch. */
function copyMigrations(tmpSupabase: string) {
  fs.cpSync(path.join(supabaseDir, "migrations"), path.join(tmpSupabase, "migrations"), { recursive: true });
  const prisma = path.join(supabaseDir, "..", "prisma", "migrations");
  if (fs.existsSync(prisma)) fs.cpSync(prisma, path.join(tmpSupabase, "..", "prisma", "migrations"), { recursive: true });
}
describe("today's deploy scripts (7 Oct 2026)", () => {
  it("regenerating is a no-op — the headers carry exactly the peeks the scripts had", () => {
    const res: Gen = generate({ supabaseDir, date: "2026-10-07" });
    /* The count grows every time a migration lands — pin "no drift", not a number. */
    expect(res.files.length).toBeGreaterThanOrEqual(17);
    expect(res.files).toEqual(res.files.slice().sort());
    for (const env of ENVS) expect(res.scripts[env].after).toBe(res.scripts[env].before);
    const since: Gen = generate({ supabaseDir, date: "2026-10-07", since: "20261006130000" });
    expect(since.files).toEqual(res.files);
    for (const env of ENVS) expect(since.scripts[env].after).toBe(since.scripts[env].before);
  });

  it("R-531: the global authenticator pre_request never reaches a deploy script", () => {
    const res: Gen = generate({ supabaseDir, date: "2026-10-07" });
    expect(res.files.some((f: string) => f.startsWith("20261009220100_"))).toBe(false);
    for (const env of ENVS) {
      expect(res.scripts[env].after).not.toContain("20261009220100_");
      expect(res.scripts[env].after).not.toMatch(/alter role authenticator/i);
    }
  });

  it("staging keeps its auth.uid() rewrite; live never gets it", () => {
    const res: Gen = generate({ supabaseDir, date: "2026-10-07" });
    expect(res.scripts.staging.after).toContain("s/auth\\.uid()/public.current_user_id()/g");
    expect(res.scripts.live.after).not.toContain("current_user_id()/g");
  });

  it("finds a listed migration the staging branch moved to prisma/migrations (R-161 layout)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-deploy-db-prisma-"));
    try {
      const tmp = path.join(root, "supabase");
      copyMigrations(tmp);
      for (const env of ENVS) {
        fs.mkdirSync(path.join(tmp, "cloudsql", env), { recursive: true });
        fs.copyFileSync(path.join(supabaseDir, "cloudsql", env, "deploy-db-2026-10-07.sh"), path.join(tmp, "cloudsql", env, "deploy-db-2026-10-07.sh"));
      }
      const moved = "20261006130000_feedback_checked";
      if (fs.existsSync(path.join(tmp, "migrations", `${moved}.sql`))) {
        fs.mkdirSync(path.join(root, "prisma", "migrations", moved), { recursive: true });
        fs.renameSync(path.join(tmp, "migrations", `${moved}.sql`), path.join(root, "prisma", "migrations", moved, "migration.sql"));
      }
      const res: Gen = generate({ supabaseDir: tmp, date: "2026-10-07" });
      expect(res.files).toContain(`${moved}.sql`);
      for (const env of ENVS) expect(res.scripts[env].after).toBe(res.scripts[env].before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("a new migration with a header is appended to BOTH scripts; one without fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-deploy-db-"));
    const tmp = path.join(root, "supabase");
    try {
      copyMigrations(tmp);
      for (const env of ENVS) {
        fs.mkdirSync(path.join(tmp, "cloudsql", env), { recursive: true });
        fs.copyFileSync(path.join(supabaseDir, "cloudsql", env, "deploy-db-2026-10-07.sh"), path.join(tmp, "cloudsql", env, "deploy-db-2026-10-07.sh"));
      }
      fs.writeFileSync(path.join(tmp, "migrations", "29991231000000_new_thing.sql"), "-- deploy-peek: to_regclass('public.new_thing') is not null\ncreate table public.new_thing();\n");
      const res: Gen = generate({ supabaseDir: tmp, date: "2026-10-07" });
      for (const env of ENVS) {
        const before = res.scripts[env].before.split("\n");
        const added = res.scripts[env].after.split("\n").filter((l) => !before.includes(l));
        expect(added).toEqual([`  "newthing|29991231000000_new_thing.sql|resellersos_migration|to_regclass('public.new_thing') is not null"`]);
      }
      fs.writeFileSync(path.join(tmp, "migrations", "29991231000059_no_header.sql"), "-- forgot\nselect 1;\n");
      expect(() => generate({ supabaseDir: tmp, date: "2026-10-07" })).toThrow(/29991231000059_no_header\.sql: no "-- deploy-peek:/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("migration versions", () => {
  it("no two migration files share a version (9 Oct: two workers both picked 20261009180000)", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of fs.readdirSync(path.join(supabaseDir, "migrations")).filter((x) => /^\d{14}_.*\.sql$/.test(x))) {
      const v = f.slice(0, 14);
      if (seen.has(v)) clashes.push(`${seen.get(v)} + ${f}`); else seen.set(v, f);
    }
    expect(clashes).toEqual([]);
  });
});

/* R-1721 (21 Oct 2026): the deployed app checks its own DB against this list. 21 Oct the staging DB
   step stopped after the backup and new code ran ~1 hour without 4 migrations. The list is fixed at
   build time — a committed file this generator writes from the MIGS block — never SQL from a request. */
describe("R-1721 peeks.generated.ts (what /api/health/migrations checks)", () => {
  const appDir = path.resolve(supabaseDir, "..");

  it("is in sync with the newest staging deploy-db script — rerun gen-deploy-db if this fails", () => {
    const dir = path.join(supabaseDir, "cloudsql", "staging");
    const newest = fs.readdirSync(dir).filter((n) => /^deploy-db-\d{4}-\d{2}-\d{2}\.sh$/.test(n)).sort().pop()!;
    const script = fs.readFileSync(path.join(dir, newest), "utf8");
    /* R-2480: a superseded migration's entry also accepts its "other parts" check (SUPS block). */
    const want = renderPeeksModule(healthPeeks(peeksFromScript(script, newest), supsFromScript(script, newest)), `supabase/cloudsql/staging/${newest}`);
    const have = fs.readFileSync(path.join(appDir, PEEKS_FILE), "utf8").replace(/\r\n/g, "\n");
    expect(have, "run: node scripts/ops/gen-deploy-db.mjs --date " + newest.slice(10, 20)).toBe(want);
  });

  it("carries every MIGS key once, and every peek is the script's own text", () => {
    const script = fs.readFileSync(path.join(supabaseDir, "cloudsql", "staging", "deploy-db-2026-10-07.sh"), "utf8");
    const peeks = peeksFromScript(script, "staging") as Array<{ key: string; peek: string }>;
    expect(peeks.length).toBe(filesInScript(script, "staging").length);
    expect(new Set(peeks.map((p) => p.key)).size).toBe(peeks.length);
    expect(peeks.find((p) => p.key === "r1707quoteopenbalances")?.peek).toBe("exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_open_balances()') and prosrc like '%R-1707%')");
  });

  it("renders plain data the app can import (quotes escaped, one entry per line)", () => {
    const out = renderPeeksModule([{ key: "a", peek: "x like '%\\%'" }], "s.sh");
    expect(out).toContain(`{ key: "a", peek: "x like '%\\\\%'" },`);
    expect(out).toMatch(/^\/\* GENERATED/);
  });
});

/* R-2473 (4 Nov 2026): the staging train's DB step and smoke said "DB step chhoot gaya:
   r2383soleownerapproval" although every migration was applied. R-2383's peek greps
   tg_quote_approval_not_by_maker()'s prosrc for 'R-2383'; R-2426, R-2441 and R-2447 redefined that
   function and the newest body no longer carries the text. Worse, the next DB step would see the peek
   false and RE-APPLY R-2383 — bringing the old function body back over R-2447.
   Rule: when a later migration in the deploy list redefines a function, an older peek's prosrc text
   check on that function also accepts the NEWEST redefiner's own prosrc marker for it. */
describe("R-2473 a peek on a function a later migration redefines", () => {
  const older = "-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'q' and column_name = 'note') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-1%')\n-- deploy-key: r1\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-1 */ return new; end $$;\n";
  const mid = "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-2%')\n-- deploy-key: r2\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-2 */ return new; end $$;\n";
  const newest = "-- deploy-peek: exists(select 1 from pg_proc where proname = 'tg_f' and pronamespace = 'public'::regnamespace and prosrc ilike '%R-3%') and to_regclass('public.other') is not null\n-- deploy-key: r3\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-3 */ return new; end $$;\n";
  const parse = (sql: string, f: string) => ({ ...parseDeployHeaders(sql, f), sql });

  it("older prosrc markers also accept the newest redefiner's marker; columns/tables stay as they were", () => {
    const out = supersedePeeks([parse(older, "20261101000000_a.sql"), parse(mid, "20261102000000_b.sql"), parse(newest, "20261103000000_c.sql")]);
    expect(out[0].peek).toBe("exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'q' and column_name = 'note') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and (prosrc like '%R-1%' or prosrc ilike '%R-3%'))");
    expect(out[1].peek).toBe("exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and (prosrc like '%R-2%' or prosrc ilike '%R-3%'))");
    expect(out[2].peek).toBe(parse(newest, "c").peek);
  });

  it("a skipped migration never counts as the redefiner; a different function is untouched", () => {
    const skipped = { ...parse(newest, "20261103000000_c.sql"), skip: "not yet" };
    const other = parse(mid.replace(/tg_f/g, "tg_g"), "20261104000000_d.sql");
    const out = supersedePeeks([parse(older, "20261101000000_a.sql"), skipped, other]);
    expect(out[0].peek).toBe(parse(older, "a").peek);
  });

  it("a newest redefiner with no prosrc marker on that function: the older check accepts its whole peek", () => {
    const bare = "-- deploy-peek: to_regprocedure('public.tg_f()') is not null and to_regclass('public.t2') is not null\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin return new; end $$;\n";
    const out = supersedePeeks([parse(older, "20261101000000_a.sql"), parse(bare, "20261105000000_e.sql")]);
    expect(out[0].peek).toContain("and (prosrc like '%R-1%' or (to_regprocedure('public.tg_f()') is not null and to_regclass('public.t2') is not null)))");
  });

  it("keeps a table alias on the marker it adds (p.prosrc)", () => {
    const aliased = "-- deploy-peek: exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'tg_f' and p.prosrc like '%R-1%')\ncreate function public.tg_f() returns int language sql as $$ select 1 $$;\n";
    const out = supersedePeeks([parse(aliased, "20261101000000_a.sql"), parse(mid, "20261102000000_b.sql")]);
    expect(out[0].peek).toContain("and (p.prosrc like '%R-1%' or p.prosrc like '%R-2%'))");
  });

  /* Review findings (4 Nov): these shapes must never be widened or broken. */
  it("leaves a not-exists check (body must be GONE) and a block comment's 'create function' alone", () => {
    const gone = "-- deploy-peek: not exists(select 1 from pg_proc where proname = 'tg_f' and prosrc like '%legacy%')\ncreate or replace function public.tg_f() returns int language sql as $$ select 1 $$;\n";
    const commentOnly = "-- deploy-peek: to_regclass('public.x') is not null\n/* was: create or replace function public.tg_f() */\ncreate table public.x();\n";
    expect(supersedePeeks([parse(gone, "20261101000000_a.sql"), parse(mid, "20261102000000_b.sql")])[0].peek).toBe(parse(gone, "a").peek);
    expect(supersedePeeks([parse(older, "20261101000000_a.sql"), parse(commentOnly, "20261102000000_b.sql")])[0].peek).toBe(parse(older, "a").peek);
  });

  it("a nested pg_proc block is widened once, for its own function only", () => {
    const nested = "-- deploy-peek: exists(select 1 from pg_proc p where p.oid = to_regprocedure('public.tg_a()') and exists(select 1 from pg_proc q where q.oid = to_regprocedure('public.tg_f()') and q.prosrc like '%R-1%'))\ncreate function public.tg_a() returns int language sql as $$ select 1 $$;\n";
    const out = supersedePeeks([parse(nested, "20261101000000_a.sql"), parse(mid, "20261102000000_b.sql")]);
    expect(out[0].peek).toBe("exists(select 1 from pg_proc p where p.oid = to_regprocedure('public.tg_a()') and exists(select 1 from pg_proc q where q.oid = to_regprocedure('public.tg_f()') and (q.prosrc like '%R-1%' or q.prosrc like '%R-2%')))");
  });

  it("an overload's marker is not taken for another argument list; a quoted '' stays inside its literal", () => {
    const twoArg = "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.f(text, integer)') and prosrc like '%can''t%')\ncreate function public.f(a text, b integer) returns int language sql as $$ select 1 $$;\n";
    const otherOverload = "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.f(text)') and prosrc like '%R-9%')\ncreate function public.f(a text) returns int language sql as $$ select 1 $$;\n";
    const out = supersedePeeks([parse(twoArg, "20261101000000_a.sql"), parse(otherOverload, "20261102000000_b.sql")]);
    /* No same-signature marker → falls back to the newest migration's whole peek, never its 1-arg marker alone. */
    expect(out[0].peek).toBe("exists(select 1 from pg_proc where oid = to_regprocedure('public.f(text, integer)') and (prosrc like '%can''t%' or (exists(select 1 from pg_proc where oid = to_regprocedure('public.f(text)') and prosrc like '%R-9%'))))");
  });

  /* The class, not just r2383: every prosrc marker in today's MIGS lines on a function that a later
     listed migration redefines must also accept that newest redefiner's marker (or its whole peek). */
  it("today's scripts: every superseded prosrc marker accepts the newest redefiner's", () => {
    const script = fs.readFileSync(path.join(supabaseDir, "cloudsql", "staging", "deploy-db-2026-10-07.sh"), "utf8");
    const peeks = peeksFromScript(script, "staging") as Array<{ key: string; peek: string }>;
    const files = filesInScript(script, "staging") as string[];
    const sqlOf = (f: string) => {
      const a = path.join(supabaseDir, "migrations", f);
      return fs.readFileSync(fs.existsSync(a) ? a : path.join(supabaseDir, "..", "prisma", "migrations", f.replace(/\.sql$/, ""), "migration.sql"), "utf8");
    };
    const defines = files.map((f) => functionsDefined(sqlOf(f)) as Set<string>);
    const ownPeek = files.map((f) => parseDeployHeaders(sqlOf(f), f).peek as string);
    const misses: string[] = [];
    peeks.forEach((p, i) => {
      for (const c of pgProcPeekChecks(ownPeek[i]) as Array<{ fn: string; sig: string | null; tests: Array<{ test: string }> }>) {
        let j = -1;
        for (let k = files.length - 1; k > i; k--) if (defines[k].has(c.fn)) { j = k; break; }
        if (j < 0) continue;
        const own = (pgProcPeekChecks(ownPeek[j]) as Array<{ fn: string; sig: string | null; tests: Array<{ test: string }> }>).find((n) => n.fn === c.fn && (!n.sig || !c.sig || n.sig === c.sig))?.tests[0]?.test;
        const ok = own ? p.peek.toLowerCase().includes(own.toLowerCase()) : p.peek.includes(`(${peeks[j].peek})`);
        if (!ok) misses.push(`${p.key}: ${c.fn}() redefined by ${files[j]}`);
      }
    });
    expect(misses).toEqual([]);
    const r2383 = peeks.find((p) => p.key === "r2383soleownerapproval")!.peek;
    expect(r2383).toContain("column_name = 'approval_note'");
    /* the newest redefiner of tg_quote_approval_not_by_maker (R-2447, R-2470 …): the misses check above
       proves it is the right one — R-2470: pinning one card id here broke on every redefinition. */
    expect(r2383).toMatch(/\(prosrc like '%R-2383%' or prosrc like '%R-\d{3,5}%'\)/);
  });
});
