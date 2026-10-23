\set ON_ERROR_STOP on
-- R-1104: run history of the scheduled jobs (/automation).
-- Migration 20261023181904_r1104_automation_job_runs. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1104_automation_job_runs.test.sql
--
-- Expect "PASS r1104_automation_job_runs". Every check is collected first, failures listed together.
--
--   WRITE    service role inserts runs; the check constraints refuse a bad status / trigger
--   READ     owner and manager read their own company's runs; sales reads none; owner of
--            company B reads none of A's
--   LOCKED   a signed-in owner cannot insert, update or delete a run (the history is the server's)
--   KEEP     only the newest 50 runs per (company, job) stay; another job's runs are untouched

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1104000-0000-4000-8000-0000000000a1', 'r1104-owner@example.test'),
  ('e1104000-0000-4000-8000-0000000000a2', 'r1104-manager@example.test'),
  ('e1104000-0000-4000-8000-0000000000a4', 'r1104-sales@example.test'),
  ('e1104000-0000-4000-8000-0000000000b1', 'r1104-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1104000-0000-0000-0000-0000000000a0', 'R1104 A', 'r1104a@example.in', '07', 'R14A'),
  ('e1104000-0000-0000-0000-0000000000b0', 'R1104 B', 'r1104b@example.in', '07', 'R14B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1104000-0000-4000-8000-0000000000a1', 'e1104000-0000-0000-0000-0000000000a0', 'r1104-owner@example.in',   'R1104 Owner',   'owner',   true),
  ('e1104000-0000-4000-8000-0000000000a2', 'e1104000-0000-0000-0000-0000000000a0', 'r1104-manager@example.in', 'R1104 Manager', 'manager', true),
  ('e1104000-0000-4000-8000-0000000000a4', 'e1104000-0000-0000-0000-0000000000a0', 'r1104-sales@example.in',   'R1104 Sales',   'sales',   true),
  ('e1104000-0000-4000-8000-0000000000b1', 'e1104000-0000-0000-0000-0000000000b0', 'r1104-owner-b@example.in', 'R1104 Owner B', 'owner',   true);

create temp table r1104_fail (msg text);
create temp table r1104_ctx (k text primary key, v text);
grant all on r1104_fail, r1104_ctx to authenticated, service_role;

create or replace function pg_temp.as_user(sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $$;

-- ═══ 1. WRITE as the service role ═══════════════════════════════════════════════════
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
set local role service_role;
insert into public.automation_job_runs (tenant_id, job, status, trigger, result, ran_at)
values ('e1104000-0000-0000-0000-0000000000a0', 'renewals', 'failed', 'schedule', 'Failed (500)', now() - interval '1 hour'),
       ('e1104000-0000-0000-0000-0000000000a0', 'renewals', 'ok', 'retry', 'Ran: sent 3', now()),
       ('e1104000-0000-0000-0000-0000000000b0', 'renewals', 'ok', 'schedule', 'Ran', now());
do $$
begin
  begin
    insert into public.automation_job_runs (tenant_id, job, status) values ('e1104000-0000-0000-0000-0000000000a0', 'renewals', 'great');
    insert into r1104_fail values ('WRITE: status "great" was accepted');
  exception when check_violation then null;
  end;
  begin
    insert into public.automation_job_runs (tenant_id, job, status, trigger) values ('e1104000-0000-0000-0000-0000000000a0', 'renewals', 'ok', 'browser');
    insert into r1104_fail values ('WRITE: trigger "browser" was accepted');
  exception when check_violation then null;
  end;
end $$;
reset role;

-- ═══ 2. READ per role ═════════════════════════════════════════════════════════════════
select pg_temp.as_user('e1104000-0000-4000-8000-0000000000a1');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_job_runs;
  if n <> 2 then insert into r1104_fail values ('READ: owner A sees ' || n || ' runs, expected 2 (own company only)'); end if;
end $$;
reset role;

select pg_temp.as_user('e1104000-0000-4000-8000-0000000000a2');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_job_runs;
  if n <> 2 then insert into r1104_fail values ('READ: manager A sees ' || n || ' runs, expected 2'); end if;
end $$;
reset role;

select pg_temp.as_user('e1104000-0000-4000-8000-0000000000a4');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_job_runs;
  if n <> 0 then insert into r1104_fail values ('READ: sales sees ' || n || ' runs, expected 0'); end if;
end $$;
reset role;

select pg_temp.as_user('e1104000-0000-4000-8000-0000000000b1');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_job_runs where tenant_id = 'e1104000-0000-0000-0000-0000000000a0';
  if n <> 0 then insert into r1104_fail values ('READ: owner B sees ' || n || ' of company A''s runs'); end if;
end $$;
reset role;

-- ═══ 3. LOCKED for signed-in users ════════════════════════════════════════════════════
select pg_temp.as_user('e1104000-0000-4000-8000-0000000000a1');
set local role authenticated;
do $$
declare n int;
begin
  begin
    insert into public.automation_job_runs (tenant_id, job, status) values ('e1104000-0000-0000-0000-0000000000a0', 'renewals', 'ok');
    insert into r1104_fail values ('LOCKED: owner could insert a run');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.automation_job_runs set status = 'ok' where status = 'failed';
    get diagnostics n = row_count;
    if n > 0 then insert into r1104_fail values ('LOCKED: owner changed ' || n || ' run(s)'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.automation_job_runs;
    get diagnostics n = row_count;
    if n > 0 then insert into r1104_fail values ('LOCKED: owner deleted ' || n || ' run(s)'); end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ═══ 4. KEEP the newest 50 per (company, job) ══════════════════════════════════════════
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
set local role service_role;
insert into public.automation_job_runs (tenant_id, job, status, result, ran_at)
select 'e1104000-0000-0000-0000-0000000000a0', 'gmail-inbox', 'ok', 'Ran #' || g, now() - (g || ' minutes')::interval
  from generate_series(1, 60) g;
do $$
declare n int; oldest text;
begin
  select count(*) into n from public.automation_job_runs
   where tenant_id = 'e1104000-0000-0000-0000-0000000000a0' and job = 'gmail-inbox';
  if n <> 50 then insert into r1104_fail values ('KEEP: ' || n || ' gmail-inbox runs kept, expected 50'); end if;
  select result into oldest from public.automation_job_runs
   where tenant_id = 'e1104000-0000-0000-0000-0000000000a0' and job = 'gmail-inbox'
   order by ran_at asc limit 1;
  if oldest <> 'Ran #50' then insert into r1104_fail values ('KEEP: oldest kept is "' || coalesce(oldest, 'null') || '", expected "Ran #50"'); end if;
  select count(*) into n from public.automation_job_runs
   where tenant_id = 'e1104000-0000-0000-0000-0000000000a0' and job = 'renewals';
  if n <> 2 then insert into r1104_fail values ('KEEP: renewals runs became ' || n || ', expected 2 (another job untouched)'); end if;
end $$;
reset role;

-- ═══ verdict ══════════════════════════════════════════════════════════════════════════
do $$
declare msgs text;
begin
  select string_agg(msg, E'\n') into msgs from r1104_fail;
  if msgs is not null then raise exception E'FAIL r1104_automation_job_runs:\n%', msgs; end if;
  raise notice 'PASS r1104_automation_job_runs';
end $$;

rollback;
