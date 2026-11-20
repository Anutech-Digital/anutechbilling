#!/usr/bin/env node
/**
 * R-2941 concurrency check — two sessions add a person to the SAME task at the same moment; the task already has 2.
 * With the guard (task_collaborators_guard) the second one waits for the first, counts its row and is refused:
 * the task ends with 3 people, never 4.
 *
 *   node scripts/dev/r2941-concurrency-check.mjs
 *
 * Why a script and not the .test.sql: two sessions only see each other's rows once committed, and a .test.sql is
 * one rolled-back transaction (its case 6 proves only the lock MODE). A trigger cannot be session-local, so this
 * does not touch the app's database at all: it creates a throwaway database `r2941_scratch` in the LOCAL docker
 * Postgres with four tiny tables (tenants, users, tasks, task_collaborators — same columns the guard reads, same
 * unique rule and foreign keys), loads section 1 of the migration file AS WRITTEN (function + trigger), runs two
 * psql sessions in parallel, and drops the database again (also first, so a crashed run does not block the next).
 * The local app database never gets R-2941 applied by this check.
 *
 * It then runs the same race against the guard with its row-lock line removed (the control): that one MUST end
 * with 4 rows — otherwise the first result proves nothing.
 *
 * LOCAL docker DB only: it talks to the container supabase_db_resellerosv3 through `docker exec`, nothing else.
 * Exit 0 = guard: 3 rows + the second session refused by the guard; control: 4 rows. 1 = not.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTAINER = "supabase_db_resellerosv3";
const SCRATCH = "r2941_scratch";
const MIG_DIR = path.join(PROD, "supabase", "migrations");
const MIGRATION = fs.readdirSync(MIG_DIR).filter((f) => /_r2941_task_guards\.sql$/.test(f)).sort().pop();
const LOCK_LINE = /^\s*perform 1 from public\.tasks t where t\.id = NEW\.task_id for no key update;\s*$/m;

const T = "c2941000-0000-4000-8000-0000000000f1";
const TASK = "c2941000-0000-4000-8000-0000000000d1";
const user = (n) => `c2941000-0000-4000-8000-00000000000${n}`;
const ARGS = (db) => ["exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qtA"];

function psql(db, sql) {
  const r = spawnSync("docker", ARGS(db), { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
function session(sql) {
  return new Promise((resolve) => {
    const p = spawn("docker", ARGS(SCRATCH));
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out: out.trim() }));
    p.stdin.end(sql);
  });
}

/** Section 1 of the migration (the collaborators guard + its trigger), exactly as written. */
function guardSql() {
  if (!MIGRATION) throw new Error("no *_r2941_task_guards.sql migration found");
  const src = fs.readFileSync(path.join(MIG_DIR, MIGRATION), "utf8").replace(/\r\n/g, "\n");
  const m = src.match(/^-- ── 1\.[\s\S]*?(?=^-- ── 2\.)/m);
  if (!m) throw new Error(`section 1 not found in ${MIGRATION}`);
  if (!LOCK_LINE.test(m[0])) throw new Error("the guard's row-lock line was not found — update LOCK_LINE in this script");
  return m[0];
}

const dropScratch = () => psql("postgres", `drop database if exists ${SCRATCH} with (force);`);

function setup(guard) {
  dropScratch();
  psql("postgres", `create database ${SCRATCH};`);
  psql(SCRATCH, `
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    create table public.tenants (id uuid primary key);
    create table public.users (id uuid primary key, tenant_id uuid not null references public.tenants(id), is_active boolean default true);
    create table public.tasks (id uuid primary key, tenant_id uuid not null references public.tenants(id), title text);
    create table public.task_collaborators (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references public.tenants(id) on delete cascade,
      task_id uuid not null references public.tasks(id) on delete cascade,
      user_id uuid not null references public.users(id) on delete cascade,
      added_by uuid references public.users(id) on delete set null,
      created_at timestamptz not null default now(),
      constraint task_collaborators_uniq unique (task_id, user_id));
    insert into public.tenants values ('${T}');
    insert into public.users (id, tenant_id) values ${[1, 2, 3, 4].map((n) => `('${user(n)}', '${T}')`).join(", ")};
    insert into public.tasks values ('${TASK}', '${T}', 'R2941 race');
    ${guard}
    insert into public.task_collaborators (tenant_id, task_id, user_id) values ('${T}', '${TASK}', '${user(1)}'), ('${T}', '${TASK}', '${user(2)}');`);
}

async function race(label, guard) {
  setup(guard);
  const add = (n) => `insert into public.task_collaborators (tenant_id, task_id, user_id) values ('${T}', '${TASK}', '${user(n)}');`;
  // A holds its transaction open for 3 s after its insert; B starts 1 s in.
  const a = session(`begin; ${add(3)} select pg_sleep(3); commit;`);
  await new Promise((r) => setTimeout(r, 1000));
  const t0 = Date.now();
  const b = await session(add(4));
  const waitedMs = Date.now() - t0;
  const ra = await a;
  const rows = Number(psql(SCRATCH, `select count(*) from public.task_collaborators where task_id = '${TASK}';`));
  console.log(`${label}: session A exit ${ra.code}; session B exit ${b.code} after ${waitedMs} ms${b.out ? ` — ${b.out.split("\n")[0]}` : ""}; rows on the task: ${rows}`);
  return { a: ra, b, rows, waitedMs };
}

let ok = false;
try {
  const guard = guardSql();
  const withGuard = await race("guard as written    ", guard);
  const control = await race("control (no row lock)", guard.replace(LOCK_LINE, ""));
  const guardOk = withGuard.rows === 3 && withGuard.a.code === 0 && withGuard.b.code !== 0
    && /R-2941: a task can have up to 3 people/.test(withGuard.b.out) && withGuard.waitedMs >= 1500;
  const controlOk = control.rows === 4;
  if (!guardOk) console.error("✗ with the guard the task did not end with exactly 3 people and a plain refusal of the second session (after waiting for the first)");
  if (!controlOk) console.error("✗ the control did not reach 4 rows — this check would not notice a missing lock");
  ok = guardOk && controlOk;
  if (ok) console.log("✓ R-2941: two saves at the same moment cannot give a task a 4th person (and without the lock they can)");
} finally {
  dropScratch();
}
process.exit(ok ? 0 : 1);
