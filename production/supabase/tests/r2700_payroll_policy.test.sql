-- R-2700: company payroll policy columns on attendance_settings — defaults = the old behaviour,
-- Basic % kept within 10..100, readable by a login (column grant) but never writable directly,
-- and the office-code / device secrets stay hidden. Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2700000-0000-0000-0000-0000000000f0', 'R2700 T', 'r2700@example.test', '07', null, 'R2700');

do $$
declare r record;
begin
  -- 1. columns exist; a row created without them gets the pre-R-2700 behaviour
  insert into public.attendance_settings (tenant_id) values ('b2700000-0000-0000-0000-0000000000f0');
  select payroll_pf_default, payroll_pf_full_wage_default, payroll_esi_default, payroll_gratuity,
         payroll_ctc_includes_employer, payroll_basic_pct
    into r from public.attendance_settings where tenant_id = 'b2700000-0000-0000-0000-0000000000f0';
  if r.payroll_pf_default is distinct from false or r.payroll_pf_full_wage_default is distinct from false
     or r.payroll_esi_default is distinct from true or r.payroll_gratuity is distinct from true
     or r.payroll_ctc_includes_employer is distinct from true or r.payroll_basic_pct is distinct from 50 then
    raise exception 'FAIL 1: defaults are not the old behaviour: %', r;
  end if;

  -- 2. Basic % outside 10..100 refused
  begin
    update public.attendance_settings set payroll_basic_pct = 5 where tenant_id = 'b2700000-0000-0000-0000-0000000000f0';
    raise exception 'FAIL 2a: basic 5%% accepted';
  exception when check_violation then null;
  end;
  begin
    update public.attendance_settings set payroll_basic_pct = 150 where tenant_id = 'b2700000-0000-0000-0000-0000000000f0';
    raise exception 'FAIL 2b: basic 150%% accepted';
  exception when check_violation then null;
  end;
  update public.attendance_settings set payroll_basic_pct = 40, payroll_ctc_includes_employer = false
   where tenant_id = 'b2700000-0000-0000-0000-0000000000f0';

  -- 3. a login may READ the policy columns, never write them directly
  if not has_column_privilege('authenticated', 'public.attendance_settings', 'payroll_ctc_includes_employer', 'SELECT')
     or not has_column_privilege('authenticated', 'public.attendance_settings', 'payroll_basic_pct', 'SELECT') then
    raise exception 'FAIL 3a: policy columns not readable by a login';
  end if;
  if has_column_privilege('authenticated', 'public.attendance_settings', 'payroll_basic_pct', 'UPDATE')
     or has_column_privilege('authenticated', 'public.attendance_settings', 'payroll_gratuity', 'INSERT')
     or has_column_privilege('anon', 'public.attendance_settings', 'payroll_basic_pct', 'SELECT') then
    raise exception 'FAIL 3b: policy columns writable by a login, or readable by anon';
  end if;

  -- 4. the secrets on the same row stay hidden (R-833)
  if has_column_privilege('authenticated', 'public.attendance_settings', 'presence_secret', 'SELECT')
     or has_column_privilege('authenticated', 'public.attendance_settings', 'ingest_key', 'SELECT') then
    raise exception 'FAIL 4: a secret column became readable';
  end if;
  raise notice 'r2700_payroll_policy: all checks passed';
end $$;

rollback;
