-- R-1006 — export_log: only the company owner reads it; nobody writes it for another company.
-- Migration: 20261019013050_r1006_export_log.sql
--
--   1. Shape: RLS on, no INSERT/UPDATE/DELETE grant to authenticated/anon, log_export is a
--      SECURITY DEFINER with search_path and no PUBLIC/anon execute.
--   2. A sales user logs an export → one row, tenant = their company, user_id = them.
--   3. Read: the owner sees it; the sales user, an accountant, another company's owner, a
--      deactivated owner and an MFA owner on aal1 see 0 rows.
--   4. Write: a direct INSERT (own company or another) is refused 42501; UPDATE/DELETE touch
--      0 rows / are refused; log_export has no tenant argument, so the row always lands in the
--      caller's company; anon / deactivated / aal1 callers are refused 42501 and write nothing.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1006_export_log.test.sql

begin;

-- ── 1. Shape ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.export_log'::regclass) then
    raise exception 'FAIL 1: RLS is off on export_log';
  end if;
  if has_table_privilege('authenticated', 'public.export_log', 'INSERT')
     or has_table_privilege('authenticated', 'public.export_log', 'UPDATE')
     or has_table_privilege('authenticated', 'public.export_log', 'DELETE')
     or has_table_privilege('anon', 'public.export_log', 'SELECT')
     or has_table_privilege('anon', 'public.export_log', 'INSERT') then
    raise exception 'FAIL 1: export_log is writable (or anon-readable) without log_export()';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'export_log'
                and cmd <> 'SELECT' and roles <> '{service_role}'::name[]) then
    raise exception 'FAIL 1: export_log has a write policy for app users';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.log_export(text,integer,text)'::regprocedure
                    and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search\_path=%')) then
    raise exception 'FAIL 1: log_export is not a SECURITY DEFINER with search_path';
  end if;
  if has_function_privilege('anon', 'public.log_export(text,integer,text)', 'EXECUTE') then
    raise exception 'FAIL 1: anon can execute log_export';
  end if;
end $$;

-- ── fixture ─────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c1006000-0000-0000-0000-0000000000a1', 'r1006-owner@example.test'),
  ('c1006000-0000-0000-0000-0000000000a2', 'r1006-sales@example.test'),
  ('c1006000-0000-0000-0000-0000000000a3', 'r1006-acct@example.test'),
  ('c1006000-0000-0000-0000-0000000000a4', 'r1006-gone@example.test'),
  ('c1006000-0000-0000-0000-0000000000a5', 'r1006-mfa@example.test'),
  ('c1006000-0000-0000-0000-0000000000b1', 'r1006-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1006000-0000-0000-0000-0000000000f1', 'R1006 Co',    'r1006c@example.test', '07', 'R106C'),
  ('c1006000-0000-0000-0000-0000000000f2', 'R1006 Other', 'r1006o@example.test', '07', 'R106O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1006000-0000-0000-0000-0000000000a1', 'c1006000-0000-0000-0000-0000000000f1', 'r1006-owner@example.test', 'R1006 Owner', 'owner',      true),
  ('c1006000-0000-0000-0000-0000000000a2', 'c1006000-0000-0000-0000-0000000000f1', 'r1006-sales@example.test', 'R1006 Sales', 'sales',      true),
  ('c1006000-0000-0000-0000-0000000000a3', 'c1006000-0000-0000-0000-0000000000f1', 'r1006-acct@example.test',  'R1006 Acct',  'accountant', true),
  ('c1006000-0000-0000-0000-0000000000a4', 'c1006000-0000-0000-0000-0000000000f1', 'r1006-gone@example.test',  'R1006 Gone',  'owner',      false),
  ('c1006000-0000-0000-0000-0000000000a5', 'c1006000-0000-0000-0000-0000000000f1', 'r1006-mfa@example.test',   'R1006 Mfa',   'owner',      true),
  ('c1006000-0000-0000-0000-0000000000b1', 'c1006000-0000-0000-0000-0000000000f2', 'r1006-other@example.test', 'R1006 Other', 'owner',      true);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c1006000-0000-0000-0000-0000000000d1', 'c1006000-0000-0000-0000-0000000000a5', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

create function pg_temp.r1006_as(p_uid uuid, p_aal text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;
grant execute on function pg_temp.r1006_as(uuid, text) to authenticated, anon;

create function pg_temp.r1006_count() returns int language sql security definer as $$
  select count(*)::int from public.export_log
   where tenant_id in ('c1006000-0000-0000-0000-0000000000f1', 'c1006000-0000-0000-0000-0000000000f2');
$$;
grant execute on function pg_temp.r1006_count() to authenticated, anon;

set local role authenticated;

do $$
declare
  v_who record;
  v_n   int;
  v_st  text;
  v_row record;
begin
  -- ── 2. sales user logs an export ───────────────────────────────────────────────────────
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a2', 'aal1');
  perform public.log_export('customers', 42, 'CSV');
  if pg_temp.r1006_count() <> 1 then raise exception 'FAIL 2: log_export did not write one row'; end if;

  -- ── 3. read: owner yes, everyone else no ───────────────────────────────────────────────
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a1', 'aal1');
  select * into v_row from public.export_log where tenant_id = 'c1006000-0000-0000-0000-0000000000f1';
  if v_row is null then raise exception 'FAIL 3: owner cannot read export_log'; end if;
  if v_row.user_id <> 'c1006000-0000-0000-0000-0000000000a2' or v_row.what <> 'customers'
     or v_row.row_count <> 42 or v_row.format <> 'csv' then
    raise exception 'FAIL 2: wrong row %', row_to_json(v_row);
  end if;

  for v_who in
    select * from (values
      ('c1006000-0000-0000-0000-0000000000a2'::uuid, 'aal1', 'sales user'),
      ('c1006000-0000-0000-0000-0000000000a3'::uuid, 'aal1', 'accountant'),
      ('c1006000-0000-0000-0000-0000000000a4'::uuid, 'aal1', 'deactivated owner'),
      ('c1006000-0000-0000-0000-0000000000a5'::uuid, 'aal1', 'MFA owner on aal1'),
      ('c1006000-0000-0000-0000-0000000000b1'::uuid, 'aal1', 'other company owner')) as w(uid, aal, label)
  loop
    perform pg_temp.r1006_as(v_who.uid, v_who.aal);
    select count(*) into v_n from public.export_log;
    if v_n <> 0 then raise exception 'FAIL 3: % reads export_log (% rows)', v_who.label, v_n; end if;
  end loop;

  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a5', 'aal2');
  select count(*) into v_n from public.export_log;
  if v_n <> 1 then raise exception 'FAIL 3: MFA owner on aal2 cannot read export_log (% rows)', v_n; end if;

  -- ── 4. write: never for another company ────────────────────────────────────────────────
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000b1', 'aal1');
  begin
    insert into public.export_log (tenant_id, user_id, what, row_count, format)
      values ('c1006000-0000-0000-0000-0000000000f1', 'c1006000-0000-0000-0000-0000000000b1', 'forged', 1, 'csv');
    raise exception 'FAIL 4: other company inserted a row into company f1';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a1', 'aal1');
  begin
    insert into public.export_log (tenant_id, what, row_count, format)
      values ('c1006000-0000-0000-0000-0000000000f1', 'forged own', 1, 'csv');
    raise exception 'FAIL 4: owner inserted directly (bypassing log_export)';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
  begin
    delete from public.export_log;
    raise exception 'FAIL 4: owner deleted export_log rows';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;

  -- the other company's owner logging lands in THEIR company, never f1
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000b1', 'aal1');
  perform public.log_export('invoices', 5, 'xlsx');
  select count(*) into v_n from public.export_log where tenant_id = 'c1006000-0000-0000-0000-0000000000f2';
  if v_n <> 1 then raise exception 'FAIL 4: other owner''s export did not land in their own company'; end if;
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a1', 'aal1');
  select count(*) into v_n from public.export_log;
  if v_n <> 1 then raise exception 'FAIL 4: company f1 owner sees % rows (expected only its own 1)', v_n; end if;

  -- deactivated / aal1-MFA callers cannot log (no company session)
  for v_who in
    select * from (values
      ('c1006000-0000-0000-0000-0000000000a4'::uuid, 'deactivated owner'),
      ('c1006000-0000-0000-0000-0000000000a5'::uuid, 'MFA owner on aal1')) as w(uid, label)
  loop
    perform pg_temp.r1006_as(v_who.uid, 'aal1');
    begin
      perform public.log_export('customers', 1, 'csv');
      raise exception 'FAIL 4: % logged an export', v_who.label;
    exception when others then
      get stacked diagnostics v_st = returned_sqlstate;
      if v_st <> '42501' then raise; end if;
    end;
  end loop;

  -- bad format refused (check constraint), nothing written
  perform pg_temp.r1006_as('c1006000-0000-0000-0000-0000000000a2', 'aal1');
  begin
    perform public.log_export('customers', 1, 'exe');
    raise exception 'FAIL 4: unknown format accepted';
  exception when check_violation then null;
  end;
  if pg_temp.r1006_count() <> 2 then raise exception 'FAIL 4: refused calls wrote rows (% total)', pg_temp.r1006_count(); end if;
end $$;

-- anon: no execute at all
reset role;
set local role anon;
do $$
declare v_st text;
begin
  perform pg_temp.r1006_as(null, 'aal1');
  begin
    perform public.log_export('customers', 1, 'csv');
    raise exception 'FAIL 4: anon logged an export';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate;
    if v_st <> '42501' then raise; end if;
  end;
end $$;

reset role;
do $$ begin raise notice 'R-1006 export_log: all checks passed'; end $$;

rollback;
