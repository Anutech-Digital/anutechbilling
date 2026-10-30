-- R-2157 (30 Oct 2026, G-ADS-AI AI-01): the marketing agent's LangGraph checkpoints.
-- Migration 20261030084415_r2157_agent_checkpoints.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Owner and marketing logins write and read checkpoints + writes for their own plan.
--   B. Tenant isolation: another company's checkpoints are invisible and cannot be changed;
--      a row under another company's tenant_id is refused; a row with OWN tenant_id but
--      another company's plan as thread_id is refused by the composite FK.
--   C. Roles: manager, sales and a deactivated owner see nothing and cannot write.
--   D. Deleting the plan deletes its checkpoints and writes.
--   E. service_role (the server / monitor cron) reads every company's rows (Cloud SQL, R-450).
--   F. anon has no access.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000215701','R2157 Co','r2157@example.in','07','R2157'),
  ('dddddddd-0000-0000-0000-000000215702','R2157 Other','r2157b@example.in','07','R2157B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000215701','owner2157@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215702','mkt2157@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215703','mgr2157@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215704','sales2157@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215705','owner2157b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000215706','exowner2157@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000215701','dddddddd-0000-0000-0000-000000215701','owner2157@example.in','Owner 2157','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215702','dddddddd-0000-0000-0000-000000215701','mkt2157@example.in','Mkt 2157','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215703','dddddddd-0000-0000-0000-000000215701','mgr2157@example.in','Mgr 2157','manager', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215704','dddddddd-0000-0000-0000-000000215701','sales2157@example.in','Sales 2157','sales', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215705','dddddddd-0000-0000-0000-000000215702','owner2157b@example.in','Owner 2157B','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000215706','dddddddd-0000-0000-0000-000000215701','exowner2157@example.in','Ex 2157','owner', false, now() - interval '1 day');

-- Both companies' plans + the other company's checkpoint, written by the server.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.ad_plans (id, tenant_id, name, objective, platforms, prompt) values
  ('eeeeeeee-0000-0000-0000-000000215701','dddddddd-0000-0000-0000-000000215701','Workspace Delhi','sales', array['google-ads','meta-ads'],'Launch a campaign for Google Workspace in Delhi'),
  ('eeeeeeee-0000-0000-0000-000000215702','dddddddd-0000-0000-0000-000000215702','Other plan','traffic', array['google-ads'],'Other company prompt');
insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
values ('dddddddd-0000-0000-0000-000000215702','eeeeeeee-0000-0000-0000-000000215702','other-1','json','\x7b7d','json','\x7b7d');
insert into public.agent_checkpoint_writes (tenant_id, thread_id, checkpoint_id, task_id, idx, channel, value_type, value)
values ('dddddddd-0000-0000-0000-000000215702','eeeeeeee-0000-0000-0000-000000215702','other-1','t1',0,'brief','json','\x7b7d');

-- ── A. MARKETING writes and reads its own plan's checkpoints ─────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215702","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
  values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215701','own-1','json','\x7b7d','json','\x7b7d');
  insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
  values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215701','own-2','own-1','json','\x7b7d','json','\x7b7d');
  insert into public.agent_checkpoint_writes (tenant_id, thread_id, checkpoint_id, task_id, idx, channel, value_type, value)
  values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215701','own-2','t1',0,'brief','json','\x7b7d'),
         ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215701','own-2','t1',-3,'__interrupt__','json','\x7b7d');
  if (select count(*) from public.agent_checkpoints) <> 2 then
    raise exception 'FAIL A1: marketing sees % checkpoints (want own 2)', (select count(*) from public.agent_checkpoints); end if;
  if (select count(*) from public.agent_checkpoint_writes) <> 2 then
    raise exception 'FAIL A2: marketing sees % writes (want own 2)', (select count(*) from public.agent_checkpoint_writes); end if;
  if (select created_by from public.agent_checkpoints where checkpoint_id = 'own-1') is distinct from 'aaaaaaaa-0000-0000-0000-000000215702' then
    raise exception 'FAIL A3: created_by not filled from the login'; end if;
  raise notice 'PASS A: marketing writes + reads own checkpoints only';
end $$;

-- ── B. Tenant isolation (still marketing) ───────────────────────────────────
do $$
declare n int;
begin
  begin
    insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
    values ('dddddddd-0000-0000-0000-000000215702','eeeeeeee-0000-0000-0000-000000215702','sneak','json','\x7b7d','json','\x7b7d');
    raise exception 'FAIL B1: wrote a checkpoint for another company';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
    values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215702','hijack','json','\x7b7d','json','\x7b7d');
    raise exception 'FAIL B2: own-tenant checkpoint attached to another company''s plan';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.agent_checkpoint_writes (tenant_id, thread_id, checkpoint_id, task_id, idx, channel, value_type, value)
    values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215702','other-1','t9',0,'brief','json','\x7b7d');
    raise exception 'FAIL B3: own-tenant write attached to another company''s plan';
  exception when foreign_key_violation then null;
  end;
  update public.agent_checkpoints set metadata = '\x00' where thread_id = 'eeeeeeee-0000-0000-0000-000000215702';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B4: updated another company''s checkpoint'; end if;
  delete from public.agent_checkpoint_writes where thread_id = 'eeeeeeee-0000-0000-0000-000000215702';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B5: deleted another company''s write'; end if;
  raise notice 'PASS B: another company''s checkpoints are invisible and cannot be written';
end $$;

-- ── A2. OWNER reads the same thread ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000215701","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.agent_checkpoints where thread_id = 'eeeeeeee-0000-0000-0000-000000215701') <> 2 then
    raise exception 'FAIL A4: owner does not see the marketing user''s checkpoints'; end if;
  raise notice 'PASS A2: owner sees the company''s thread';
end $$;

-- ── C. Manager, sales, deactivated owner: nothing ───────────────────────────
create function pg_temp.r2157_locked_out(p_user text, p_label text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  if (select count(*) from public.agent_checkpoints) <> 0 or (select count(*) from public.agent_checkpoint_writes) <> 0 then
    raise exception 'FAIL C: % sees checkpoints', p_label; end if;
  begin
    insert into public.agent_checkpoints (tenant_id, thread_id, checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata)
    values ('dddddddd-0000-0000-0000-000000215701','eeeeeeee-0000-0000-0000-000000215701','by-' || p_label,'json','\x7b7d','json','\x7b7d');
    raise exception 'FAIL C: % wrote a checkpoint', p_label;
  exception when insufficient_privilege then null;
  end;
end $f$;
select pg_temp.r2157_locked_out('aaaaaaaa-0000-0000-0000-000000215703', 'manager');
select pg_temp.r2157_locked_out('aaaaaaaa-0000-0000-0000-000000215704', 'sales');
select pg_temp.r2157_locked_out('aaaaaaaa-0000-0000-0000-000000215706', 'deactivated owner');
do $$ begin raise notice 'PASS C: manager, sales and a deactivated owner see and write nothing'; end $$;

-- ── F. anon: no schema access ───────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin
    perform 1 from public.agent_checkpoints;
    raise exception 'FAIL F: anon read the checkpoints';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS F: anon has no access';
end $$;

-- ── E. service_role sees every company ──────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  if (select count(distinct tenant_id) from public.agent_checkpoints
       where tenant_id in ('dddddddd-0000-0000-0000-000000215701','dddddddd-0000-0000-0000-000000215702')) <> 2 then
    raise exception 'FAIL E: service_role does not see both companies'; end if;
  raise notice 'PASS E: service_role reads every company';
end $$;

-- ── D. Deleting the plan deletes its checkpoints ────────────────────────────
reset role;
do $$
begin
  delete from public.ad_plans where id = 'eeeeeeee-0000-0000-0000-000000215701';
  if exists (select 1 from public.agent_checkpoints where thread_id = 'eeeeeeee-0000-0000-0000-000000215701')
     or exists (select 1 from public.agent_checkpoint_writes where thread_id = 'eeeeeeee-0000-0000-0000-000000215701') then
    raise exception 'FAIL D: checkpoints survived their plan'; end if;
  raise notice 'PASS D: deleting the plan deletes its checkpoints';
  raise notice 'r2157_agent_checkpoints: all checks passed';
end $$;

rollback;
