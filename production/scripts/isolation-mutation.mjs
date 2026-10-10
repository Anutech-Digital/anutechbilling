/**
 * Proves the tenant-isolation tests can FAIL. A test that cannot go red proves nothing.
 *
 *   npm run db:local              # once
 *   node scripts/isolation-mutation.mjs
 *
 * 1. The unmodified suite must be green.
 * 2. Each mutation below breaks tenant isolation in one realistic way — on a throwaway copy
 *    of the database, or in a temporary copy of the source — and the suite must go RED.
 * 3. Everything is put back (the database copy is dropped, cluster-wide changes such as role
 *    grants are undone, source files restored) even if a step crashes. Exit code 0 only if every mutation was caught.
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PORT = 54329;
const BASE_DB = process.env.MUTATION_BASE_DB ?? "ros";
const MUT_DB = "ros_mutant";
const psql = (db, sql) =>
  execSync(`docker exec -i ros-pg psql -U postgres -d ${db} -v ON_ERROR_STOP=1 -q`, { input: sql, stdio: ["pipe", "pipe", "pipe"] });

function suite(db) {
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://app_runtime:localdev@localhost:${PORT}/${db}`,
    JOBS_DATABASE_URL: `postgresql://app_jobs:localdev@localhost:${PORT}/${db}`,
    ADMIN_DATABASE_URL: `postgresql://postgres:localdev@localhost:${PORT}/${db}`,
  };
  const iso = spawnSync("npx", ["vitest", "run", "--config", "vitest.isolation.config.ts"], { env, shell: true, encoding: "utf8" });
  const unit = spawnSync("npx", ["vitest", "run", "src/server/db"], { env, shell: true, encoding: "utf8" });
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const summary = (r) => (strip(r.stdout).match(/Tests\s+.*$/m) ?? ["(no summary)"])[0].trim();
  return { green: iso.status === 0 && unit.status === 0, iso: summary(iso), unit: summary(unit) };
}

function cloneDb() {
  psql("postgres", `drop database if exists ${MUT_DB} with (force);`);
  psql("postgres", `create database ${MUT_DB} template ${BASE_DB};`);
}
const dropClone = () => psql("postgres", `drop database if exists ${MUT_DB} with (force);`);

function withSourceChange(file, from, to, fn) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from}`);
  writeFileSync(file, original.replace(from, to));
  try { return fn(); } finally { writeFileSync(file, original); }
}

const MUTATIONS = [
  {
    name: "a forgotten / wrong policy: invoices readable by every signed-in user",
    db: `create policy zz_mutant_open on public.invoices for select to authenticated using (true);`,
  },
  {
    name: "the tenant helper trusts app.tenant_id without checking the user belongs to it",
    db: `create or replace function public.current_tenant_id() returns uuid
           language sql stable security definer set search_path = '' as $$
           select case when session_user in ('app_runtime','app_jobs')
             then nullif(current_setting('app.tenant_id', true), '')::uuid
             else (select tenant_id from public.users where id = auth.uid() limit 1) end $$;`,
  },
  {
    name: "the app's login is given the service_role bypass",
    db: `grant service_role to app_runtime;`,
    // Roles are CLUSTER-wide, not per database: dropping the copy does not undo this.
    undo: `revoke service_role from app_runtime;`,
  },
  {
    name: "withTenant forgets to set the context",
    source: ["src/server/db/context.ts", "await tx.$executeRaw`select set_config('app.user_id', ${userId ?? \"\"}, true),\n                              set_config('app.tenant_id', ${tenantId}, true)`;", "void tx; void userId; void tenantId;"],
  },
  {
    name: "the context is set session-wide instead of per transaction (pool leak)",
    source: ["src/server/db/context.ts", "set_config('app.tenant_id', ${tenantId}, true)", "set_config('app.tenant_id', ${tenantId}, false)"],
  },
];

let failed = 0;
console.log(`baseline on ${BASE_DB} …`);
const base = suite(BASE_DB);
console.log(`  isolation: ${base.iso}\n  boundary:  ${base.unit}`);
if (!base.green) {
  console.error("✗ the unmodified suite is not green — fix that first; mutations would prove nothing.");
  process.exit(1);
}

for (const m of MUTATIONS) {
  let r;
  try {
    if (m.db) {
      cloneDb();
      psql(MUT_DB, m.db);
      r = suite(MUT_DB);
    } else {
      r = withSourceChange(m.source[0], m.source[1], m.source[2], () => suite(BASE_DB));
    }
  } finally {
    if (m.undo) psql("postgres", m.undo);
    if (m.db) dropClone();
  }
  const caught = !r.green;
  if (!caught) failed++;
  console.log(`${caught ? "✓ caught" : "✗ MISSED"}  ${m.name}\n    isolation: ${r.iso}\n    boundary:  ${r.unit}`);
}

console.log(failed ? `\n✗ ${failed} mutation(s) left the suite green — the tests have a hole.` : "\n✓ every mutation turned the suite red.");
process.exit(failed ? 1 : 0);
