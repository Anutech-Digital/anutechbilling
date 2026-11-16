-- R-2816 — DB guard: an empty Basic never means the whole gross (fills the company policy Basic %).
-- Migration: 20261116211326_r2816_basic_from_policy_guard.sql
-- FAILS without the migration (A: Basic stays empty), PASSES with it.
--
--   A  insert with a gross and no Basic → policy % (40% company: 12,000; no-settings company: 50%;
--      33,333 → 16,667; DA cap 30k/DA 20k → 10,000). A typed Basic is kept (even 0). Gross 0 → empty.
--   B  Edit (no revisions): gross changed on an empty-Basic row → filled; Basic cleared → filled again;
--      a name-only edit of an old empty-Basic row is NOT refused (left for the R-2815 repair).
--   C  Revise salary with no Basic (R-2699 revise_employee_salary, owner login) → the revision row AND
--      the employee row get the same policy Basic; prev_* history keeps the old value.
--   D  revised employee: the R-2699 guard still refuses a direct Basic change; an Edit that changes no
--      salary column leaves it alone.
--   E  undo_salary_revision restoring an empty prev Basic → filled with the policy % (never empty).
--   F  app.r2815_undo = 'on' (the R-2815 repair's logged undo) → the empty Basic is put back as asked.
--   H  another tenant's policy is never used (tenant with 70%, tenant with none = 50%); service_role / import insert fills too;
--      an issued payslip (salary_payments) of an employee that already had a Basic is untouched by guard-firing edits.
--   G  grants: the trigger functions are not executable by anon / authenticated.
--
-- Run: node scripts/test-sql.mjs --local r2816_basic_guard
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK. Expect "PASS r2816_basic_guard".

begin;

insert into auth.users (id, email) values
  ('c2816000-0000-0000-0000-0000000000a1', 'r2816-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2816000-0000-0000-0000-0000000000f0', 'R2816 Forty', 'r2816a@example.test', '07', 'R2816A'),
  ('c2816000-0000-0000-0000-0000000000f1', 'R2816 NoPolicy', 'r2816b@example.test', '07', 'R2816B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2816000-0000-0000-0000-0000000000a1', 'c2816000-0000-0000-0000-0000000000f0', 'r2816-owner@example.test', 'R2816 Owner', 'owner', true);

insert into public.attendance_settings (tenant_id, payroll_basic_pct) values ('c2816000-0000-0000-0000-0000000000f0', 40);

insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, joining_date) values
  ('c2816000-0000-4000-8000-0000000000e1', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Asha',   30000, null, 0,     '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e2', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Bina',   30000, null, 20000, '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e3', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Chetan', 30000, 9000, 0,     '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e4', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Dev',    0,     null, 0,     '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e5', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Esha',   30000, 12000, 0,    '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e6', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Zero',   30000, 0,    0,     '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000e7', 'c2816000-0000-0000-0000-0000000000f1', 'R2816 Gita',   33333, null, 0,     '2025-01-01');

-- A
do $$
declare v_bad int;
begin
  select count(*) into v_bad from (
    select name, basic_monthly from public.employees where tenant_id in ('c2816000-0000-0000-0000-0000000000f0', 'c2816000-0000-0000-0000-0000000000f1')
    except select * from (values ('R2816 Asha', 12000), ('R2816 Bina', 10000), ('R2816 Chetan', 9000), ('R2816 Dev', null::int),
                                 ('R2816 Esha', 12000), ('R2816 Zero', 0), ('R2816 Gita', 16667)) v(n, b)) x;
  if v_bad > 0 then raise exception 'FAIL A: % employees saved with an unexpected Basic (empty Basic must take the policy %%)', v_bad; end if;
  raise notice 'PASS A insert';
end $$;

-- B: an old empty-Basic row (as before this migration) — simulate by clearing under the undo flag
select set_config('app.r2815_undo', 'on', true);
update public.employees set basic_monthly = null where id in ('c2816000-0000-4000-8000-0000000000e1', 'c2816000-0000-4000-8000-0000000000e7');
select set_config('app.r2815_undo', '', true);
do $$
begin
  -- F: under the undo flag the empty Basic stays
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e1') is not null then
    raise exception 'FAIL F: the R-2815 undo flag did not keep the empty Basic';
  end if;
  raise notice 'PASS F undo flag';
  update public.employees set name = 'R2816 Asha K' where id = 'c2816000-0000-4000-8000-0000000000e1';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e1') is not null then
    raise exception 'FAIL B1: a name-only edit changed the Basic';
  end if;
  update public.employees set monthly_gross = 40000 where id = 'c2816000-0000-4000-8000-0000000000e1';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e1') is distinct from 16000 then
    raise exception 'FAIL B2: gross changed on an empty-Basic employee, Basic not policy 40%%';
  end if;
  update public.employees set basic_monthly = null where id = 'c2816000-0000-4000-8000-0000000000e3';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e3') is distinct from 12000 then
    raise exception 'FAIL B3: Basic cleared, not refilled with the policy';
  end if;
  -- an Edit form that sends every column unchanged on the old empty-Basic row (no revisions) → filled
  update public.employees set monthly_gross = monthly_gross, basic_monthly = null, da_monthly = da_monthly
   where id = 'c2816000-0000-4000-8000-0000000000e7';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e7') is distinct from 16667 then
    raise exception 'FAIL B4: full-row Edit of an empty-Basic employee (no revisions) not filled';
  end if;
  raise notice 'PASS B edit';
end $$;

-- C: Revise salary with no Basic, as the owner
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2816000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
do $$
declare v_id uuid; v_rev public.employee_salary_revisions;
begin
  v_id := public.revise_employee_salary('c2816000-0000-4000-8000-0000000000e5', '2026-12-01', 50000, null, 0, null, null);
  select * into v_rev from public.employee_salary_revisions where id = v_id;
  if v_rev.basic_monthly is distinct from 20000 then raise exception 'FAIL C1: revision Basic % (want policy 40%% = 20,000)', v_rev.basic_monthly; end if;
  if v_rev.prev_basic_monthly is distinct from 12000 then raise exception 'FAIL C2: prev Basic history changed: %', v_rev.prev_basic_monthly; end if;
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e5') is distinct from 20000 then
    raise exception 'FAIL C3: employee Basic not equal to the revision';
  end if;
  raise notice 'PASS C revise';
end $$;
reset role;

-- D: revised employee
do $$
begin
  begin
    update public.employees set basic_monthly = 1000 where id = 'c2816000-0000-4000-8000-0000000000e5';
    raise exception 'FAIL D1: direct Basic change on a revised employee accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%Revise salary%' then raise; end if;
  end;
  update public.employees set monthly_gross = monthly_gross, basic_monthly = basic_monthly, da_monthly = da_monthly
   where id = 'c2816000-0000-4000-8000-0000000000e5';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e5') is distinct from 20000 then
    raise exception 'FAIL D2: unchanged Edit moved a revised employee''s Basic';
  end if;
  raise notice 'PASS D revised guard';
end $$;

-- E: undo a revision whose prev Basic was empty (a revision made before this migration)
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, joining_date) values
  ('c2816000-0000-4000-8000-0000000000e8', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Farah', 45000, 22000, 0, '2025-01-01');
alter table public.employee_salary_revisions disable trigger trg_salary_revision_basic_from_policy;
insert into public.employee_salary_revisions (id, tenant_id, employee_id, effective_from, monthly_gross, basic_monthly, da_monthly,
                                              prev_monthly_gross, prev_basic_monthly, prev_da_monthly, created_at)
values ('c2816000-0000-4000-8000-0000000000a8', 'c2816000-0000-0000-0000-0000000000f0', 'c2816000-0000-4000-8000-0000000000e8',
        '2026-06-01', 45000, 22000, 0, 30000, null, 0, '2026-05-01');
alter table public.employee_salary_revisions enable trigger trg_salary_revision_basic_from_policy;
set local role authenticated;
do $$
begin
  perform public.undo_salary_revision('c2816000-0000-4000-8000-0000000000a8');
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e8') is distinct from 12000 then
    raise exception 'FAIL E: undo restored an empty Basic (want policy 40%% of 30,000 = 12,000), got %',
      (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e8');
  end if;
  raise notice 'PASS E undo revision';
end $$;
reset role;

-- H: tenant policy isolation, service role (import path), issued payslips untouched
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2816000-0000-0000-0000-0000000000f2', 'R2816 Seventy', 'r2816c@example.test', '07', 'R2816C');
insert into public.attendance_settings (tenant_id, payroll_basic_pct) values ('c2816000-0000-0000-0000-0000000000f2', 70);
insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net)
values ('c2816000-0000-0000-0000-0000000000f0', 'c2816000-0000-4000-8000-0000000000e3', '2026-09', '2026-09-30', 30000, 27000);
set local role service_role;
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, joining_date) values
  ('c2816000-0000-4000-8000-0000000000e9', 'c2816000-0000-0000-0000-0000000000f2', 'R2816 Hari', 20000, null, 0, '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000ea', 'c2816000-0000-0000-0000-0000000000f0', 'R2816 Indu', 20000, null, 0, '2025-01-01'),
  ('c2816000-0000-4000-8000-0000000000eb', 'c2816000-0000-0000-0000-0000000000f1', 'R2816 Jai',  20000, null, 0, '2025-01-01');
reset role;
do $$
declare v_pay record;
begin
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e9') is distinct from 14000 then
    raise exception 'FAIL H1: 70%% tenant, service-role insert, Basic not 14,000'; end if;
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000ea') is distinct from 8000 then
    raise exception 'FAIL H2: 40%% tenant took another tenant policy'; end if;
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000eb') is distinct from 10000 then
    raise exception 'FAIL H3: tenant with no policy row did not get the 50%% default'; end if;
  -- guard-firing edit on an employee that already has a Basic: Basic and issued payslip stay the same
  update public.employees set monthly_gross = monthly_gross, basic_monthly = basic_monthly, da_monthly = da_monthly
   where id = 'c2816000-0000-4000-8000-0000000000e3';
  if (select basic_monthly from public.employees where id = 'c2816000-0000-4000-8000-0000000000e3') is distinct from 12000 then
    raise exception 'FAIL H4: employee with a Basic changed by the guard'; end if;
  select gross, net into v_pay from public.salary_payments where employee_id = 'c2816000-0000-4000-8000-0000000000e3' and period = '2026-09';
  if v_pay.gross is distinct from 30000 or v_pay.net is distinct from 27000 then
    raise exception 'FAIL H5: an issued payslip changed'; end if;
  if (select count(*) from pg_trigger where tgname like '%basic_from_policy' and not tgisinternal) <> 2 then
    raise exception 'FAIL H6: guard triggers are not exactly the two expected'; end if;
  raise notice 'PASS H tenant isolation / service role / payslips';
end $$;

-- G
do $$
begin
  if has_function_privilege('authenticated', 'public.tg_employee_basic_from_policy()', 'execute')
     or has_function_privilege('anon', 'public.tg_employee_basic_from_policy()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_salary_revision_basic_from_policy()', 'execute') then
    raise exception 'FAIL G: trigger function executable by the app';
  end if;
  raise notice 'PASS G grants';
  raise notice 'PASS r2816_basic_guard';
end $$;

rollback;
