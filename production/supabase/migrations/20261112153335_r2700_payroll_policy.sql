-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'payroll_ctc_includes_employer')
-- deploy-key: r2700payrollpolicy
-- 20261112153335_r2700_payroll_policy.sql
--
-- R-2700 (12 Nov 2026, Hitesh item 8): the company's payroll policy — ESI / PF / gratuity and
-- how a CTC is split — set once, used as defaults for NEW employees and by the CTC calculator.
--
-- No new table: the workspace's HR settings row (attendance_settings — one row per tenant,
-- already holding the late / half-day salary rules, R-439 / R-604) gets six columns. Each
-- default is the app's behaviour before this card, so a workspace without a row, or one that
-- never saves the policy, sees no change:
--   payroll_pf_default              false  new employee starts PF off
--   payroll_pf_full_wage_default    false  PF capped at the month's ceiling (lib/payroll/pf.ts)
--   payroll_esi_default             true   ESI suggested when gross <= Rs 21,000 (esi.ts)
--   payroll_gratuity                true   gratuity 4.81% of Basic is part of the CTC
--   payroll_ctc_includes_employer   true   monthly gross = CTC/12 - employer PF/ESI/gratuity
--   payroll_basic_pct               50     Basic as % of the monthly salary (10..100)
-- Pay salary never reads these (it reads the employee's own switches): booked salary_payments
-- and existing employees are untouched. Written only by POST /api/payroll/policy (owner check,
-- then the server client scoped to the owner's tenant) — so no INSERT/UPDATE grant here.
-- Additive and idempotent.

alter table public.attendance_settings
  add column if not exists payroll_pf_default boolean not null default false,
  add column if not exists payroll_pf_full_wage_default boolean not null default false,
  add column if not exists payroll_esi_default boolean not null default true,
  add column if not exists payroll_gratuity boolean not null default true,
  add column if not exists payroll_ctc_includes_employer boolean not null default true,
  add column if not exists payroll_basic_pct smallint not null default 50;

alter table public.attendance_settings drop constraint if exists attendance_settings_payroll_basic_pct_check;
alter table public.attendance_settings add constraint attendance_settings_payroll_basic_pct_check
  check (payroll_basic_pct between 10 and 100);

/* R-601 / R-833: attendance_settings is COLUMN-granted for authenticated — a new column is
   invisible to the app until it is granted by name. Read only; writes go through the route. */
grant select (payroll_pf_default, payroll_pf_full_wage_default, payroll_esi_default,
              payroll_gratuity, payroll_ctc_includes_employer, payroll_basic_pct)
  on public.attendance_settings to authenticated;

comment on column public.attendance_settings.payroll_ctc_includes_employer is
  'R-2700: true = an employee''s CTC includes employer PF / ESI / gratuity (gross = CTC/12 minus them); false = CTC is the gross, employer costs on top.';
comment on column public.attendance_settings.payroll_basic_pct is
  'R-2700: Basic as % of the monthly salary a CTC gives (10..100) — the CTC calculator''s default.';
