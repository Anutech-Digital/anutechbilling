-- deploy-peek: to_regprocedure('public.ist_today()') is not null and has_function_privilege('authenticated', 'public.ist_today()', 'execute') and has_function_privilege('authenticated', 'public.indian_fiscal_year(date)', 'execute') and has_function_privilege('authenticated', 'public.salary_expense_date(text,date)', 'execute')
-- deploy-key: r2389isttodaygrant
-- 20261102184319_r2389_ist_today_grant
--
-- R-2389 (p0, 2 Nov 2026). Staging (Cloud SQL, build bb2e01a): Banking → a ₹0 FD → Close account
-- → rpc/close_bank_account 403 "permission denied for function ist_today" (42501).
-- close_bank_account / reopen_bank_account (20261102134054_r2384) are SECURITY INVOKER and call
-- public.ist_today() as the signed-in user. ist_today() came in 20260930172000 with no GRANT;
-- local Supabase hands every new function to PUBLIC/authenticated by default, Cloud SQL does not
-- (R-401), and R-1559 (20261018220847) removed those defaults locally too for NEW functions — so
-- on staging nothing ever granted it. Localhost and CI passed because ist_today predates the
-- 20261001 cut-off the CI Cloud SQL emulation applies from.
--
-- The same hole, found by the R-2389 audit (every public function created in a migration from
-- 25 Sep onward that is invoker, not a trigger, and has no `grant … to authenticated`):
--   ist_today()                     — STABLE sql: (now() at time zone 'Asia/Kolkata')::date
--   indian_fiscal_year(date)        — STABLE sql: 'FY2627' label for a date (default ist_today())
--   salary_expense_date(text, date) — IMMUTABLE sql: the month-end / pay date for a salary period
-- All three are pure date helpers: SECURITY INVOKER, no table reads, no writes, no side effects —
-- granting EXECUTE exposes nothing. A function DEFAULT (`p_date date default public.ist_today()`,
-- R-1828/R-1830/R-1913) is evaluated with the CALLER's rights, so even SECURITY DEFINER RPCs called
-- without a date needed this grant. Today's other new functions (R-2360 … R-2387) are SECURITY
-- DEFINER or call only helpers that are granted (current_user_has_role 20261018173040,
-- current_tenant_id from the initial schema the Cloud SQL setup granted — every RLS policy uses it).
--
-- Test: supabase/tests/r2389_ist_today_grant.test.sql (revokes the grant like staging, proves the
-- close fails, re-grants, proves it works — rolled back). Repo scan:
-- src/lib/security/invoker-helper-grants-r2389.test.ts.
-- Rollback: revoke execute on function public.ist_today(), public.indian_fiscal_year(date),
--           public.salary_expense_date(text, date) from authenticated, service_role;

begin;

grant execute on function public.ist_today() to authenticated, service_role;
grant execute on function public.indian_fiscal_year(date) to authenticated, service_role;
grant execute on function public.salary_expense_date(text, date) to authenticated, service_role;

commit;
