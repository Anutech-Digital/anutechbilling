-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_employee_zz_basic_from_policy' and tgrelid = to_regclass('public.employees') and not tgisinternal) and exists(select 1 from pg_trigger where tgname = 'trg_salary_revision_basic_from_policy' and tgrelid = to_regclass('public.employee_salary_revisions') and not tgisinternal) and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_employee_basic_from_policy()') and prosrc like '%R-2816%')
-- deploy-key: r2816basicfrompolicyguard
-- 20261114112800_r2816_basic_from_policy_guard.sql
--
-- R-2816 (14 Nov 2026, owner OK: Pardeep 16:40 IST "haan dono pe haan", ownerDecision on R-2773) —
-- DB guard: an empty Basic never means the whole gross again.
--
-- WHY (R-2773, Hitesh feedback 043e6753): employees saved with basic_monthly = null were paid PF and
-- carried gratuity on the WHOLE gross (lib/payroll/pf.ts pfWage). R-2773 fixed the forms; any other
-- path (an import, an API call, a revision with no Basic, a SQL insert) could still save an empty
-- Basic. No SQL function computes PF / ESI from Basic (PF is worked in lib/payroll/pf.ts — R-2816 makes
-- it use the policy %, never the gross; ESI is on the gross by law).
--
-- THE GUARD — fills, never refuses (≈20 SQL tests, two dev scenarios and the e2e seed insert employees
-- with a gross and no Basic; a refusal would break every import path instead of fixing it):
--   employees, BEFORE INSERT / UPDATE OF monthly_gross, basic_monthly, da_monthly
--     basic_monthly IS NULL and monthly_gross > 0  →  basic_monthly = the company payroll policy's Basic %
--     of the gross (attendance_settings.payroll_basic_pct; no row / out of range = 50), round, never above
--     gross − DA, never below 0 — the SAME rule as lib/payroll/salary-revision.ts basicAtPct and the
--     R-2815 repair (r2815_policy_basic).
--     On an UPDATE only when a salary column really changed, or the employee has no salary revision:
--     a revised employee's Basic is set by Revise salary (R-2699 guard trg_employee_salary_via_revision
--     runs first — this trigger's name sorts after it), so an Edit that changes nothing never rewrites it.
--     Skipped while app.r2815_undo = 'on' (the logged undo of the R-2815 repair puts the empty Basic back).
--   employee_salary_revisions, BEFORE INSERT: a revision saved with no Basic gets the same policy Basic
--     (revise_employee_salary inserts the revision row first, then the employee row — both end equal).
--   prev_* history and salary_payments are never touched.
-- Existing empty Basics are filled by the R-2815 repair (owner runs scripts/ops/r2773b-fill-basic.sql).
-- A CHECK (basic_monthly is not null or monthly_gross <= 0) can be VALIDATEd once live is repaired —
-- follow-up, not here (a NOT VALID check would refuse a name edit on an unrepaired employee).
-- Test: supabase/tests/r2816_basic_guard.test.sql (rolled back).

begin;

create or replace function public.tg_employee_basic_from_policy()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pct integer;
  v_gross integer := coalesce(new.monthly_gross, 0);
  v_da integer := greatest(0, coalesce(new.da_monthly, 0));
begin
  -- R-2816: an empty Basic never means the whole gross — fill it with the company policy Basic %.
  if new.basic_monthly is not null or v_gross <= 0 then return new; end if;
  if coalesce(current_setting('app.r2815_undo', true), '') = 'on' then return new; end if;
  if tg_op = 'UPDATE'
     and new.monthly_gross is not distinct from old.monthly_gross
     and new.basic_monthly is not distinct from old.basic_monthly
     and new.da_monthly is not distinct from old.da_monthly
     and exists (select 1 from public.employee_salary_revisions r where r.employee_id = new.id) then
    return new;   -- nothing salary-wise changed on a revised employee: Revise salary owns it
  end if;
  select s.payroll_basic_pct into v_pct from public.attendance_settings s where s.tenant_id = new.tenant_id;
  if v_pct is null or v_pct not between 10 and 100 then v_pct := 50; end if;
  new.basic_monthly := least(greatest(0, v_gross - v_da), round(v_gross::numeric * v_pct / 100)::integer);
  return new;
end; $function$;
revoke all on function public.tg_employee_basic_from_policy() from public, anon, authenticated;

drop trigger if exists trg_employee_zz_basic_from_policy on public.employees;
create trigger trg_employee_zz_basic_from_policy
  before insert or update of monthly_gross, basic_monthly, da_monthly on public.employees
  for each row execute function public.tg_employee_basic_from_policy();

create or replace function public.tg_salary_revision_basic_from_policy()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pct integer;
  v_gross integer := coalesce(new.monthly_gross, 0);
  v_da integer := greatest(0, coalesce(new.da_monthly, 0));
begin
  -- R-2816: a salary revision with no Basic gets the company policy Basic % (same rule as employees).
  if new.basic_monthly is not null or v_gross <= 0 then return new; end if;
  select s.payroll_basic_pct into v_pct from public.attendance_settings s where s.tenant_id = new.tenant_id;
  if v_pct is null or v_pct not between 10 and 100 then v_pct := 50; end if;
  new.basic_monthly := least(greatest(0, v_gross - v_da), round(v_gross::numeric * v_pct / 100)::integer);
  return new;
end; $function$;
revoke all on function public.tg_salary_revision_basic_from_policy() from public, anon, authenticated;

drop trigger if exists trg_salary_revision_basic_from_policy on public.employee_salary_revisions;
create trigger trg_salary_revision_basic_from_policy
  before insert on public.employee_salary_revisions
  for each row execute function public.tg_salary_revision_basic_from_policy();

comment on function public.tg_employee_basic_from_policy() is
  'R-2816: an employee saved with a gross and no Basic gets the company payroll policy Basic % (never the whole gross).';

commit;
