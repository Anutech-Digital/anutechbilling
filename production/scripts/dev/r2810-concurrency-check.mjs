#!/usr/bin/env node
/**
 * R-2810 concurrency check — two "Bill together" calls for the SAME parts at the same moment make ONE proforma;
 * the second waits (per-customer advisory lock + the parts' row locks) and answers alreadyExisted with that id.
 *
 *   node scripts/dev/r2810-concurrency-check.mjs
 *
 * Why a script and not the .test.sql: two sessions only see each other's rows once committed, and a .test.sql is
 * one rolled-back transaction. So this loads a tiny COMMITTED fixture (its own tenant "R2810 Concurrency Co", fixed
 * ids c2810…), runs two psql sessions in parallel and removes every row of that tenant again (also first, so a
 * crashed run does not block the next). It does NOT apply the migration: each session creates
 * pg_temp.bill_parts_together from the migration file's own body (session-local, gone when it ends), so the local
 * DB never gets R-2810 applied by this check (worker-lock sql-related stays a real proof). Needs R-2806's
 * migration (subscriptions.bill_group_id, billing_pool_subscriptions) on the local DB.
 *
 * LOCAL docker DB only: it talks to the container supabase_db_resellerosv3 through `docker exec`, nothing else.
 * Exit 0 = one proforma, the second call waited and said alreadyExisted; 1 = not.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTAINER = "supabase_db_resellerosv3";
const MIGRATION = fs
  .readdirSync(path.join(PROD, "supabase", "migrations"))
  .filter((f) => /_r2810_bill_parts_together\.sql$/.test(f))
  .sort()
  .pop();
const T = "c2810000-0000-4000-8000-0000000000f1";
const PA = "c2810000-0000-4000-8000-000000000301";
const PB = "c2810000-0000-4000-8000-000000000302";

function psql(sql) {
  const r = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** The RPC body from the migration, as a session-local pg_temp function. */
function tempFunction() {
  if (!MIGRATION) throw new Error("no *_r2810_bill_parts_together.sql migration found");
  const src = fs.readFileSync(path.join(PROD, "supabase", "migrations", MIGRATION), "utf8");
  const fn = (name) => {
    const m = src.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\r?\\n\\$\\$;`));
    if (!m) throw new Error(`${name} not found in ${MIGRATION}`);
    return m[0].replace(/^\s*security definer\s*$/m, "");
  };
  /* the RPC and the "live request" helper it reads, both session-local */
  const body = [fn("part_live_request"), fn("bill_parts_together")]
    .join("\n")
    .replaceAll("public.part_live_request(", "pg_temp.part_live_request(")
    .replace("public.bill_parts_together(", "pg_temp.bill_parts_together(");
  return body;
}

const CLEAN = `
do $$
declare t record; n int; pass int;
begin
  if not exists (select 1 from public.tenants where id = '${T}') then return; end if;
  for pass in 1..6 loop
    for t in select c.table_name from information_schema.columns c join information_schema.tables tb
               on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
              where c.table_schema = 'public' and c.column_name = 'tenant_id' and c.table_name <> 'tenants' loop
      begin
        execute format('delete from public.%I where tenant_id = %L', t.table_name, '${T}');
      exception when others then null;   -- an FK child not deleted yet: next pass
      end;
    end loop;
    begin delete from public.tenants where id = '${T}'; exit; exception when others then null; end;
  end loop;
  if exists (select 1 from public.tenants where id = '${T}') then raise exception 'R2810 concurrency tenant could not be removed'; end if;
end $$;`;

const FIXTURE = `
begin;
insert into public.tenants (id, name, email, state_code, doc_code, address, gstin)
values ('${T}', 'R2810 Concurrency Co', 'r2810c@example.test', '07', 'R81C', 'Test street, Delhi', '07AAACT1643F1Z5');
update public.tenants set books_start_date = '2025-04-01' where id = '${T}';
insert into public.customers (id, tenant_id, name, state_code, country)
values ('c2810000-0000-4000-8000-000000000101', '${T}', 'R2810 Conc Customer', '07', 'India');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, renewal_state, reminder_count, status)
values ('c2810000-0000-4000-8000-000000000201', '${T}', 'c2810000-0000-4000-8000-000000000101', 'R2810 Conc Customer',
        'Conc Plan A', 'google', 2, 1000, 'monthly', 12, '2025-10-01', '2026-10-01', 'grace_period', 0, 'active'),
       ('c2810000-0000-4000-8000-000000000202', '${T}', 'c2810000-0000-4000-8000-000000000101', 'R2810 Conc Customer',
        'Conc Plan B', 'google', 3, 1000, 'monthly', 12, '2025-10-01', '2026-10-01', 'grace_period', 0, 'active');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                          period_end, taxable_amount, tax_rate)
values ('${PA}', '${T}', 'c2810000-0000-4000-8000-000000000201', '2026-09-01', 2, '2026-10-01', '2026-10-01', '2026-11-01', 2000, 18),
       ('${PB}', '${T}', 'c2810000-0000-4000-8000-000000000202', '2026-09-01', 2, '2026-10-01', '2026-10-01', '2026-11-01', 3000, 18);
commit;`;

/** One session: create the temp RPC, call it, hold the transaction \`holdSec\`, commit; prints the answer + seconds. */
function session(name, holdSec) {
  const sql = `
begin;
${tempFunction()}
select '${name}-start ' || extract(epoch from clock_timestamp());
select '${name}-result ' || pg_temp.bill_parts_together(array['${PA}'::uuid, '${PB}'::uuid])::text;
select '${name}-got ' || extract(epoch from clock_timestamp());
select pg_sleep(${holdSec});
select '${name}-end ' || extract(epoch from clock_timestamp());
commit;`;
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${name}: ${err || out}`))));
    p.stdin.end(sql);
  });
}

const pick = (out, key) => (out.split(/\r?\n/).find((l) => l.startsWith(key + " ")) ?? "").slice(key.length + 1);

async function main() {
  psql(CLEAN);
  psql(FIXTURE);
  let ok = false;
  try {
    const s1 = session("s1", 8);   // 8 s: a loaded laptop can take seconds just to start the second psql
    await new Promise((r) => setTimeout(r, 1500));
    const s2 = session("s2", 0);
    const [o1, o2] = await Promise.all([s1, s2]);
    const r1 = JSON.parse(pick(o1, "s1-result"));
    const r2 = JSON.parse(pick(o2, "s2-result"));
    const waited = Number(pick(o2, "s2-got")) - Number(pick(o2, "s2-start"));
    /* Overlap proof, not a fixed wait: s2 STARTED its call while s1 still held its transaction, and s2's answer came
       only after s1 reached commit (a loaded laptop can start the second psql seconds late). */
    const s1End = Number(pick(o1, "s1-end"));
    const overlapped = Number(pick(o2, "s2-start")) < s1End && Number(pick(o2, "s2-got")) >= s1End - 0.05;
    const count = Number(psql(`select count(*) from public.quotes where tenant_id = '${T}' and subscription_billing_id is not null;`));
    console.log(`s1: ${r1.action} ${r1.quote_id} alreadyExisted=${r1.already_existed}`);
    console.log(`s2: ${r2.action} ${r2.quote_id} alreadyExisted=${r2.already_existed} (waited ${waited.toFixed(1)} s for s1)`);
    console.log(`proformas for the two parts: ${count}`);
    ok = r1.action === "request" && r1.already_existed === false && r2.quote_id === r1.quote_id && r2.already_existed === true
      && count === 1 && overlapped;
  } finally {
    psql(CLEAN);
  }
  console.log(ok ? "PASS: two calls at once → one proforma; the second waited and answered alreadyExisted"
    : "FAIL: concurrent Bill together did not give exactly one proforma");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  try { psql(CLEAN); } catch { /* reported below */ }
  console.error(e.message);
  process.exit(1);
});
