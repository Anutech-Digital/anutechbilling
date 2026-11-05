import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  generate,
  parseDeployHeaders,
  redefinedObjects,
  functionsDefined,
  supersededEntries,
  residualPeek,
  supsFromScript,
  healthPeeks,
  peeksFromScript,
  filesInScript,
  ENVS,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../scripts/ops/gen-deploy-db.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { redefinedObjects as localhostRedefined } from "../scripts/ops/localhost-update.mjs";

/* R-2480 (5 Nov 2026, p0). After R-2473's marker rule, staging (at the R-2447 body of
   tg_quote_approval_not_by_maker) reads R-2383's peek false — it accepts only R-2383's own marker or the
   NEWEST redefiner's (R-2470, not in yet). The deploy-db step applies every false peek in file order, so
   it would RE-RUN R-2383 (and R-2426, R-2441) and put their older, weaker approval rule back, then rely on
   later files to fix it — R-2447 would not even re-run (its peek is true). localhost-update.mjs already
   skips such a file as "superseded"; the deploy script did not.

   Rule now (both deploy scripts + the app's /api/health/migrations):
   - a migration whose peek is false is SUPERSEDED — not re-run, reported as superseded (green) — when a
     LATER migration in the list that redefines the same function/view is already in (or itself
     superseded) AND the migration's other parts are in: its peek with the prosrc checks on those
     redefined functions read as true ("_rest");
   - when a newer redefiner is in but the other parts are NOT (a column/table/trigger is missing), the
     script STOPS before changing anything: re-running would put the old body back, skipping would lose
     the column. A new migration is the fix;
   - with no newer redefiner in (a fresh DB), everything is applied in file order as before. */

const APP = path.resolve(__dirname, "..");
const SUPA = path.join(APP, "supabase");

const BASH =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => fs.existsSync(p)) ?? null
    : spawnSync("bash", ["--version"]).status === 0
      ? "bash"
      : null;

const parse = (sql: string, f: string) => ({ ...parseDeployHeaders(sql, f), sql });

/* Five migrations shaped like the real R-2383 → R-2470 chain. */
const FIX: Record<string, string> = {
  "20261101000000_a.sql":
    "-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'q' and column_name = 'note') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-1%')\n-- deploy-key: r1\nalter table public.q add column if not exists note text;\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-1 */ return new; end $$;\n",
  "20261102000000_b.sql":
    "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-2%')\n-- deploy-key: r2\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-2 */ return new; end $$;\n",
  "20261103000000_c.sql":
    "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-3%') and exists(select 1 from pg_trigger where tgname = 'trg_f')\n-- deploy-key: r3\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-3 */ return new; end $$;\ncreate trigger trg_f before insert on public.q for each row execute function public.tg_f();\n",
  "20261104000000_d.sql":
    "-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and prosrc like '%R-4%')\n-- deploy-key: r4\ncreate or replace function public.tg_f() returns trigger language plpgsql as $$ begin /* R-4 */ return new; end $$;\n",
  "20261105000000_e.sql": "-- deploy-peek: to_regclass('public.x') is not null\n-- deploy-key: e\ncreate table public.x (id int);\n",
};
const FIX_FILES = Object.keys(FIX).sort();

describe("R-2480 one parser: which functions/views a migration defines", () => {
  it("gen-deploy-db and localhost-update use the same function", () => {
    expect(localhostRedefined).toBe(redefinedObjects);
  });
  it("functions + views; -- and /* */ comments ignored; functionsDefined is the function part", () => {
    const sql = "/* create function public.no_a() */\n-- create function public.no_b()\ncreate or replace function public.\"Foo\"(a int) returns int language sql as $$ select 1 $$;\ncreate or replace view public.v_x as select 1;\ncreate table public.t (id int);";
    expect(redefinedObjects(sql).sort()).toEqual(["function foo", "view v_x"]);
    expect([...functionsDefined(sql)]).toEqual(["foo"]);
  });
});

describe("R-2480 supersede list (generator)", () => {
  const entries = FIX_FILES.map((f) => parse(FIX[f], f));

  it("each migration with a later redefiner names its later redefiners and its 'other parts' check", () => {
    const sups = supersededEntries(entries);
    expect(sups.map((s: { key: string }) => s.key)).toEqual(["r1", "r2", "r3"]);
    const r1 = sups[0];
    expect(r1.later).toEqual(["r2", "r3", "r4"]);
    /* the column check stays; the prosrc check on the redefined function reads true */
    expect(r1.rest).toBe("exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'q' and column_name = 'note') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and true)");
    expect(sups[2].rest).toBe("exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_f()') and true) and exists(select 1 from pg_trigger where tgname = 'trg_f')");
  });

  it("a skipped migration is never a redefiner; a peek with no prosrc test on the function has no separate rest", () => {
    const skipped = entries.map((e, i) => (i >= 1 && i <= 3 ? { ...e, skip: "later" } : e));
    expect(supersededEntries(skipped)).toEqual([]);
    const colOnly = parse("-- deploy-peek: to_regclass('public.y') is not null\n-- deploy-key: y\ncreate table public.y(); create or replace function public.tg_f() returns trigger language plpgsql as $$ begin return new; end $$;\n", "20261100000000_y.sql");
    const s = supersededEntries([colOnly, entries[3]]);
    expect(s).toEqual([{ key: "y", later: ["r4"], rest: null }]);
  });

  it("residualPeek leaves a not-exists (body must be gone) check alone", () => {
    const gone = "not exists(select 1 from pg_proc where proname = 'tg_f' and prosrc like '%legacy%')";
    expect(residualPeek(gone, new Set(["tg_f"]))).toBe(gone);
  });
});

/* ── the real bash deploy script, run with a fake gcloud ─────────────────────────────────────── */

type Run = { status: number | null; out: string; imported: string[]; peekSql: string };

function fakeGcloud(dir: string) {
  const f = path.join(dir, "gcloud");
  fs.writeFileSync(
    f,
    [
      "#!/usr/bin/env bash",
      'S="$R2480_STATE"',
      'case "$1 $2" in',
      '  "config get-value") echo tester@example.test;;',
      '  "storage cp") case "$(basename "$4")" in peek-*) cp "$3" "$S/peek.sql";; esac;;',
      '  "sql import") basename "$5" >> "$S/imports.log";;',
      '  "sql operations") c=$(cat "$S/n" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "$S/n"; if [ $c -eq 1 ]; then cat "$S/before.txt"; else cat "$S/after.txt"; fi;;',
      '  "sql backups") case "$*" in *"value(status)"*) echo SUCCESSFUL;; *) echo ok;; esac;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(f, 0o755);
}

const opsJson = (vals: Record<string, string>) =>
  JSON.stringify([{ operationType: "IMPORT", error: { errors: [{ message: `ERROR: PEEK ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(" ")}\nCONTEXT: PL/pgSQL function inline_code_block` }] } }], null, 2);

/** Runs `scriptFile` (inside a supabase dir laid out like the repo) with before/after PEEK answers. */
function runScript(scriptFile: string, before: Record<string, string>, after: Record<string, string>, extraEnv: Record<string, string> = {}): Run {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "r2480-state-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "r2480-bin-"));
  fakeGcloud(bin);
  fs.writeFileSync(path.join(state, "before.txt"), opsJson(before));
  fs.writeFileSync(path.join(state, "after.txt"), opsJson(after));
  const input = [
    'B="$R2480_BIN"; command -v cygpath >/dev/null 2>&1 && B="$(cygpath -u "$B")"',
    'export PATH="$B:$PATH"',
    'S="$R2480_SCRIPT"; command -v cygpath >/dev/null 2>&1 && S="$(cygpath -u "$S")"',
    'SKIP_BACKUP=1 bash "$S"',
  ].join("\n");
  const r = spawnSync(BASH!, ["-s"], { input, encoding: "utf8", timeout: 380_000, env: { ...process.env, R2480_STATE: state, R2480_BIN: bin, R2480_SCRIPT: scriptFile, ...extraEnv } });
  const log = path.join(state, "imports.log");
  const imported = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter((l) => /^\d{14}_/.test(l)) : [];
  const peekSql = fs.existsSync(path.join(state, "peek.sql")) ? fs.readFileSync(path.join(state, "peek.sql"), "utf8") : "";
  fs.rmSync(state, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, imported, peekSql };
}

/** A supabase dir with the fixture migrations and today's two deploy scripts regenerated over them. */
function fixtureDir(): { dir: string; script: (env: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2480-supa-"));
  fs.mkdirSync(path.join(dir, "migrations"));
  for (const f of FIX_FILES) fs.writeFileSync(path.join(dir, "migrations", f), FIX[f]);
  for (const env of ENVS) {
    fs.mkdirSync(path.join(dir, "cloudsql", env), { recursive: true });
    fs.copyFileSync(path.join(SUPA, "cloudsql", env, "deploy-db-2026-10-07.sh"), path.join(dir, "cloudsql", env, "deploy-db-2026-10-07.sh"));
  }
  const res = generate({ supabaseDir: dir, date: "2026-10-07", since: "20261101000000" });
  for (const env of ENVS) fs.writeFileSync(res.scripts[env].file, res.scripts[env].after);
  return { dir, script: (env) => path.join(dir, "cloudsql", env, "deploy-db-2026-10-07.sh") };
}

const allTrue = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, "true"]));

describe.skipIf(!BASH)("R-2480 deploy-db script never re-runs a superseded migration (fake gcloud)", () => {
  const fx = fixtureDir();
  const keys = ["r1", "r2", "r3", "r4", "e"];
  const rests = { r1_rest: "true", r2_rest: "true", r3_rest: "true" };

  for (const env of ["staging", "live"]) {
    const extra: Record<string, string> = env === "staging" ? { cuid: "true" } : {};
    it(`${env}: staging-like state (R-3 body in, R-4 + e new) → applies only r4 and e; r1/r2 reported superseded`, () => {
      const before = { r1: "false", r2: "false", r3: "true", r4: "false", e: "false", ...rests, ...extra };
      const after = { ...allTrue(keys), r1: "false", r2: "false", ...rests, ...extra };
      const r = runScript(fx.script(env), before, after);
      expect(r.status, r.out).toBe(0);
      expect(r.imported).toEqual(["20261104000000_d.sql", "20261105000000_e.sql"]);
      expect(r.out).toMatch(/-- r1: superseded by r3/);
      expect(r.out).toMatch(/-- r2: superseded by r3/);
      expect(r.out).toContain("DB READY");
      expect(r.out).toMatch(/Superseded[^\n]*r1 r2/);
      /* the "other parts" checks are read in the same read-only PEEK */
      expect(r.peekSql).toContain("'r1_rest=' || coalesce((exists(select 1 from information_schema.columns");
    });

    it(`${env}: a fresh DB (nothing in) → every migration applied, in file order`, () => {
      const before = { ...Object.fromEntries(keys.map((k) => [k, "false"])), r1_rest: "false", r2_rest: "false", r3_rest: "false", ...extra };
      const r = runScript(fx.script(env), before, { ...allTrue(keys), ...rests, ...extra });
      expect(r.status, r.out).toBe(0);
      expect(r.imported).toEqual(FIX_FILES);
      expect(r.out).toContain("DB READY");
    });

    it(`${env}: newer body in but the older file's column is missing → STOP before any change`, () => {
      const before = { r1: "false", r2: "true", r3: "true", r4: "false", e: "false", r1_rest: "false", r2_rest: "true", r3_rest: "true", ...extra };
      const r = runScript(fx.script(env), before, before);
      expect(r.status).toBe(1);
      expect(r.imported).toEqual([]);
      expect(r.out).toMatch(/r1 \(newer: r2\)/);
      expect(r.out).toMatch(/Nothing changed/);
      expect(r.out).not.toContain("DB READY");
    });

    it(`${env}: a PEEK line that does not answer for every key → nothing changed`, () => {
      const before = { r1: "true", r2: "true", ...extra };
      const r = runScript(fx.script(env), before, before);
      expect(r.status).toBe(1);
      expect(r.imported).toEqual([]);
      expect(r.out).toMatch(/did not answer for: r4|did not answer for:.*r3/);
    });

    /* Review (5 Nov): a value cut short ("tr") is no answer — never read as "false → apply". */
    it(`${env}: a cut-short value (r4=tr) counts as no answer → nothing changed`, () => {
      const before = { r1: "true", r2: "true", r3: "true", e: "true", ...rests, ...extra, r4: "tr" };
      const r = runScript(fx.script(env), before, before);
      expect(r.status).toBe(1);
      expect(r.imported).toEqual([]);
      expect(r.out).toMatch(/did not answer for: r4/);
    });

    /* Review (5 Nov): the way on when a later migration on purpose removed what an older peek checks. */
    it(`${env}: ACCEPT_SUPERSEDED="r1" (after a check) lets a blocked key through as superseded`, () => {
      const before = { r1: "false", r2: "true", r3: "true", r4: "true", e: "true", r1_rest: "false", r2_rest: "true", r3_rest: "true", ...extra };
      const r = runScript(fx.script(env), before, before, { ACCEPT_SUPERSEDED: "r1" });
      expect(r.status, r.out).toBe(0);
      expect(r.imported).toEqual([]);
      expect(r.out).toMatch(/-- r1: superseded by r2 \(ACCEPT_SUPERSEDED\)/);
      expect(r.out).toContain("DB READY");
    });
  }
});

describe("R-2480 plan() is one copy", () => {
  it("staging and live carry the same SUPS loader + plan() text", () => {
    const part = (env: string) => {
      const t = fs.readFileSync(path.join(SUPA, "cloudsql", env, "deploy-db-2026-10-07.sh"), "utf8").replace(/\r\n/g, "\n");
      const a = t.indexOf("declare -A LATER=()");
      const b = t.indexOf("\n}\n", a);
      expect(a, env).toBeGreaterThan(-1);
      return t.slice(a, b);
    };
    expect(part("live")).toBe(part("staging"));
  });
});

/* ── today's real list ───────────────────────────────────────────────────────────────────────── */

describe("R-2480 today's deploy scripts", () => {
  const script = fs.readFileSync(path.join(SUPA, "cloudsql", "staging", "deploy-db-2026-10-07.sh"), "utf8");
  const sups = supsFromScript(script, "staging") as Array<{ key: string; later: string[]; rest: string | null }>;
  const migKeys = (peeksFromScript(script, "staging") as Array<{ key: string }>).map((p) => p.key);

  it("R-2383, R-2426, R-2441 and R-2447 name R-2470 as a later redefiner; R-2383's other part (approval_note) is still checked", () => {
    const r2383 = sups.find((s) => s.key === "r2383soleownerapproval")!;
    expect(r2383.later).toEqual(expect.arrayContaining(["r2426soleownersanytier", "r2441approvalroleprefixedrefs", "r2447quoteapprovalinsertmoneychange", "r2470quoteapprovalheaderbelowcost"]));
    expect(r2383.rest).toContain("column_name = 'approval_note'");
    expect(r2383.rest).not.toMatch(/prosrc/);
    for (const k of ["r2426soleownersanytier", "r2441approvalroleprefixedrefs", "r2447quoteapprovalinsertmoneychange"]) {
      expect(sups.find((x) => x.key === k)?.later, k).toContain("r2470quoteapprovalheaderbelowcost");
    }
  });

  it("both real deploy scripts carry the SUPS block and run plan() before applying anything", () => {
    for (const env of ENVS) {
      const text = fs.readFileSync(path.join(SUPA, "cloudsql", env, "deploy-db-2026-10-07.sh"), "utf8");
      expect(supsFromScript(text, env).length, env).toBeGreaterThan(100);
      expect(text.indexOf('plan "$BEFORE"'), env).toBeGreaterThan(-1);
      expect(text.indexOf('plan "$BEFORE"'), env).toBeLessThan(text.indexOf("Apply what is missing"));
    }
  });

  it("every SUPS key is a MIGS key and only names LATER MIGS keys", () => {
    for (const s of sups) {
      const i = migKeys.indexOf(s.key);
      expect(i, s.key).toBeGreaterThanOrEqual(0);
      for (const l of s.later) expect(migKeys.indexOf(l), `${s.key} → ${l}`).toBeGreaterThan(i);
    }
    expect(filesInScript(script, "staging").length).toBe(migKeys.length);
  });

  it("health peeks: a migration with a separate rest check is green when either its marker or its rest is in", () => {
    const hp = healthPeeks(peeksFromScript(script, "staging"), sups) as Array<{ key: string; peek: string }>;
    expect(hp.length).toBe(migKeys.length);
    const own = (peeksFromScript(script, "staging") as Array<{ key: string; peek: string }>).find((p) => p.key === "r2383soleownerapproval")!.peek;
    const r2383 = sups.find((s) => s.key === "r2383soleownerapproval")!;
    expect(hp.find((p) => p.key === "r2383soleownerapproval")!.peek).toBe(`(${own}) or (${r2383.rest})`);
  });

  it.skipIf(!BASH)("staging today (R-2447 body in, R-2470 new): the plan applies R-2470 only — never R-2383/R-2426/R-2441", () => {
    const vals: Record<string, string> = { ...allTrue(migKeys), cuid: "true" };
    for (const s of sups) if (s.rest) vals[`${s.key}_rest`] = "true";
    /* what R-2473's widened peeks read on staging now: the R-2447 body has neither R-2383 nor R-2470 */
    for (const k of ["r2383soleownerapproval", "r2426soleownersanytier", "r2441approvalroleprefixedrefs", "r2470quoteapprovalheaderbelowcost"]) vals[k] = "false";
    const r = runScript(path.join(SUPA, "cloudsql", "staging", "deploy-db-2026-10-07.sh"), vals, { ...vals, ...allTrue(["r2470quoteapprovalheaderbelowcost"]) });
    expect(r.status, r.out.slice(-2000)).toBe(0);
    expect(r.imported).toEqual(["20261105000100_r2470_quote_approval_header_below_cost.sql"]);
    expect(r.out).toMatch(/-- r2383soleownerapproval: superseded by /);
    expect(r.out).toContain("DB READY");
  }, 400_000);
});
