/**
 * R-2106 — `npm run localhost:update` (scripts/ops/localhost-update.mjs).
 * Never runs against the real reselleros-deploy or the real remote: pure helpers, fakes, and a real
 * throwaway git repo in the OS temp folder whose "anutech" remote is another temp repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  planMigrations, redefinedObjects, parsePorcelain, planLocalEdits, stashShaFor, stashRefFor,
  parsePeekOutput, peekScript, restartHints, runUpdate, EXIT, parseArgs,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/localhost-update.mjs";
// @ts-expect-error — plain .mjs script, no types
import { LOCAL_CRON_SECRET } from "../../scripts/cron-local.mjs";

const APP = path.resolve(__dirname, "../..");
const MIG = path.join(APP, "supabase", "migrations");
const read = (f: string) => fs.readFileSync(path.join(MIG, f), "utf8");

describe("superseded migrations (alsoDo4: the three real files)", () => {
  const A = "20261010223000_list_tenant_backups_ambiguous_id.sql";
  const B = "20261018173040_r1556_backup_mfa_tenant.sql";
  const C = "20261025141647_r1896_employee_exit.sql";

  it("skips 223000 and 173040 (peek false) because 141647 (applied) redefines what 173040 defines", () => {
    const migs = [
      { file: A, defines: redefinedObjects(read(A)), status: "pending" },
      { file: B, defines: redefinedObjects(read(B)), status: "pending" },
      { file: C, defines: redefinedObjects(read(C)), status: "applied" },
    ];
    const plan = planMigrations(migs);
    expect(plan.apply).toEqual([]);
    expect(plan.skip.map((s: { file: string }) => s.file)).toEqual([A, B]);
    expect(plan.skip.find((s: { file: string }) => s.file === B)!.reason).toMatch(/superseded by 20261025141647_r1896_employee_exit\.sql \(function current_user_has_role; applied\)/);
    expect(plan.skip.find((s: { file: string }) => s.file === A)!.reason).toMatch(/superseded by 20261018173040_r1556_backup_mfa_tenant\.sql \(function list_tenant_backups; itself skipped\)/);
  });

  it("without the newer applied one, both old ones are applied in version order", () => {
    const plan = planMigrations([
      { file: B, defines: redefinedObjects(read(B)), status: "pending" },
      { file: A, defines: redefinedObjects(read(A)), status: "pending" },
    ]);
    expect(plan.apply).toEqual([A, B]);
    expect(plan.skip).toEqual([]);
  });

  it("a pending migration with no later redefinition is applied; an unknown later definer blocks", () => {
    const plan = planMigrations([
      { file: "20261030131008_x.sql", defines: [], status: "pending" },
      { file: "20261001000000_f.sql", defines: ["function f"], status: "pending" },
      { file: "20261002000000_g.sql", defines: ["function f"], status: "unknown" },
      { file: "20261003000000_h.sql", defines: ["view v"], status: "applied" },
    ]);
    expect(plan.apply).toEqual(["20261030131008_x.sql"]);
    expect(plan.skip[0].reason).toMatch(/peek unknown/);
    expect(plan.unknown).toEqual(["20261002000000_g.sql"]);
    expect(plan.applied).toBe(1);
  });

  it("redefinedObjects: functions + views, not tables, comments ignored", () => {
    const sql = `-- create function public.not_me()\ncreate or replace function public."Foo"(a int)\ncreate table if not exists public.t (id int);\ncreate or replace view public.v_x as select 1;`;
    expect(redefinedObjects(sql).sort()).toEqual(["function foo", "view v_x"]);
  });
});

describe("helpers", () => {
  it("porcelain + local edit plan: dev-local kept, other tracked edits block, untracked ignored", () => {
    const e = parsePorcelain(" M production/scripts/dev-local.mjs\n M production/src/x.ts\n?? production/src/server/\n");
    expect(planLocalEdits(e)).toEqual({ kept: ["production/scripts/dev-local.mjs"], blockers: ["M production/src/x.ts"] });
  });
  it("stash entries are found by tag, not by position", () => {
    const tag = "localhost-update-2026-10-31T02-00-00-000Z-1";
    expect(stashShaFor(`aaaaaaa1 On w: other\nbbbbbbb2 On (no branch): ${tag}\n`, tag)).toBe("bbbbbbb2");
    expect(stashRefFor(`stash@{0} On w: other\nstash@{1} On (no branch): ${tag}\n`, tag)).toBe("stash@{1}");
    expect(stashRefFor("stash@{0} On w: other", tag)).toBeNull();
  });
  it("peek script/output round-trip; an errored peek is simply absent", () => {
    expect(peekScript([{ file: "20260101000000_a.sql", peek: "true" }])).toContain("select '20260101000000_a.sql|' || coalesce((true)::text, 'null');");
    const m = parsePeekOutput("20260101000000_a.sql|true\nERROR: boom\n20260102000000_b.sql|false\n20260103000000_c.sql|null\n");
    expect([...m]).toEqual([["20260101000000_a.sql", "true"], ["20260102000000_b.sql", "false"], ["20260103000000_c.sql", "null"]]);
  });
  it("restart hints name package/config changes and never restart anything", () => {
    const l = restartHints(["production/package-lock.json", "production/next.config.ts", "production/src/a.ts"]);
    expect(l.join("\n")).toMatch(/npm ci/);
    expect(l.join("\n")).toMatch(/restart/);
    expect(restartHints(["production/src/a.ts"])).toEqual([]);
  });
  it("parseArgs", () => {
    expect(parseArgs(["--dry-run", "--dir", "x"])).toMatchObject({ dryRun: true, dir: "x" });
    expect(() => parseArgs(["--push"])).toThrow();
  });
});

/* ───────── real git, throwaway repos (never the real remote / reselleros-deploy) ───────── */
describe("runUpdate on a throwaway checkout", () => {
  let tmp: string, remote: string, deploy: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const g = (cwd: string) => (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  const write = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const DEV = 'const ALLOW = new Set([\n  "NODE_ENV",\n]);\nconst x = 1;\n';
  const mig = (name: string) => `-- deploy-peek: to_regclass('public.${name}') is not null\ncreate table public.${name} (id int);\n`;

  /** Fake local DB: tables created by applied migrations. */
  function fakePsql(state: Set<string>, calls: string[]) {
    return (sql: string, { stopOnError }: { stopOnError: boolean }) => {
      if (!stopOnError) {
        const out = [...sql.matchAll(/select '([^|]+)\|' \|\| coalesce\(\(to_regclass\('public\.(\w+)'\) is not null\)::text, 'null'\);/g)]
          .map((m) => `${m[1]}|${state.has(m[2])}`).join("\n");
        return { status: 0, out };
      }
      const t = /create table public\.(\w+)/.exec(sql)![1];
      calls.push(t); state.add(t);
      return { status: 0, out: "CREATE TABLE" };
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2106-lu-"));
    remote = path.join(tmp, "remote"); deploy = path.join(tmp, "deploy");
    fs.mkdirSync(remote);
    g(remote)(["init", "-q", "-b", "manager-pardeep"]);
    write(remote, "production/scripts/dev-local.mjs", DEV);
    write(remote, "production/supabase/migrations/20261001000000_t_one.sql", mig("t_one"));
    write(remote, "production/supabase/migrations/README.md", "x");
    g(remote)(["add", "-A"]); g(remote)(["commit", "-q", "-m", "R-10: one"]);
    g(tmp)(["clone", "-q", "-o", "anutech", remote, "deploy"]);
    g(deploy)(["checkout", "-q", "--detach", "anutech/manager-pardeep"]);
    /* the local edit the coordinator keeps */
    fs.writeFileSync(path.join(deploy, "production/scripts/dev-local.mjs"), DEV.replace('"NODE_ENV",', '"NODE_ENV", "ZOHO_BOOKS_CLIENT_ID",'));
    /* upstream moves on: a new migration + a code change (R-20) */
    write(remote, "production/supabase/migrations/20261030000000_t_two.sql", mig("t_two"));
    write(remote, "production/src/a.ts", "export const a = 2;\n");
    g(remote)(["add", "-A"]); g(remote)(["commit", "-q", "-m", "R-20: two"]);
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("dry-run changes nothing: same HEAD, no stash, no migration run", () => {
    const state = new Set(["t_one"]); const calls: string[] = [];
    const head = g(deploy)(["rev-parse", "HEAD"]).trim();
    const r = runUpdate({ git: g(deploy), psql: fakePsql(state, calls), dryRun: true, tmpDir: tmp });
    expect(r.code).toBe(EXIT.ok);
    expect(g(deploy)(["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(g(deploy)(["stash", "list"]).trim()).toBe("");
    expect(calls).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/\[dry-run\] lagata: 20261030000000_t_two\.sql/);
  });

  it("moves to the newest commit, keeps the dev-local edit, drops its stash, applies only the missing migration; a second run applies none", () => {
    const state = new Set(["t_one"]); const calls: string[] = [];
    g(deploy)(["stash", "push", "-q", "-m", "someone-else", "--", "production/scripts/dev-local.mjs"]);
    g(deploy)(["stash", "apply", "-q"]); // another session's stash entry stays at the bottom, untouched
    const r = runUpdate({ git: g(deploy), psql: fakePsql(state, calls), tmpDir: tmp });
    expect(r.code, r.lines.join("\n")).toBe(EXIT.ok);
    expect(g(deploy)(["rev-parse", "HEAD"]).trim()).toBe(g(remote)(["rev-parse", "HEAD"]).trim());
    expect(fs.readFileSync(path.join(deploy, "production/scripts/dev-local.mjs"), "utf8")).toContain("ZOHO_BOOKS_CLIENT_ID");
    expect(g(deploy)(["stash", "list", "--format=%gs"]).trim().split("\n")).toEqual([expect.stringMatching(/someone-else$/)]);
    expect(calls).toEqual(["t_two"]);
    const out = r.lines.join("\n");
    expect(out).toMatch(/Cards: R-20/);
    expect(out).toMatch(/✓ lagaya: 20261030000000_t_two\.sql/);
    expect(out).toContain(LOCAL_CRON_SECRET);
    expect(out).toMatch(/Dev server ko haath NAHI lagaya/);

    const r2 = runUpdate({ git: g(deploy), psql: fakePsql(state, calls), tmpDir: tmp });
    expect(r2.code).toBe(EXIT.ok);
    expect(calls).toEqual(["t_two"]);
    expect(r2.lines.join("\n")).toMatch(/Koi migration lagani nahi thi/);
  });

  it("refuses (and touches nothing) when another tracked file is modified, or when on a branch", () => {
    fs.writeFileSync(path.join(deploy, "production/supabase/migrations/README.md"), "changed");
    const head = g(deploy)(["rev-parse", "HEAD"]).trim();
    const r = runUpdate({ git: g(deploy), psql: fakePsql(new Set(), []), tmpDir: tmp });
    expect(r.code).toBe(EXIT.refused);
    expect(g(deploy)(["rev-parse", "HEAD"]).trim()).toBe(head);
    g(deploy)(["checkout", "-q", "--", "production/supabase/migrations/README.md"]);
    g(deploy)(["stash", "push", "-q", "-m", "tmp", "--", "production/scripts/dev-local.mjs"]);
    g(deploy)(["checkout", "-q", "-b", "some-branch"]);
    expect(runUpdate({ git: g(deploy), psql: fakePsql(new Set(), []), tmpDir: tmp }).code).toBe(EXIT.refused);
  });

  it("no local DB → code moved, migrations not checked, exit 4", () => {
    const r = runUpdate({ git: g(deploy), psql: null, tmpDir: tmp });
    expect(r.code).toBe(EXIT.noDb);
    expect(g(deploy)(["rev-parse", "HEAD"]).trim()).toBe(g(remote)(["rev-parse", "HEAD"]).trim());
  });
});
