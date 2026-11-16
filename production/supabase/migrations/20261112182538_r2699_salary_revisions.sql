-- deploy-peek: to_regclass('public.employee_salary_revisions') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_salary_with_arrears(uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer,integer)') and prosrc like '%is more than the%still due%')
-- deploy-key: r2699salaryrevisions
-- 20261112182538_r2699_salary_revisions.sql
--
-- R-2699 (12 Nov 2026, Excel owner's report): "salary increment ka option nahi; naya salary kis
-- mahine se lagega; us date se pehle ke payroll mein purani salary, us date se nayi; history".
--
-- 1. public.employee_salary_revisions — one row per revision: the new structure (gross, Basic,
--    DA, CTC), the MONTH it starts (effective_from = 1st of the month) and the structure it
--    replaced (prev_*). employees.monthly_gross / basic_monthly / da_monthly hold the salary
--    GOING FORWARD (the latest revision). Salary in force for month M = prev_* of the earliest
--    revision whose month is after M, else the employees row (lib/payroll/salary-revision.ts —
--    the same rule as _salary_in_force_gross below).
--    Read: tenant + owner / manager / accountant (same as salary_payments, R-1003).
--    Write: only through revise_employee_salary / undo_salary_revision (no write policy).
-- 2. Booked salary months are NEVER changed. A revision dated into a booked month gives arrears:
--    per booked month, earned (gross − LOP) × new / old − earned, old = the salary in force when
--    that month was booked (employee_salary_arrears). salary_payments.arrears = arrears paid
--    with a later salary. pay_salary_with_arrears books them in the PAYING month through
--    pay_salary itself (incentive += arrears, so net / expense / LOP adjust / payslip stay
--    consistent) — pay_salary is not changed.
-- Test: supabase/tests/r2699_salary_revision.test.sql (rolled back).

begin;

alter table public.salary_payments add column if not exists arrears integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'salary_payments_arrears_nonneg') then
    alter table public.salary_payments add constraint salary_payments_arrears_nonneg check (arrears >= 0 and arrears <= incentive);
  end if;
end $$;
comment on column public.salary_payments.arrears is
  'R-2699: salary-revision arrears paid with this salary (part of incentive; booked in this month).';

create table if not exists public.employee_salary_revisions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  employee_id         uuid not null references public.employees(id) on delete cascade,
  effective_from      date not null check (extract(day from effective_from) = 1),
  monthly_gross       integer not null check (monthly_gross > 0),
  basic_monthly       integer check (basic_monthly is null or basic_monthly >= 0),
  da_monthly          integer not null default 0 check (da_monthly >= 0),
  annual_ctc          integer check (annual_ctc is null or annual_ctc >= 0),
  prev_monthly_gross  integer not null check (prev_monthly_gross >= 0),
  prev_basic_monthly  integer,
  prev_da_monthly     integer not null default 0,
  note                text,
  created_by          uuid default public.current_user_id(),
  created_at          timestamptz not null default clock_timestamp(),
  unique (employee_id, effective_from)
);
create index if not exists employee_salary_revisions_tenant_idx on public.employee_salary_revisions (tenant_id, employee_id);

alter table public.employee_salary_revisions enable row level security;
drop policy if exists employee_salary_revisions_select_payroll on public.employee_salary_revisions;
create policy employee_salary_revisions_select_payroll on public.employee_salary_revisions
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_has_role('owner', 'manager', 'accountant')
  );
revoke all on table public.employee_salary_revisions from anon;
revoke insert, update, delete, truncate on table public.employee_salary_revisions from authenticated;
grant select on table public.employee_salary_revisions to authenticated;
grant all on table public.employee_salary_revisions to service_role;
drop policy if exists zzz_service_role_all on public.employee_salary_revisions;
create policy zzz_service_role_all on public.employee_salary_revisions as permissive for all to service_role using (true) with check (true);

comment on table public.employee_salary_revisions is
  'R-2699: salary revisions (increments) with the month they start and the salary they replaced.';

-- Salary gross in force for p_period (YYYY-MM) as things stand now: prev_monthly_gross of the
-- earliest revision after that month, else the employees row (same rule as salaryInForce in
-- lib/payroll/salary-revision.ts).
create or replace function public._salary_in_force_gross(p_employee_id uuid, p_period text)
 returns integer
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(
    (select r.prev_monthly_gross from public.employee_salary_revisions r
      where r.employee_id = p_employee_id and to_char(r.effective_from, 'YYYY-MM') > p_period
      order by r.effective_from limit 1),
    (select e.monthly_gross from public.employees e where e.id = p_employee_id)
  );
$function$;
-- SECURITY INVOKER: a direct caller sees only what RLS lets them (revisions: payroll roles of their
-- own company; the employees gross every member already reads). Cloud SQL needs the explicit grant (R-400).
revoke all on function public._salary_in_force_gross(uuid, text) from public, anon;
grant execute on function public._salary_in_force_gross(uuid, text) to authenticated, service_role;

-- The salary in force for the month AT BOOKING is stored on the row (arrears are worked out
-- against it — never rebuilt from history, which a direct edit of the employee's gross would
-- break). Every insert path (pay_salary, salary from a bank line, owner equity) goes through this.
alter table public.salary_payments add column if not exists salary_in_force integer;
comment on column public.salary_payments.salary_in_force is
  'R-2699: the employee''s monthly gross in force for this month when it was booked (arrears base).';
-- Rows booked before this migration stay null (no backfill: an UPDATE would hit the books lock on
-- locked months). Their base is the salary before the employee's FIRST revision (its prev), else
-- the employee's gross — no revision existed when they were booked — but never below the gross
-- actually booked that month: a gross edited DOWN (Employees -> Edit) after the booking must not
-- turn a month already paid at the higher salary into arrears (independent review, R-2699).

create or replace function public.tg_salary_payment_in_force()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- Same-company employee only (a direct insert naming another company's employee reads nothing).
  if new.salary_in_force is null
     and exists (select 1 from public.employees e where e.id = new.employee_id and e.tenant_id = new.tenant_id) then
    new.salary_in_force := public._salary_in_force_gross(new.employee_id, new.period);
  end if;
  return new;
end; $function$;
revoke all on function public.tg_salary_payment_in_force() from public, anon, authenticated;
drop trigger if exists trg_salary_payment_in_force on public.salary_payments;
create trigger trg_salary_payment_in_force
  before insert on public.salary_payments
  for each row execute function public.tg_salary_payment_in_force();

-- Guards (independent review, R-2699): once an employee has a revision, gross / Basic / DA change
-- only through revise_employee_salary / undo_salary_revision (history stays true); and the arrears
-- bookkeeping on salary_payments (arrears, salary_in_force) is written only by this migration's
-- functions — not through the table's UPDATE grant.
create or replace function public.tg_employee_salary_via_revision()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if (new.monthly_gross is distinct from old.monthly_gross
      or new.basic_monthly is distinct from old.basic_monthly
      or new.da_monthly is distinct from old.da_monthly)
     and coalesce(current_setting('app.r2699_salary_revision', true), '') <> 'on'
     and exists (select 1 from public.employee_salary_revisions r where r.employee_id = old.id) then
    raise exception '%''s salary is set by salary revisions — change it with Revise salary in the employee profile.', old.name
      using errcode = 'P0001';
  end if;
  return new;
end; $function$;
drop trigger if exists trg_employee_salary_via_revision on public.employees;
create trigger trg_employee_salary_via_revision
  before update of monthly_gross, basic_monthly, da_monthly on public.employees
  for each row execute function public.tg_employee_salary_via_revision();

create or replace function public.tg_salary_arrears_columns_locked()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if (new.arrears is distinct from old.arrears or new.salary_in_force is distinct from old.salary_in_force)
     and coalesce(current_setting('app.r2699_salary_arrears', true), '') <> 'on' then
    raise exception 'Salary revision arrears on a booked salary can''t be edited — undo that salary and pay it again.'
      using errcode = 'P0001';
  end if;
  return new;
end; $function$;
drop trigger if exists trg_salary_arrears_columns_locked on public.salary_payments;
create trigger trg_salary_arrears_columns_locked
  before update of arrears, salary_in_force on public.salary_payments
  for each row execute function public.tg_salary_arrears_columns_locked();

-- Arrears per booked month (R-2699). SECURITY DEFINER: callers are payroll roles in the same
-- tenant (checked here), so the private helper above can stay revoked from authenticated.
create or replace function public.employee_salary_arrears(p_employee_id uuid)
 returns table (period text, earned integer, old_gross integer, new_gross integer, arrears integer)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_trusted boolean;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can see salary arrears' using errcode = '42501';
  end if;
  if not v_trusted and not exists (select 1 from public.employees e where e.id = p_employee_id and e.tenant_id = public.current_tenant_id()) then
    raise exception 'Employee not found in your company — refresh the page.';
  end if;
  return query
    select x.period, x.earned, x.old_g, x.new_g,
           case when x.old_g > 0 and x.new_g > x.old_g and x.earned > 0
                then (round(x.earned::numeric * x.new_g / x.old_g))::integer - x.earned else 0 end
      from (
        select sp.period::text as period,
               greatest(sp.gross - coalesce(sp.lop_amount, 0), 0)::integer as earned,
               coalesce(sp.salary_in_force,
                        greatest(
                          coalesce((select r.prev_monthly_gross from public.employee_salary_revisions r
                                     where r.employee_id = p_employee_id order by r.created_at limit 1),
                                   (select e.monthly_gross from public.employees e where e.id = p_employee_id)),
                          sp.gross)) as old_g,
               public._salary_in_force_gross(p_employee_id, sp.period) as new_g
          from public.salary_payments sp
         where sp.employee_id = p_employee_id
      ) x
     order by x.period;
end; $function$;
revoke all on function public.employee_salary_arrears(uuid) from public, anon;
grant execute on function public.employee_salary_arrears(uuid) to authenticated, service_role;

create or replace function public.revise_employee_salary(
  p_employee_id uuid, p_effective_from date, p_monthly_gross integer,
  p_basic_monthly integer default null, p_da_monthly integer default 0,
  p_annual_ctc integer default null, p_note text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean;
  v_emp public.employees;
  v_from date := date_trunc('month', p_effective_from)::date;
  v_last date;
  v_gross integer := coalesce(p_monthly_gross, 0);
  v_da integer := coalesce(p_da_monthly, 0);
  v_paid text;
  v_id uuid;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can revise a salary' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if p_effective_from is null then raise exception 'Pick the month the new salary starts from.'; end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Employee not found in your company — refresh the page.'; end if;
  if v_gross <= 0 then raise exception 'Enter the new monthly gross salary (more than ₹0).'; end if;
  if coalesce(p_basic_monthly, 0) < 0 or v_da < 0 then raise exception 'Basic and DA can''t be negative.'; end if;
  if coalesce(p_basic_monthly, 0) + v_da > v_gross then
    raise exception 'Basic + DA can''t be more than the monthly gross.';
  end if;
  if v_emp.joining_date is not null and v_from < date_trunc('month', v_emp.joining_date)::date then
    raise exception 'The new salary can''t start before % — % joined that month.', to_char(v_emp.joining_date, 'Mon YYYY'), v_emp.name;
  end if;
  if v_emp.exit_date is not null and v_from > date_trunc('month', v_emp.exit_date)::date then
    raise exception 'The new salary can''t start after % — that is %''s last month.', to_char(v_emp.exit_date, 'Mon YYYY'), v_emp.name;
  end if;
  select max(effective_from) into v_last from public.employee_salary_revisions where employee_id = p_employee_id;
  if v_last is not null and v_from <= v_last then
    raise exception 'A salary revision from % already exists — a new one must start after that month (or undo it first).', to_char(v_last, 'Mon YYYY');
  end if;
  if v_gross = v_emp.monthly_gross and p_basic_monthly is not distinct from v_emp.basic_monthly
     and v_da = coalesce(v_emp.da_monthly, 0) then
    raise exception 'The new salary is the same as the current one.';
  end if;
  if v_gross < v_emp.monthly_gross then
    select to_char(to_date(max(sp.period), 'YYYY-MM'), 'Mon YYYY') into v_paid
      from public.salary_payments sp
     where sp.employee_id = p_employee_id and sp.period >= to_char(v_from, 'YYYY-MM');
    if v_paid is not null then
      raise exception 'A lower salary can''t start in a month that is already paid (%). Pick a month after the last paid one.', v_paid;
    end if;
  end if;

  insert into public.employee_salary_revisions
    (tenant_id, employee_id, effective_from, monthly_gross, basic_monthly, da_monthly, annual_ctc,
     prev_monthly_gross, prev_basic_monthly, prev_da_monthly, note, created_by)
  values
    (v_tenant, p_employee_id, v_from, v_gross, p_basic_monthly, v_da, p_annual_ctc,
     v_emp.monthly_gross, v_emp.basic_monthly, coalesce(v_emp.da_monthly, 0),
     nullif(trim(coalesce(p_note, '')), ''), public.current_user_id())
  returning id into v_id;

  perform set_config('app.r2699_salary_revision', 'on', true);
  update public.employees
     set monthly_gross = v_gross, basic_monthly = p_basic_monthly, da_monthly = v_da, updated_at = now()
   where id = p_employee_id;
  perform set_config('app.r2699_salary_revision', '', true);
  return v_id;
end; $function$;
revoke all on function public.revise_employee_salary(uuid, date, integer, integer, integer, integer, text) from public, anon;
grant execute on function public.revise_employee_salary(uuid, date, integer, integer, integer, integer, text) to authenticated, service_role;

create or replace function public.undo_salary_revision(p_revision_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean;
  v_rev public.employee_salary_revisions;
  v_month text;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can undo a salary revision' using errcode = '42501';
  end if;
  select * into v_rev from public.employee_salary_revisions where id = p_revision_id and tenant_id = v_tenant;
  if not found then raise exception 'That salary revision is not in your company — refresh the page.'; end if;
  perform 1 from public.employees where id = v_rev.employee_id for update;
  select to_char(max(effective_from), 'Mon YYYY') into v_month from public.employee_salary_revisions
   where employee_id = v_rev.employee_id and effective_from > v_rev.effective_from;
  if v_month is not null then
    raise exception 'Only the latest salary revision can be undone — undo the one from % first.', v_month;
  end if;
  select to_char(to_date(min(sp.period), 'YYYY-MM'), 'Mon YYYY') into v_month
    from public.salary_payments sp
   where sp.employee_id = v_rev.employee_id and sp.created_at > v_rev.created_at
     and (sp.period >= to_char(v_rev.effective_from, 'YYYY-MM') or sp.arrears > 0);
  if v_month is not null then
    raise exception 'Salary for % is already booked on this revision — undo that salary first.', v_month;
  end if;
  perform set_config('app.r2699_salary_revision', 'on', true);
  update public.employees
     set monthly_gross = v_rev.prev_monthly_gross, basic_monthly = v_rev.prev_basic_monthly,
         da_monthly = v_rev.prev_da_monthly, updated_at = now()
   where id = v_rev.employee_id;
  perform set_config('app.r2699_salary_revision', '', true);
  delete from public.employee_salary_revisions where id = p_revision_id;
end; $function$;
revoke all on function public.undo_salary_revision(uuid) from public, anon;
grant execute on function public.undo_salary_revision(uuid) to authenticated, service_role;

-- Pay salary + revision arrears in one transaction. Same parameters as pay_salary plus p_arrears.
create or replace function public.pay_salary_with_arrears(p_employee_id uuid, p_period text, p_pay_date date, p_gross integer, p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer, p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer, p_other integer, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_incentive integer DEFAULT 0, p_esi_employer integer DEFAULT 0, p_pf_employer integer DEFAULT 0, p_pf_wage integer DEFAULT NULL, p_arrears integer DEFAULT 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean;
  v_arr integer := greatest(coalesce(p_arrears, 0), 0);
  v_due integer; v_paid integer; v_left integer; v_last text;
  v_id uuid;
  v_exp text;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can pay a salary' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  -- One payer at a time per employee: a retry or a second tab sees the first one's arrears.
  perform 1 from public.employees where id = p_employee_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Employee not found'; end if;
  if v_arr > 0 then
    select coalesce(sum(a.arrears), 0) into v_due from public.employee_salary_arrears(p_employee_id) a;
    select coalesce(sum(sp.arrears), 0) into v_paid from public.salary_payments sp where sp.employee_id = p_employee_id;
    v_left := greatest(v_due - v_paid, 0);
    if v_arr > v_left then
      raise exception 'Arrears ₹% is more than the ₹% still due for this employee.', v_arr, v_left;
    end if;
    -- Arrears are for months already paid: book them with a LATER month's salary, never in a
    -- backlog month before the raise.
    select max(a.period) into v_last from public.employee_salary_arrears(p_employee_id) a where a.arrears > 0;
    if v_last is not null and p_period <= v_last then
      raise exception 'Arrears can be paid with a salary for a month after % — pay this month without them.', to_char(to_date(v_last, 'YYYY-MM'), 'Mon YYYY');
    end if;
  end if;
  v_id := public.pay_salary(p_employee_id, p_period, p_pay_date, p_gross, p_lop_days, p_lop_amount,
                            p_advance_recovered, p_advance_loan_id, p_tds, p_pf, p_esi, p_other,
                            p_bank_account_id, p_notes, greatest(coalesce(p_incentive, 0), 0) + v_arr,
                            p_esi_employer, p_pf_employer, p_pf_wage);
  if v_arr > 0 then
    perform set_config('app.r2699_salary_arrears', 'on', true);
    update public.salary_payments set arrears = v_arr where id = v_id returning expense_id into v_exp;
    perform set_config('app.r2699_salary_arrears', '', true);
    update public.expenses
       set description = description || ' (incl. salary revision arrears ₹' || v_arr || ')'
     where id = v_exp and tenant_id = v_tenant;
  end if;
  return v_id;
end; $function$;
revoke all on function public.pay_salary_with_arrears(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.pay_salary_with_arrears(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) to authenticated, service_role;

commit;
