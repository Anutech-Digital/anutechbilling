-- R-2350 — record_access_log / log_record_view / security_log: who opened which customer / lead.
-- Migration: 20261101231527_r2350_record_access_log.sql
--
--   1. Shape: RLS on, authenticated/anon cannot INSERT/UPDATE/DELETE, no UPDATE/DELETE grant for
--      service_role either (append only), log_record_view is a SECURITY DEFINER with search_path
--      and no anon execute, security_log is security_invoker.
--   2. A manager opens a customer → one row (tenant = their company, user = them, view).
--      Opening it again within 10 minutes → no second row. After 10 minutes → a new row.
--      A lead open → one row. An unknown id / another company's record → false, no row.
--   3. Read: the owner sees the rows (table and security_log, with the record name, plus the
--      export_log rows); the manager, a sales user, another company's owner see 0.
--   4. Write: a direct INSERT is refused 42501; UPDATE / DELETE are refused 42501;
--      a deactivated user and anon cannot log.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

-- ── 1. Shape ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.record_access_log'::regclass) then
    raise exception 'FAIL 1: RLS is off on record_access_log';
  end if;
  if has_table_privilege('authenticated', 'public.record_access_log', 'INSERT')
     or has_table_privilege('authenticated', 'public.record_access_log', 'UPDATE')
     or has_table_privilege('authenticated', 'public.record_access_log', 'DELETE')
     or has_table_privilege('anon', 'public.record_access_log', 'SELECT')
     or has_table_privilege('anon', 'public.record_access_log', 'INSERT') then
    raise exception 'FAIL 1: record_access_log is writable (or anon-readable) without log_record_view()';
  end if;
  if has_table_privilege('service_role', 'public.record_access_log', 'UPDATE')
     or has_table_privilege('service_role', 'public.record_access_log', 'DELETE') then
    raise exception 'FAIL 1: service_role can update / delete the access log (must be append only)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_access_log'
                and cmd <> 'SELECT' and roles <> '{service_role}'::name[]) then
    raise exception 'FAIL 1: record_access_log has a write policy for app users';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.log_record_view(text,text)'::regprocedure
                    and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search\_path=%')) then
    raise exception 'FAIL 1: log_record_view is not a SECURITY DEFINER with search_path';
  end if;
  if has_function_privilege('anon', 'public.log_record_view(text,text)', 'EXECUTE') then
    raise exception 'FAIL 1: anon can execute log_record_view';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.security_log'::regclass
                    and ('security_invoker=on' = any(reloptions) or 'security_invoker=true' = any(reloptions))) then
    raise exception 'FAIL 1: security_log is not security_invoker';
  end if;
  if has_table_privilege('anon', 'public.security_log', 'SELECT') then
    raise exception 'FAIL 1: anon can read security_log';
  end if;
end $$;

-- ── fixture ─────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2350000-0000-0000-0000-0000000000a1', 'r2350-owner@example.test'),
  ('c2350000-0000-0000-0000-0000000000a2', 'r2350-manager@example.test'),
  ('c2350000-0000-0000-0000-0000000000a3', 'r2350-sales@example.test'),
  ('c2350000-0000-0000-0000-0000000000a4', 'r2350-gone@example.test'),
  ('c2350000-0000-0000-0000-0000000000b1', 'r2350-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2350000-0000-0000-0000-0000000000f1', 'R2350 Co',    'r2350c@example.test', '07', 'R235C'),
  ('c2350000-0000-0000-0000-0000000000f2', 'R2350 Other', 'r2350o@example.test', '07', 'R235O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2350000-0000-0000-0000-0000000000a1', 'c2350000-0000-0000-0000-0000000000f1', 'r2350-owner@example.test',   'R2350 Owner',   'owner',   true),
  ('c2350000-0000-0000-0000-0000000000a2', 'c2350000-0000-0000-0000-0000000000f1', 'r2350-manager@example.test', 'R2350 Manager', 'manager', true),
  ('c2350000-0000-0000-0000-0000000000a3', 'c2350000-0000-0000-0000-0000000000f1', 'r2350-sales@example.test',   'R2350 Sales',   'sales',   true),
  ('c2350000-0000-0000-0000-0000000000a4', 'c2350000-0000-0000-0000-0000000000f1', 'r2350-gone@example.test',    'R2350 Gone',    'manager', false),
  ('c2350000-0000-0000-0000-0000000000b1', 'c2350000-0000-0000-0000-0000000000f2', 'r2350-other@example.test',   'R2350 Other',   'owner',   true);

insert into public.customers (id, tenant_id, name) values
  ('c2350000-0000-0000-0000-0000000000c1', 'c2350000-0000-0000-0000-0000000000f1', 'R2350 Customer'),
  ('c2350000-0000-0000-0000-0000000000c2', 'c2350000-0000-0000-0000-0000000000f2', 'R2350 Other Customer');

insert into public.leads (id, tenant_id, company, contact_name, source, stage) values
  ('L-R2350-1', 'c2350000-0000-0000-0000-0000000000f1', 'R2350 Lead Co', 'Someone', 'website', 'new');

create function pg_temp.r2350_as(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;
grant execute on function pg_temp.r2350_as(uuid) to authenticated, anon;

create function pg_temp.r2350_count() returns int language sql security definer as $$
  select count(*)::int from public.record_access_log
   where tenant_id in ('c2350000-0000-0000-0000-0000000000f1', 'c2350000-0000-0000-0000-0000000000f2');
$$;
grant execute on function pg_temp.r2350_count() to authenticated, anon;

set local role authenticated;

do $$
declare
  v_ok  boolean;
  v_row record;
begin
  -- ── 2. manager opens a customer → one row; again within 10 min → none ───────────────────
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a2');
  v_ok := public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1');
  if v_ok is not true or pg_temp.r2350_count() <> 1 then
    raise exception 'FAIL 2: opening a customer did not write one row (returned %, rows %)', v_ok, pg_temp.r2350_count();
  end if;
  v_ok := public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1');
  if v_ok is not false or pg_temp.r2350_count() <> 1 then
    raise exception 'FAIL 2: a repeat open within 10 minutes wrote another row (rows %)', pg_temp.r2350_count();
  end if;

  -- the lead drawer
  v_ok := public.log_record_view('lead', 'L-R2350-1');
  if v_ok is not true or pg_temp.r2350_count() <> 2 then
    raise exception 'FAIL 2: opening a lead did not write one row';
  end if;

  -- a made-up id, another company's customer, a bad uuid: nothing written
  if public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c2') is not false
     or public.log_record_view('customer', 'not-a-uuid') is not false
     or public.log_record_view('lead', 'L-NOPE') is not false
     or pg_temp.r2350_count() <> 2 then
    raise exception 'FAIL 2: a record outside the caller''s company was logged';
  end if;
  begin
    perform public.log_record_view('invoice', 'x');
    raise exception 'FAIL 2: unknown record type accepted';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- ── 2b. after 10 minutes it is a new look → a new row ─────────────────────────────────────
reset role;
update public.record_access_log set at = now() - interval '11 minutes'
 where tenant_id = 'c2350000-0000-0000-0000-0000000000f1' and record_type = 'customer';
set local role authenticated;
do $$
begin
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a2');
  if public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1') is not true
     or pg_temp.r2350_count() <> 3 then
    raise exception 'FAIL 2b: an open after the 10-minute window did not write a new row';
  end if;
  -- a different user opening the same customer is their own row
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a3');
  if public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1') is not true
     or pg_temp.r2350_count() <> 4 then
    raise exception 'FAIL 2b: a second user''s open was swallowed by the first user''s debounce';
  end if;
  -- an export (R-1006) lands in the same owner list
  perform public.log_export('customers', 7, 'csv');
end $$;

-- ── 3. read: owner yes, everyone else no ───────────────────────────────────────────────────
do $$
declare
  v_who record;
  v_n   int;
  v_row record;
begin
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a1');
  select count(*) into v_n from public.record_access_log;
  if v_n <> 4 then raise exception 'FAIL 3: owner reads % access rows (expected 4)', v_n; end if;
  select * into v_row from public.record_access_log
   where record_type = 'lead';
  if v_row.user_id <> 'c2350000-0000-0000-0000-0000000000a2' or v_row.tenant_id <> 'c2350000-0000-0000-0000-0000000000f1'
     or v_row.action <> 'view' or v_row.record_id <> 'L-R2350-1' then
    raise exception 'FAIL 3: wrong row %', row_to_json(v_row);
  end if;

  select count(*) into v_n from public.security_log;
  if v_n <> 5 then raise exception 'FAIL 3: owner sees % security_log rows (expected 4 opens + 1 export)', v_n; end if;
  if not exists (select 1 from public.security_log where record_type = 'customer' and record_label = 'R2350 Customer')
     or not exists (select 1 from public.security_log where record_type = 'lead' and record_label = 'R2350 Lead Co')
     or not exists (select 1 from public.security_log where record_type = 'export' and action = 'export'
                       and record_label = 'customers' and row_count = 7 and format = 'csv') then
    raise exception 'FAIL 3: security_log is missing a name or the export row';
  end if;

  for v_who in
    select * from (values
      ('c2350000-0000-0000-0000-0000000000a2'::uuid, 'manager'),
      ('c2350000-0000-0000-0000-0000000000a3'::uuid, 'sales user'),
      ('c2350000-0000-0000-0000-0000000000a4'::uuid, 'deactivated manager'),
      ('c2350000-0000-0000-0000-0000000000b1'::uuid, 'other company owner')) as w(uid, label)
  loop
    perform pg_temp.r2350_as(v_who.uid);
    select count(*) into v_n from public.record_access_log;
    if v_n <> 0 then raise exception 'FAIL 3: % reads record_access_log (% rows)', v_who.label, v_n; end if;
    select count(*) into v_n from public.security_log;
    if v_n <> 0 then raise exception 'FAIL 3: % reads security_log (% rows)', v_who.label, v_n; end if;
  end loop;
end $$;

-- ── 4. write: no direct insert, no update, no delete ──────────────────────────────────────
do $$
declare
  v_st text;
  v_n  int;
begin
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a1');
  begin
    insert into public.record_access_log (tenant_id, user_id, record_type, record_id)
      values ('c2350000-0000-0000-0000-0000000000f1', 'c2350000-0000-0000-0000-0000000000a3', 'customer', 'forged');
    raise exception 'FAIL 4: owner inserted directly (bypassing log_record_view)';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
  begin
    update public.record_access_log set user_id = null;
    raise exception 'FAIL 4: owner updated access-log rows';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
  begin
    delete from public.record_access_log;
    raise exception 'FAIL 4: owner deleted access-log rows';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;

  -- a deactivated user has no company session → refused, nothing written
  perform pg_temp.r2350_as('c2350000-0000-0000-0000-0000000000a4');
  begin
    perform public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL 4: a deactivated user logged a view';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
  if pg_temp.r2350_count() <> 4 then raise exception 'FAIL 4: refused calls wrote rows (% total)', pg_temp.r2350_count(); end if;
end $$;

-- service_role: may insert (server code), never update / delete
reset role;
set local role service_role;
do $$
declare v_st text;
begin
  begin
    delete from public.record_access_log where tenant_id = 'c2350000-0000-0000-0000-0000000000f1';
    raise exception 'FAIL 4: service_role deleted access-log rows';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
end $$;

-- anon: no execute at all
reset role;
set local role anon;
do $$
declare v_st text;
begin
  perform pg_temp.r2350_as(null);
  begin
    perform public.log_record_view('customer', 'c2350000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL 4: anon logged a view';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
end $$;

reset role;
do $$ begin raise notice 'R-2350 record_access_log: all checks passed'; end $$;

rollback;
