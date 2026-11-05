/**
 * R-2484 (5 Nov 2026) — `npm run localhost:update` uses the deploy script's superseded rule (R-2480).
 *
 * Before: localhost-update skipped ANY pending migration whose function/view a later applied migration
 * redefines — without R-2480's "are its other parts in?" check. On Pardeep's laptop that skipped
 * 20261018173040_r1556_backup_mfa_tenant.sql (its current_user_has_role is redefined by R-1896/R-2471),
 * so get_tenant_backup — defined ONLY there with its R-1557 body — stayed on the old, unsafe body and the
 * local DB differed from staging/live.
 *
 * Now: the same data the deploy scripts carry (gen-deploy-db's widened peeks, later redefiners and
 * "rest" peeks — imported, not copied) and the same plan() states. A blocked migration stops the run
 * with the next step; `--repair` (local only) applies it in order and re-runs the newest body of every
 * function/view it overwrote. Fake DB in the R-2480 style: peeks evaluated against an in-memory state.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { supersededEntries, supersedePeeks, parseDeployHeaders } from "../../scripts/ops/gen-deploy-db.mjs";
import {
  deployEntries, planMigrations, peekScript, parsePeekOutput, runUpdate, EXIT, parseArgs,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/localhost-update.mjs";

const APP = path.resolve(__dirname, "../..");
const SUPA = path.join(APP, "supabase");
const MIG = path.join(SUPA, "migrations");

const BASH =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => fs.existsSync(p)) ?? null
    : spawnSync("bash", ["--version"]).status === 0
      ? "bash"
      : null;

/* Shaped like the R-2480 fixture (an older file with another part + a function later files redefine). */
const fnPeek = (fn: string, mark: string) => `exists(select 1 from pg_proc where oid = to_regprocedure('public.${fn}()') and prosrc like '%${mark}%')`;
const fnSql = (fn: string, mark: string) => `create or replace function public.${fn}() returns trigger language plpgsql as $$ begin /* ${mark} */ return new; end $$;\n`;
const FIX: Record<string, string> = {
  "20261101000000_a.sql": `-- deploy-peek: to_regclass('public.q_note') is not null and ${fnPeek("tg_f", "R-1")}\n-- deploy-key: r1\ncreate table public.q_note (id int);\n${fnSql("tg_f", "R-1")}`,
  "20261102000000_b.sql": `-- deploy-peek: ${fnPeek("tg_f", "R-2")}\n-- deploy-key: r2\n${fnSql("tg_f", "R-2")}`,
  "20261103000000_c.sql": `-- deploy-peek: ${fnPeek("tg_f", "R-3")} and to_regclass('public.trg_t') is not null\n-- deploy-key: r3\n${fnSql("tg_f", "R-3")}create table public.trg_t (id int);\n`,
  "20261104000000_d.sql": `-- deploy-peek: ${fnPeek("tg_f", "R-4")}\n-- deploy-key: r4\n${fnSql("tg_f", "R-4")}`,
  "20261105000000_e.sql": "-- deploy-peek: to_regclass('public.x') is not null\n-- deploy-key: e\ncreate table public.x (id int);\n",
};
const FILES = Object.keys(FIX).sort();

/* ── fake local DB: tables + function bodies; peeks are evaluated, migrations are "run" ── */
type Db = { tables: Set<string>; fns: Map<string, string> };
function evalPeek(expr: string, db: Db): boolean {
  const js = expr
    .replace(/exists\(select 1 from pg_proc where oid = to_regprocedure\('public\.(\w+)\(\)'\) and /g, '(cur = "$1", has(cur)) && (')
    .replace(/(?:\w+\.)?prosrc like '%([^%']+)%'/g, 'body(cur).includes("$1")')
    .replace(/to_regclass\('public\.(\w+)'\) is not null/g, 'tbl("$1")')
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("has", "body", "tbl", `let cur; return (${js});`);
  return Boolean(fn((f: string) => db.fns.has(f), (f: string) => db.fns.get(f) ?? "", (t: string) => db.tables.has(t)));
}
function runSql(sql: string, db: Db) {
  for (const m of sql.matchAll(/create table public\.(\w+)/g)) db.tables.add(m[1]);
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(\)[^$]*\$\$ begin \/\* ([^*]+) \*\//g)) db.fns.set(m[1], m[2].trim());
}
function fakePsql(db: Db, ran: string[], files: Record<string, string>) {
  return (sql: string, { stopOnError }: { stopOnError: boolean }) => {
    if (!stopOnError) {
      const out = [...sql.matchAll(/^select '([^|]+)\|' \|\| coalesce\(\((.*)\)::text, 'null'\);$/gm)]
        .map((m) => `${m[1]}|${evalPeek(m[2], db)}`).join("\n");
      return { status: 0, out };
    }
    const f = Object.keys(files).find((k) => files[k] === sql) ?? "?";
    ran.push(f);
    runSql(sql, db);
    return { status: 0, out: "ok" };
  };
}
/** A fake git that serves FIX as the target's migrations and never moves (HEAD = target). */
function fakeGit(files: Record<string, string>) {
  return (args: string[]) => {
    const a = args.join(" ");
    if (a.startsWith("symbolic-ref")) throw new Error("detached");
    if (a.startsWith("rev-parse")) return "abc1234567\n";
    if (a.startsWith("status")) return "";
    if (a.startsWith("ls-tree")) return Object.keys(files).join("\n") + "\nREADME.md\n";
    if (a.startsWith("show ")) return files[args[1].split("/").pop()!];
    return "";
  };
}
const db = (tables: string[], fns: Record<string, string>): Db => ({ tables: new Set(tables), fns: new Map(Object.entries(fns)) });
const run = (d: Db, opts: Record<string, unknown> = {}) => {
  const ran: string[] = [];
  const r = runUpdate({ git: fakeGit(FIX), psql: fakePsql(d, ran, FIX), noFetch: true, ...opts });
  return { ...r, ran, out: r.lines.join("\n") };
};

describe("R-2484 one source: the deploy generator's data", () => {
  const files = FILES.map((file) => ({ file, sql: FIX[file] }));
  it("later + rest come from gen-deploy-db's supersededEntries, peeks from its supersedePeeks", () => {
    const parsed = FILES.map((f) => ({ ...parseDeployHeaders(FIX[f], f), sql: FIX[f] }));
    const sups = supersededEntries(parsed);
    const wide = supersedePeeks(parsed);
    const mine = deployEntries(files);
    expect(mine.map((m: { key: string }) => m.key)).toEqual(["r1", "r2", "r3", "r4", "e"]);
    for (const s of sups) {
      const m = mine.find((x: { key: string }) => x.key === s.key);
      expect(m.later).toEqual(s.later);
      expect(m.rest).toBe(s.rest);
    }
    for (const w of wide) expect(mine.find((x: { key: string }) => x.key === w.key).peek).toBe(w.peek);
    expect(mine.find((x: { key: string }) => x.key === "r1").rest).toContain("to_regclass('public.q_note')");
    expect(mine.find((x: { key: string }) => x.key === "e").later).toEqual([]);
  });
  it("the peek script reads each rest check in the same read-only pass; output parsed per file", () => {
    const sql = peekScript(deployEntries(files));
    expect(sql).toContain("select '20261101000000_a.sql#rest|' || coalesce((to_regclass('public.q_note') is not null and");
    const m = parsePeekOutput("20261101000000_a.sql|false\n20261101000000_a.sql#rest|true\nERROR: x\n");
    expect([...m]).toEqual([["20261101000000_a.sql", "false"], ["20261101000000_a.sql#rest", "true"]]);
  });
  it("--repair is a known argument", () => {
    expect(parseArgs(["--repair"])).toMatchObject({ repair: true });
  });
});

/* ── the deploy script's own plan(), run in bash, against this planner ── */
function bashPlan(keys: string[], sups: Array<{ key: string; later: string[]; rest: string | null }>, vals: Record<string, string>) {
  const t = fs.readFileSync(path.join(SUPA, "cloudsql", "staging", "deploy-db-2026-10-07.sh"), "utf8").replace(/\r\n/g, "\n");
  const a = t.indexOf("declare -A LATER=()");
  const b = t.indexOf("\n}\n", a) + 3;
  const script = [
    "set -u",
    "MIGS=(", ...keys.map((k) => `  "${k}|f.sql|u|true"`), ")",
    "SUPS=(", ...sups.map((s) => `  "${s.key}|${s.later.join(" ")}|${s.rest ? "x" : ""}"`), ")",
    t.slice(a, b),
    `plan "${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(" ")}"`,
    'for m in "${MIGS[@]}"; do k="${m%%|*}"; echo "$k=${ST[$k]}:${BY[$k]:-}"; done',
  ].join("\n");
  const r = spawnSync(BASH!, ["-s"], { input: script, encoding: "utf8", timeout: 60_000 });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return Object.fromEntries(r.stdout.trim().split(/\r?\n/).map((l) => { const [k, v] = l.split("="); return [k, v]; }));
}
function jsPlan(entries: Array<{ file: string; key: string; later: string[]; rest: string | null; defines: string[] }>, vals: Record<string, string>) {
  const p = planMigrations(entries.map((e) => ({ ...e, status: vals[e.key] === "true" ? "applied" : "pending", rest: e.rest ? vals[`${e.key}_rest`] : undefined })));
  return Object.fromEntries(entries.map((e) => { const s = p.state.get(e.key); return [e.key, `${s.st === "in" ? "in" : s.st}:${s.by}`]; }));
}

describe.skipIf(!BASH)("R-2484 same rule as the deploy script's plan() (bash, from deploy-db-2026-10-07.sh)", () => {
  const entries = deployEntries(FILES.map((file) => ({ file, sql: FIX[file] })));
  const keys = entries.map((e: { key: string }) => e.key);
  const scenarios: Record<string, Record<string, string>> = {
    "staging-like (R-3 in, R-4 + e new)": { r1: "false", r2: "false", r3: "true", r4: "false", e: "false", r1_rest: "true", r2_rest: "true", r3_rest: "true" },
    "fresh DB": { r1: "false", r2: "false", r3: "false", r4: "false", e: "false", r1_rest: "false", r2_rest: "false", r3_rest: "false" },
    "newer body in, older's table missing (blocked)": { r1: "false", r2: "true", r3: "true", r4: "false", e: "false", r1_rest: "false", r2_rest: "true", r3_rest: "true" },
    "chain superseded through a superseded later": { r1: "false", r2: "false", r3: "false", r4: "true", e: "true", r1_rest: "true", r2_rest: "true", r3_rest: "true" },
    "middle blocked, older applied before it": { r1: "false", r2: "false", r3: "false", r4: "true", e: "true", r1_rest: "true", r2_rest: "true", r3_rest: "false" },
    "everything in": { r1: "true", r2: "true", r3: "true", r4: "true", e: "true", r1_rest: "true", r2_rest: "true", r3_rest: "true" },
  };
  for (const [name, vals] of Object.entries(scenarios)) {
    it(name, () => {
      const sups = entries.filter((e: { later: string[] }) => e.later.length).map((e: { key: string; later: string[]; rest: string | null }) => ({ key: e.key, later: e.later, rest: e.rest }));
      expect(jsPlan(entries, vals)).toEqual(bashPlan(keys, sups, vals));
    });
  }
});

describe("R-2484 runUpdate with the deploy rule (fake DB)", () => {
  it("staging-like: applies r4 and e only; r1/r2 superseded (their other parts are in)", () => {
    const d = db(["q_note", "trg_t"], { tg_f: "R-3" });
    const r = run(d);
    expect(r.code, r.out).toBe(EXIT.ok);
    expect(r.ran).toEqual(["20261104000000_d.sql", "20261105000000_e.sql"]);
    expect(r.out).toMatch(/skip 20261101000000_a\.sql — superseded by 20261103000000_c\.sql/);
    expect(d.fns.get("tg_f")).toBe("R-4");
  });

  it("fresh DB: every migration in file order, newest body wins", () => {
    const d = db([], {});
    const r = run(d);
    expect(r.code, r.out).toBe(EXIT.ok);
    expect(r.ran).toEqual(FILES);
    expect(d.fns.get("tg_f")).toBe("R-4");
  });

  it("the R-1556 case: newer body in but the older file's other part missing → STOP, nothing run, next step named", () => {
    const d = db(["trg_t", "x"], { tg_f: "R-4" });
    const r = run(d);
    expect(r.code).toBe(EXIT.blocked);
    expect(r.ran).toEqual([]);
    expect(r.out).toMatch(/20261101000000_a\.sql/);
    expect(r.out).toMatch(/--repair/);
    expect(d.tables.has("q_note")).toBe(false);
  });

  it("--dry-run --repair prints the repair plan and changes nothing", () => {
    const d = db(["trg_t", "x"], { tg_f: "R-4" });
    const r = run(d, { dryRun: true, repair: true });
    expect(r.code, r.out).toBe(EXIT.ok);
    expect(r.ran).toEqual([]);
    expect(r.out).toMatch(/\[dry-run\] lagata: 20261101000000_a\.sql/);
    expect(r.out).toMatch(/\[dry-run\] dobara chalata[^\n]*20261104000000_d\.sql/);
  });

  it("--repair: applies the blocked file, then re-runs the newest body (R-4) — table in, tg_f still newest; second run applies none", () => {
    const d = db(["trg_t", "x"], { tg_f: "R-4" });
    const r = run(d, { repair: true });
    expect(r.code, r.out).toBe(EXIT.ok);
    expect(r.ran).toEqual(["20261101000000_a.sql", "20261104000000_d.sql"]);
    expect(d.tables.has("q_note")).toBe(true);
    expect(d.fns.get("tg_f")).toBe("R-4");
    const r2 = run(d);
    expect(r2.code, r2.out).toBe(EXIT.ok);
    expect(r2.ran).toEqual([]);
  });

  it("an unknown newest body: --repair refuses the whole repair (never runs over it)", () => {
    const files = { ...FIX, "20261104000000_d.sql": FIX["20261104000000_d.sql"].replace("-- deploy-peek: ", "-- deploy-peek: null and ") };
    const ran: string[] = [];
    const d = db(["trg_t", "x"], { tg_f: "R-4" });
    const psql = (sql: string, o: { stopOnError: boolean }) => {
      if (!o.stopOnError) return { status: 0, out: [...sql.matchAll(/^select '([^|]+)\|' \|\| coalesce\(\((.*)\)::text, 'null'\);$/gm)].map((m) => `${m[1]}|${m[2].startsWith("null and") ? "null" : evalPeek(m[2], d)}`).join("\n") };
      ran.push(sql); return { status: 0, out: "" };
    };
    const r = runUpdate({ git: fakeGit(files), psql, noFetch: true, repair: true });
    expect(ran).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/\? 20261104000000_d\.sql/);
  });
});

describe("R-2484 the real files: R-1556 is no longer silently skipped", () => {
  const names = fs.readdirSync(MIG).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  const entries = deployEntries(names.map((file) => ({ file, sql: fs.readFileSync(path.join(MIG, file), "utf8") })));
  const R1556 = "20261018173040_r1556_backup_mfa_tenant.sql";
  const LIST = "20261010223000_list_tenant_backups_ambiguous_id.sql";

  it("this laptop's state (all in except R-1556 + list_tenant_backups fix): blocked, and --repair re-runs only the newest definers", () => {
    const status = (f: string) => (f === R1556 || f === LIST ? "pending" : "applied");
    const migs = entries.map((e: { file: string; key: string; rest: string | null }) => ({ ...e, status: status(e.file), rest: e.rest ? "true" : undefined }));
    const plain = planMigrations(migs);
    expect(plain.blocked.map((b: { file: string }) => b.file)).toEqual([R1556]);
    expect(plain.skip.map((s: { file: string }) => s.file)).not.toContain(R1556);
    const rep = planMigrations(migs, { repair: true });
    expect(rep.apply).toEqual(expect.arrayContaining([LIST, R1556]));
    expect(rep.apply.indexOf(LIST)).toBeLessThan(rep.apply.indexOf(R1556));
    expect(rep.repairStops).toEqual([]);
    /* every object R-1556 defines ends on its newest definer: get_tenant_backup's newest IS R-1556 */
    const r1556 = entries.find((e: { file: string }) => e.file === R1556);
    for (const obj of r1556.defines) {
      const newest = [...entries].reverse().find((e: { defines: string[] }) => e.defines.includes(obj));
      expect(rep.apply, obj).toContain(newest.file);
    }
    expect(rep.rerun).not.toContain(R1556);
    expect(rep.rerun.every((f: string) => f > R1556)).toBe(true);
  });
});
