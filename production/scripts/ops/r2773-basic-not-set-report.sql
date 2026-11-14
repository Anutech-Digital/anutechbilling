-- R-2773 — READ-ONLY report: employees saved with Basic NOT set (basic_monthly is null), and the
-- salary months booked for them with PF. 14 Nov 2026.
--
-- WHY: Hitesh (feedback 043e6753): a new employee's Basic came out as 100% of the monthly gross
-- although the company payroll policy says Basic 50%. The Add employee form left the Basic box
-- empty when only a gross was typed; Save stored basic_monthly = null, and payroll (lib/payroll/pf.ts
-- pfWage) then takes the WHOLE gross as Basic — employee + employer PF and the gratuity provision on
-- the gross. From R-2773 the form fills Basic = the policy Basic % of the gross. Employees already
-- saved are NOT changed (their Basic, and every booked month, stays as it is): filling their Basic
-- is a data repair — Pardeep's call. This report only counts them.
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; … rollback;`.
-- No PAN, phone, email or bank detail is selected — company, employee name, salary figures only.
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. COUNT per company: active employees, Basic not set, of those PF on, the company's policy Basic %.
--   2. ROWS: employees with Basic not set (gross, PF on/off, joined, created) — newest first, 200 max.
--   3. COUNT per company: booked salary months of those employees that carry PF (the PF there was
--      worked on the whole gross), with the PF booked vs the PF had Basic been the policy % —
--      an ESTIMATE (gross × policy %, + DA, capped at the month's ceiling unless PF full wage).
--   4. ROWS: those booked months (period, gross, PF wage booked, PF booked, estimated PF on policy Basic).
--
-- WHO RUNS IT: the manager or Pardeep on staging/live. Claude does not run it there.
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2773-basic-not-set-report.sql

begin;
set transaction read only;

\pset footer on
\pset null '·'

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies ==='
select current_user                                                     as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                             as tenants_visible,
       now() at time zone 'Asia/Kolkata'                                 as run_at_ist;

\echo
\echo '=== 1. Employees with Basic not set, per company ==='
select t.name                                                            as company,
       count(*) filter (where e.is_active)                               as active_employees,
       count(*) filter (where e.basic_monthly is null and coalesce(e.monthly_gross, 0) > 0) as basic_not_set,
       count(*) filter (where e.basic_monthly is null and coalesce(e.monthly_gross, 0) > 0 and e.is_active) as basic_not_set_active,
       count(*) filter (where e.basic_monthly is null and coalesce(e.monthly_gross, 0) > 0 and e.pf_applicable) as basic_not_set_pf_on,
       max(s.payroll_basic_pct)                                          as policy_basic_pct
  from public.employees e
  join public.tenants t on t.id = e.tenant_id
  left join public.attendance_settings s on s.tenant_id = e.tenant_id
 group by t.name
having count(*) filter (where e.basic_monthly is null and coalesce(e.monthly_gross, 0) > 0) > 0
 order by t.name;

\echo
\echo '=== 2. Employees with Basic not set (newest first, 200 max) ==='
select t.name                                         as company,
       e.name                                         as employee,
       e.monthly_gross                                as gross_month,
       e.da_monthly                                   as da_month,
       e.pf_applicable                                as pf_on,
       coalesce(e.pf_full_wage, false)                as pf_full_wage,
       e.is_active                                    as active,
       e.joining_date                                 as joined,
       (e.created_at at time zone 'Asia/Kolkata')::date as created_ist,
       round(e.monthly_gross * coalesce(s.payroll_basic_pct, 50) / 100.0) as basic_at_policy_pct
  from public.employees e
  join public.tenants t on t.id = e.tenant_id
  left join public.attendance_settings s on s.tenant_id = e.tenant_id
 where e.basic_monthly is null
   and coalesce(e.monthly_gross, 0) > 0
 order by e.created_at desc
 limit 200;

\echo
\echo '=== 3. Booked salary months with PF for those employees, per company (PF there was on the whole gross) ==='
with m as (
  select sp.tenant_id, sp.employee_id, sp.period, sp.gross, sp.pf, sp.pf_employer, sp.pf_wage,
         coalesce(sp.salary_in_force, e.monthly_gross)                      as gross_in_force,
         coalesce(e.da_monthly, 0)                                          as da,
         coalesce(e.pf_full_wage, false)                                    as full_wage,
         coalesce(s.payroll_basic_pct, 50)                                  as pct,
         case when sp.period >= '2026-10' then 25000 else 15000 end         as ceiling
    from public.salary_payments sp
    join public.employees e on e.id = sp.employee_id and e.tenant_id = sp.tenant_id
    left join public.attendance_settings s on s.tenant_id = sp.tenant_id
   where e.basic_monthly is null
     and coalesce(sp.pf, 0) > 0
), est as (
  select m.*,
         round(0.12 * case when m.full_wage
                           then round(m.gross_in_force * m.pct / 100.0) + m.da
                           else least(round(m.gross_in_force * m.pct / 100.0) + m.da, m.ceiling) end) as pf_at_policy_basic
    from m
)
select t.name                                         as company,
       count(*)                                       as months_booked_with_pf,
       count(distinct est.employee_id)                as employees,
       min(est.period)                                as first_month,
       max(est.period)                                as last_month,
       sum(est.pf)                                    as employee_pf_booked,
       sum(est.pf_at_policy_basic)                    as employee_pf_at_policy_basic_estimate,
       sum(est.pf) - sum(est.pf_at_policy_basic)      as employee_pf_extra_estimate
  from est
  join public.tenants t on t.id = est.tenant_id
 group by t.name
 order by t.name;

\echo
\echo '=== 4. Those booked months (newest first, 200 max) ==='
with m as (
  select sp.tenant_id, sp.employee_id, sp.period, sp.gross, sp.pf, sp.pf_employer, sp.pf_wage,
         coalesce(sp.salary_in_force, e.monthly_gross)                      as gross_in_force,
         coalesce(e.da_monthly, 0)                                          as da,
         coalesce(e.pf_full_wage, false)                                    as full_wage,
         coalesce(s.payroll_basic_pct, 50)                                  as pct,
         case when sp.period >= '2026-10' then 25000 else 15000 end         as ceiling,
         e.name                                                             as employee
    from public.salary_payments sp
    join public.employees e on e.id = sp.employee_id and e.tenant_id = sp.tenant_id
    left join public.attendance_settings s on s.tenant_id = sp.tenant_id
   where e.basic_monthly is null
     and coalesce(sp.pf, 0) > 0
)
select t.name as company, m.employee, m.period, m.gross, m.pf_wage as pf_wage_booked,
       m.pf as employee_pf_booked, m.pf_employer as employer_pf_booked,
       round(0.12 * case when m.full_wage
                         then round(m.gross_in_force * m.pct / 100.0) + m.da
                         else least(round(m.gross_in_force * m.pct / 100.0) + m.da, m.ceiling) end) as employee_pf_at_policy_basic_estimate
  from m
  join public.tenants t on t.id = m.tenant_id
 order by m.period desc, t.name, m.employee
 limit 200;

rollback;
