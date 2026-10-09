-- deploy-key: employeepinhidden
-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'pin_set')
-- 20261010010000_employee_pin_hidden.sql
--
-- R-607 part 2 (attendance security, 9 Oct 2026).
--
-- employees.pin_hash — the bcrypt hash of every employee's 4–6 digit kiosk / expense-claim
-- PIN — was readable by every member: useEmployees() selects `*`, so the Payroll screen
-- shipped every colleague's hash to every browser that opened it. A 4-digit PIN is 10,000
-- guesses; bcrypt slows that to minutes, not years. With the PIN, /api/attendance/mark
-- checks a colleague in (R-607 part 1 limits ONLINE guesses; an offline crack makes no
-- wrong guesses at all).
--
-- The screens only ever needed "is a PIN set?". So:
--   • pin_set — a generated boolean, readable;
--   • SELECT on pin_hash is withdrawn from `authenticated` (column grants: a table-level
--     SELECT would override a column revoke, so the table grant goes and every OTHER column
--     is granted back, listed from the catalog at apply time).
--   ⚠ A column ADDED to employees after this migration is NOT readable by members until
--     its own migration says `grant select (<col>) on public.employees to authenticated`.
--     That is the safe direction (a new column cannot leak by accident) — and the symptom
--     of forgetting is "permission denied for table employees" on the Payroll screen.
--   • anon loses SELECT too: the one public reader (expense-claim page) uses the server
--     client.
--   The SECURITY DEFINER PIN functions (mark_attendance, set_employee_pin, the claim
--   functions) read pin_hash as their owner and are unaffected. INSERT/UPDATE/DELETE grants
--   are untouched (writes are owner/manager/accountant by RLS, role_hardening).

begin;

alter table public.employees
  add column if not exists pin_set boolean generated always as (pin_hash is not null) stored;

revoke select on table public.employees from authenticated, anon;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'employees' and column_name <> 'pin_hash';
  execute format('grant select (%s) on public.employees to authenticated', cols);
end $$;

grant all on table public.employees to service_role;

commit;
