\set ON_ERROR_STOP on
-- R-897 (P1 LAUNCH BLOCKER): the in-app automation gate.
-- Migration 20261012023000_r897_automation_gate. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r897_automation_gate.test.sql
--
-- Expect "PASS r897_automation_gate". Every check is collected first, failures listed together.
--
--   NEW      (R-1922) a new company starts with only customer_messages ON; crons have no row = OFF
--   DEFAULT  no row → automation_allowed false, automation_state 'off'
--   OWNER    owner can enable (set_automation_job) → allowed true; dry run → state 'dry_run',
--            allowed false; the change lands in activity_log with only enabled/dry_run
--   REFUSED  sales and manager: set_automation_job → 42501; direct UPDATE changes 0 rows;
--            direct INSERT → RLS error. Manager can READ, sales cannot.
--   KILL     tenants.ai_kill_switch = true → off, and the cron list leaves the company out
--   TENANT   owner of company B sees none of A's rows, cannot ask about A, cannot change A
--   CRON     automation_cron_tenants / automation_record_run: service role only; record_run
--            creates a missing row with enabled = false and does NOT write activity_log

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e8970000-0000-4000-8000-0000000000a1', 'r897-owner@example.test'),
  ('e8970000-0000-4000-8000-0000000000a2', 'r897-manager@example.test'),
  ('e8970000-0000-4000-8000-0000000000a4', 'r897-sales@example.test'),
  ('e8970000-0000-4000-8000-0000000000b1', 'r897-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e8970000-0000-0000-0000-0000000000a0', 'R897 A', 'r897a@example.in', '07', 'R97A'),
  ('e8970000-0000-0000-0000-0000000000b0', 'R897 B', 'r897b@example.in', '07', 'R97B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e8970000-0000-4000-8000-0000000000a1', 'e8970000-0000-0000-0000-0000000000a0', 'r897-owner@example.in',   'R897 Owner',   'owner',   true),
  ('e8970000-0000-4000-8000-0000000000a2', 'e8970000-0000-0000-0000-0000000000a0', 'r897-manager@example.in', 'R897 Manager', 'manager', true),
  ('e8970000-0000-4000-8000-0000000000a4', 'e8970000-0000-0000-0000-0000000000a0', 'r897-sales@example.in',   'R897 Sales',   'sales',   true),
  ('e8970000-0000-4000-8000-0000000000b1', 'e8970000-0000-0000-0000-0000000000b0', 'r897-owner-b@example.in', 'R897 Owner B', 'owner',   true);

create temp table r897_fail (msg text);
create temp table r897_ctx (k text primary key, v text);
grant all on r897_fail, r897_ctx to authenticated, service_role;

-- ═══ 0. NEW COMPANY (R-1922, Pardeep's decision 25 Oct) ══════════════════════════
-- A new company is born with ONLY its customer_messages switch ON; every cron has no row = OFF.
-- Then both companies are put back to an "existing company" state (no switch rows at all — the
-- state of every company made before R-1922), so every R-897 check below still proves that a
-- missing row means OFF, unchanged.
do $$
declare n int;
begin
  select count(*) into n from public.automation_jobs
   where tenant_id in ('e8970000-0000-0000-0000-0000000000a0', 'e8970000-0000-0000-0000-0000000000b0')
     and job = 'customer_messages' and enabled and not dry_run;
  if n <> 2 then insert into r897_fail values ('NEW: a new company should start with customer_messages ON, found ' || n || ' of 2'); end if;
  select count(*) into n from public.automation_jobs
   where tenant_id in ('e8970000-0000-0000-0000-0000000000a0', 'e8970000-0000-0000-0000-0000000000b0')
     and job <> 'customer_messages';
  if n <> 0 then insert into r897_fail values ('NEW: a new company got ' || n || ' cron row(s) — crons must start OFF'); end if;
  if public.automation_allowed('invoice-dunning', 'e8970000-0000-0000-0000-0000000000a0')
     or public.automation_allowed('renewals', 'e8970000-0000-0000-0000-0000000000a0') then
    insert into r897_fail values ('NEW: a cron is allowed for a brand-new company');
  end if;
end $$;
delete from public.automation_jobs
 where tenant_id in ('e8970000-0000-0000-0000-0000000000a0', 'e8970000-0000-0000-0000-0000000000b0');

create or replace function pg_temp.as_user(sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
end $$;

-- ═══ 1. DEFAULT: no row → off (as owner A) ═══════════════════════════════════════
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000a1');
set local role authenticated;
do $$
begin
  if public.automation_allowed('invoice-dunning') then
    insert into r897_fail values ('DEFAULT: no row but automation_allowed = true');
  end if;
  if public.automation_state('invoice-dunning') <> 'off' then
    insert into r897_fail values ('DEFAULT: no row but state ' || public.automation_state('invoice-dunning'));
  end if;
  if public.automation_allowed('customer_messages') then
    insert into r897_fail values ('DEFAULT: customer_messages on with no row');
  end if;
end $$;

-- ═══ 2. REFUSED: sales ═══════════════════════════════════════════════════════════
reset role;
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000a4');
set local role authenticated;
do $$
declare n int;
begin
  begin
    perform public.set_automation_job('invoice-dunning', true, false);
    insert into r897_fail values ('SALES: set_automation_job was allowed');
  exception when sqlstate '42501' then
    if sqlerrm not like 'Only the owner%' then insert into r897_fail values ('SALES: wrong message ' || sqlerrm); end if;
  end;
  begin
    insert into public.automation_jobs (tenant_id, job, enabled) values ('e8970000-0000-0000-0000-0000000000a0', 'renewals', true);
    insert into r897_fail values ('SALES: direct insert was allowed');
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.automation_jobs;
  if n <> 0 then insert into r897_fail values ('SALES: can read automation_jobs'); end if;
end $$;

-- ═══ 3. OWNER enables ════════════════════════════════════════════════════════════
reset role;
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000a1');
set local role authenticated;
do $$
declare r public.automation_jobs;
begin
  r := public.set_automation_job('invoice-dunning', true, false);
  if not r.enabled or r.changed_by is distinct from 'e8970000-0000-4000-8000-0000000000a1'::uuid or r.changed_at is null then
    insert into r897_fail values ('OWNER: row not stamped / not enabled');
  end if;
  if not public.automation_allowed('invoice-dunning') then
    insert into r897_fail values ('OWNER: enabled but automation_allowed false');
  end if;
  perform public.set_automation_job('renewals', true, true);
  if public.automation_state('renewals') <> 'dry_run' then
    insert into r897_fail values ('OWNER: dry run state is ' || public.automation_state('renewals'));
  end if;
  if public.automation_allowed('renewals') then
    insert into r897_fail values ('OWNER: dry run counted as allowed');
  end if;
  if public.automation_allowed('trial-expiry') then
    insert into r897_fail values ('OWNER: unrelated job on');
  end if;
  perform public.set_automation_job('billing', true, false);
  perform public.set_automation_job('billing', false, false);
  if public.automation_state('billing') <> 'off' or public.automation_allowed('billing') then
    insert into r897_fail values ('OWNER: a row turned OFF still reads as on');
  end if;
end $$;

-- ═══ 4. REFUSED: manager — reads, cannot change ════════════════════════════════
reset role;
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000a2');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_jobs;
  if n <> 3 then insert into r897_fail values ('MANAGER: expected to read 3 rows, read ' || n); end if;
  begin
    perform public.set_automation_job('invoice-dunning', false, false);
    insert into r897_fail values ('MANAGER: set_automation_job was allowed');
  exception when sqlstate '42501' then null;
  end;
  update public.automation_jobs set enabled = false where job = 'invoice-dunning';
  get diagnostics n = row_count;
  if n <> 0 then insert into r897_fail values ('MANAGER: direct update changed ' || n || ' row(s)'); end if;
  begin
    insert into public.automation_jobs (tenant_id, job, enabled) values ('e8970000-0000-0000-0000-0000000000a0', 'billing', true);
    insert into r897_fail values ('MANAGER: direct insert was allowed');
  exception when insufficient_privilege then null;
  end;
end $$;

-- ═══ 5. TENANT: owner of B ═══════════════════════════════════════════════════════
reset role;
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000b1');
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.automation_jobs;
  if n <> 0 then insert into r897_fail values ('TENANT: owner B reads ' || n || ' of A''s rows'); end if;
  if public.automation_allowed('invoice-dunning', 'e8970000-0000-0000-0000-0000000000a0') then
    insert into r897_fail values ('TENANT: owner B can read A''s gate through the tenant parameter');
  end if;
  if public.automation_allowed('invoice-dunning') then
    insert into r897_fail values ('TENANT: A''s switch leaks into B');
  end if;
  update public.automation_jobs set enabled = false;
  get diagnostics n = row_count;
  if n <> 0 then insert into r897_fail values ('TENANT: owner B changed A''s rows'); end if;
  begin
    insert into public.automation_jobs (tenant_id, job, enabled) values ('e8970000-0000-0000-0000-0000000000a0', 'billing', true);
    insert into r897_fail values ('TENANT: owner B inserted into A');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.automation_cron_tenants('invoice-dunning');
    insert into r897_fail values ('CRON: a signed-in user listed cron tenants');
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.automation_record_run('invoice-dunning', array['e8970000-0000-0000-0000-0000000000a0'::uuid], 'x');
    insert into r897_fail values ('CRON: a signed-in user recorded a run');
  exception when sqlstate '42501' then null;
  end;
end $$;

-- ═══ 6. CRON (service role) ══════════════════════════════════════════════════════
reset role;
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare n int; v_log_before int; v_log_after int;
begin
  select count(*) into n from public.automation_cron_tenants('invoice-dunning') c where c.tenant_id = 'e8970000-0000-0000-0000-0000000000a0';
  if n <> 1 then insert into r897_fail values ('CRON: enabled company not listed'); end if;
  select count(*) into n from public.automation_cron_tenants('renewals') c where c.tenant_id = 'e8970000-0000-0000-0000-0000000000a0' and c.dry_run;
  if n <> 1 then insert into r897_fail values ('CRON: dry-run company not listed as dry run'); end if;
  if not public.automation_allowed('invoice-dunning', 'e8970000-0000-0000-0000-0000000000a0') then
    insert into r897_fail values ('CRON: service role cannot ask about a company');
  end if;
  if public.automation_allowed('invoice-dunning', 'e8970000-0000-0000-0000-0000000000b0') then
    insert into r897_fail values ('CRON: company B on without a row');
  end if;

  select count(*) into v_log_before from public.activity_log where entity = 'automation_job' and tenant_id = 'e8970000-0000-0000-0000-0000000000b0';
  perform public.automation_record_run('trial-expiry', array['e8970000-0000-0000-0000-0000000000b0'::uuid], 'Skipped — turned off');
  select count(*) into v_log_after from public.activity_log where entity = 'automation_job' and tenant_id = 'e8970000-0000-0000-0000-0000000000b0';
  select count(*) into n from public.automation_jobs
   where tenant_id = 'e8970000-0000-0000-0000-0000000000b0' and job = 'trial-expiry'
     and not enabled and last_run_at is not null and last_result = 'Skipped — turned off';
  if n <> 1 then insert into r897_fail values ('CRON: record_run did not create an OFF row with the result'); end if;
  if v_log_after <> v_log_before then insert into r897_fail values ('CRON: recording a run wrote activity_log'); end if;
  perform public.automation_record_run('invoice-dunning', array['e8970000-0000-0000-0000-0000000000a0'::uuid], 'ran');
  select count(*) into n from public.automation_jobs where job = 'invoice-dunning' and enabled
     and changed_by = 'e8970000-0000-4000-8000-0000000000a1' and last_result = 'ran';
  if n <> 1 then insert into r897_fail values ('CRON: record_run changed the switch or its stamp'); end if;
end $$;

-- ═══ 7. KILL SWITCH ══════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);
update public.tenants set ai_kill_switch = true where id = 'e8970000-0000-0000-0000-0000000000a0';
select pg_temp.as_user('e8970000-0000-4000-8000-0000000000a1');
set local role authenticated;
do $$
begin
  if public.automation_allowed('invoice-dunning') then
    insert into r897_fail values ('KILL: kill switch on but job still allowed');
  end if;
end $$;
reset role;
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.automation_cron_tenants('invoice-dunning') c where c.tenant_id = 'e8970000-0000-0000-0000-0000000000a0';
  if n <> 0 then insert into r897_fail values ('KILL: cron still lists a killed company'); end if;
end $$;

-- ═══ 8. activity_log ═════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare n int; bad int;
begin
  select count(*) into n from public.activity_log
   where tenant_id = 'e8970000-0000-0000-0000-0000000000a0' and entity = 'automation_job'
     and user_id = 'e8970000-0000-4000-8000-0000000000a1';
  if n <> 4 then insert into r897_fail values ('LOG: expected 4 owner changes in activity_log, found ' || n); end if;
  select count(*) into bad from public.activity_log
   where tenant_id = 'e8970000-0000-0000-0000-0000000000a0' and entity = 'automation_job'
     and exists (select 1 from jsonb_object_keys(changes) k where k not in ('enabled', 'dry_run'));
  if bad <> 0 then insert into r897_fail values ('LOG: activity_log carries fields other than enabled/dry_run'); end if;
end $$;

do $$
declare f text;
begin
  select string_agg(msg, E'\n  ') into f from r897_fail;
  if f is not null then raise exception E'FAIL r897_automation_gate:\n  %', f; end if;
  raise notice 'PASS r897_automation_gate';
end $$;

rollback;
