-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'pf_full_wage')
-- deploy-key: r2698pffullwage
-- 20261112104228_r2698_employee_pf_full_wage.sql
--
-- R-2698 (12 Nov 2026, reported by an owner on staging): per-employee PF basis.
--   false (default) = PF on Basic + DA capped at the month's statutory ceiling (lib/payroll/pf.ts
--                     PF_WAGE_CEILINGS) — what payroll always did, so every existing employee
--                     keeps exactly the same PF.
--   true            = PF on the FULL Basic + DA (employer and employee chose to contribute above
--                     the ceiling). EPS stays on the capped wage (ecr.ts).
-- The value only feeds the NEXT salary the owner books (Pay salary form). Booked payslips keep
-- their stored pf / pf_employer / pf_wage — nothing here rewrites salary_payments.
-- Additive and idempotent: one boolean column with a default, no data change.

alter table public.employees add column if not exists pf_full_wage boolean not null default false;

-- employees is column-granted for SELECT (pin_hash hidden, 20261010010000): grant the new column.
grant select (pf_full_wage) on public.employees to authenticated;

comment on column public.employees.pf_full_wage is
  'R-2698: true = PF on the full Basic + DA (above the statutory ceiling); false = capped at the ceiling for the salary month.';
