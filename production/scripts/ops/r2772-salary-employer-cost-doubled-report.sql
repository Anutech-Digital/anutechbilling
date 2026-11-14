-- R-2772 — READ-ONLY report: employer PF / ESI cost booked more than once for one salary (14 Nov 2026).
--
-- WHY: until R-2772 (migration 20261114083830) "Undo salary" — and so every "Edit salary", which is
-- Undo + Pay — deleted the salary and its Salaries expense but LEFT the "PF — Employer" /
-- "ESI — Employer" expense rows that pay_salary had booked. Paying the month again booked them a
-- second time; an Undo with no re-pay left the cost in a month that has no salary. The P&L shows
-- that extra cost; the PF / ESI payable on the Balance Sheet does not (it is read from the salary
-- rows), so the two disagree by the same rupees. This report lists the damage so far. Removing a
-- leftover row is a data repair — Pardeep's decision, never automatic.
--
-- HOW A ROW IS RECOGNISED: pay_salary writes these rows with payment_method 'statutory', the
-- category, the employee's name as vendor_name and the description
-- "PF employer contribution <YYYY-MM> — <name>" / "ESI employer contribution <YYYY-MM> — <name>".
-- "Expected" = the pf_employer / esi_employer figure on that employee's salary row of that month
-- (0 when the month has no salary now); the employee is matched by the name on that salary's own
-- Salaries expense (written by the same pay_salary call), so a later rename does not confuse it. Extra = booked − expected.
--
-- WHAT IT IS: three SELECTs. It changes NOTHING — the whole file runs inside
-- `begin; set transaction read only; … rollback;`. It works on a database WITHOUT R-2772 (it does
-- not read the new link columns).
--
-- WHO RUNS IT: Pardeep (DB step) on staging / live; Claude only on the LOCAL DB:
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/ops/r2772-salary-employer-cost-doubled-report.sql
--
-- SECTIONS (0 rows in 1 and 2 = clean):
--   0 login check  — companies / statutory employer rows this login can see.
--   1 per company  — employee-months with extra employer cost, rows and rupees, split PF / ESI,
--                    and how many of them have no salary at all now (plain Undo).
--   2 per salary   — company, employee name, month, PF / ESI, rows booked, ₹ booked, ₹ expected,
--                    ₹ extra, salary booked now (yes / no), books locked (yes / no — a locked month
--                    needs the lock opened before any repair), the expense ids and their dates.
--                    Also lists a month where LESS is booked than the salary row says (extra < 0:
--                    an employer row was deleted on the Expenses page) — a different mistake, shown
--                    so nothing hides.

begin;
set transaction read only;

\pset footer on
\pset null '·'

\echo
\echo '=== 0. Login check: companies_visible should equal the number of companies ==='
select current_user                                                                              as login,
       (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                                                      as companies_visible,
       (select count(*) from public.salary_payments)                                              as salary_rows_visible,
       (select count(*) from public.expenses e
         where e.payment_method = 'statutory' and e.category in ('PF — Employer', 'ESI — Employer')) as employer_cost_rows_visible;

-- The work list (CTE r2772_employer_cost) is written out in sections 1 and 2: a read-only transaction
-- cannot create even a temporary table or view.

\echo
\echo '=== 1. Per company: employee-months where the employer PF / ESI cost is not what the salary says ==='
with booked as (
  select e.tenant_id,
         case e.category when 'PF — Employer' then 'PF' else 'ESI' end                as kind,
         e.vendor_name                                                                 as employee,
         substring(e.description from ' contribution ([0-9]{4}-[0-9]{2}) —')                as period,
         count(*)                                                                      as rows_booked,
         sum(e.amount)::bigint                                                         as booked,
         string_agg(e.id || ' (₹' || e.amount || ', ' || to_char(e.created_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ')',
                    ', ' order by e.created_at, e.id)                                  as expense_rows,
         max(e.expense_date)                                                           as expense_date
    from public.expenses e
   where e.payment_method = 'statutory'
     and e.category in ('PF — Employer', 'ESI — Employer')
     and e.description ~ '^(PF|ESI) employer contribution [0-9]{4}-[0-9]{2} —'
   group by 1, 2, 3, 4
),
expected as (
  select s.tenant_id, k.kind, coalesce(se.vendor_name, emp.name) as employee, s.period,
         sum(case k.kind when 'PF' then s.pf_employer else s.esi_employer end)::bigint as expected,
         count(*)                                                                       as salaries
    from public.salary_payments s
    join public.employees emp on emp.id = s.employee_id
    left join public.expenses se on se.id = s.expense_id and se.tenant_id = s.tenant_id
   cross join (values ('PF'), ('ESI')) k(kind)
   group by 1, 2, 3, 4
),
r2772_employer_cost as (
  select coalesce(b.tenant_id, x.tenant_id)   as tenant_id,
         coalesce(b.kind, x.kind)             as kind,
         coalesce(b.employee, x.employee)     as employee,
         coalesce(b.period, x.period)         as period,
         coalesce(b.rows_booked, 0)           as rows_booked,
         coalesce(b.booked, 0)                as booked,
         coalesce(x.expected, 0)              as expected,
         coalesce(b.booked, 0) - coalesce(x.expected, 0) as extra,
         coalesce(x.salaries, 0) > 0          as salary_booked_now,
         b.expense_rows,
         b.expense_date
    from booked b
    full join expected x
      on x.tenant_id = b.tenant_id and x.kind = b.kind and x.employee = b.employee and x.period = b.period
   where coalesce(b.booked, 0) <> coalesce(x.expected, 0)
      or coalesce(b.rows_booked, 0) > 1
)
select t.name                                                        as company,
       c.tenant_id,
       count(*) filter (where c.extra > 0)                           as salary_months_with_extra,
       count(*) filter (where c.extra > 0 and c.kind = 'PF')         as pf_cases,
       coalesce(sum(c.extra) filter (where c.extra > 0 and c.kind = 'PF'), 0)  as pf_extra_rupees,
       count(*) filter (where c.extra > 0 and c.kind = 'ESI')        as esi_cases,
       coalesce(sum(c.extra) filter (where c.extra > 0 and c.kind = 'ESI'), 0) as esi_extra_rupees,
       count(*) filter (where c.extra > 0 and not c.salary_booked_now) as of_them_no_salary_now,
       count(*) filter (where c.extra < 0)                           as months_with_less_than_salary_says
  from r2772_employer_cost c
  join public.tenants t on t.id = c.tenant_id
 group by t.name, c.tenant_id
 order by t.name;

\echo
\echo '=== 2. Per salary month: what is booked against what the salary row says ==='
with booked as (
  select e.tenant_id,
         case e.category when 'PF — Employer' then 'PF' else 'ESI' end                as kind,
         e.vendor_name                                                                 as employee,
         substring(e.description from ' contribution ([0-9]{4}-[0-9]{2}) —')                as period,
         count(*)                                                                      as rows_booked,
         sum(e.amount)::bigint                                                         as booked,
         string_agg(e.id || ' (₹' || e.amount || ', ' || to_char(e.created_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ')',
                    ', ' order by e.created_at, e.id)                                  as expense_rows,
         max(e.expense_date)                                                           as expense_date
    from public.expenses e
   where e.payment_method = 'statutory'
     and e.category in ('PF — Employer', 'ESI — Employer')
     and e.description ~ '^(PF|ESI) employer contribution [0-9]{4}-[0-9]{2} —'
   group by 1, 2, 3, 4
),
expected as (
  select s.tenant_id, k.kind, coalesce(se.vendor_name, emp.name) as employee, s.period,
         sum(case k.kind when 'PF' then s.pf_employer else s.esi_employer end)::bigint as expected,
         count(*)                                                                       as salaries
    from public.salary_payments s
    join public.employees emp on emp.id = s.employee_id
    left join public.expenses se on se.id = s.expense_id and se.tenant_id = s.tenant_id
   cross join (values ('PF'), ('ESI')) k(kind)
   group by 1, 2, 3, 4
),
r2772_employer_cost as (
  select coalesce(b.tenant_id, x.tenant_id)   as tenant_id,
         coalesce(b.kind, x.kind)             as kind,
         coalesce(b.employee, x.employee)     as employee,
         coalesce(b.period, x.period)         as period,
         coalesce(b.rows_booked, 0)           as rows_booked,
         coalesce(b.booked, 0)                as booked,
         coalesce(x.expected, 0)              as expected,
         coalesce(b.booked, 0) - coalesce(x.expected, 0) as extra,
         coalesce(x.salaries, 0) > 0          as salary_booked_now,
         b.expense_rows,
         b.expense_date
    from booked b
    full join expected x
      on x.tenant_id = b.tenant_id and x.kind = b.kind and x.employee = b.employee and x.period = b.period
   where coalesce(b.booked, 0) <> coalesce(x.expected, 0)
      or coalesce(b.rows_booked, 0) > 1
)
select t.name                                                        as company,
       c.employee,
       c.period                                                      as salary_month,
       c.kind,
       c.rows_booked,
       c.booked                                                      as booked_rupees,
       c.expected                                                    as salary_says_rupees,
       c.extra                                                       as extra_rupees,
       case when c.salary_booked_now then 'yes' else 'no' end        as salary_booked_now,
       case when t.books_locked_until is not null and c.expense_date <= t.books_locked_until then 'yes' else 'no' end as books_locked,
       c.expense_rows
  from r2772_employer_cost c
  join public.tenants t on t.id = c.tenant_id
 order by t.name, c.period, c.employee, c.kind;

rollback;
