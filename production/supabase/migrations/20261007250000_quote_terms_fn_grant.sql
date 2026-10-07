-- deploy-key: termsgrant
-- deploy-peek: has_function_privilege('authenticated', 'public.quote_line_terms_mixed(jsonb)', 'execute')
-- ============================================================================
-- R-400 (7 Oct 2026) HOTFIX: every quote save on staging failed with
--   "permission denied for function quote_line_terms_mixed" (403, Abhishek's report).
--
-- R-381 (20261007160000_quote_one_billing_term.sql) added trigger
-- trg_quotes_one_billing_term → quotes_refuse_mixed_billing_term(), which calls the helper
-- quote_line_terms_mixed(jsonb). The migration granted nothing. Local Postgres gives new
-- functions EXECUTE to PUBLIC, so local and every test passed; Cloud SQL (staging/live) has
-- default privileges that revoke it, so the trigger — running as the caller — could not call
-- the helper and the whole INSERT/UPDATE on quotes was refused.
--
-- The helper is a pure function of the jsonb passed in (reads no table), so granting EXECUTE
-- to every role that writes quotes is safe. The trigger function itself is granted too, so
-- the same trap cannot recur if a caller ever invokes it directly.
-- ============================================================================

-- Not anon/public: nobody logged out writes quotes (definer-hardening-holds.test.ts keeps it so).
grant execute on function public.quote_line_terms_mixed(jsonb) to authenticated, service_role;
grant execute on function public.quotes_refuse_mixed_billing_term() to authenticated, service_role;

do $$
begin
  -- Staging runs R-161 (Prisma path) with these login roles; grant only where they exist.
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    execute 'grant execute on function public.quote_line_terms_mixed(jsonb) to app_runtime';
    execute 'grant execute on function public.quotes_refuse_mixed_billing_term() to app_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'app_jobs') then
    execute 'grant execute on function public.quote_line_terms_mixed(jsonb) to app_jobs';
    execute 'grant execute on function public.quotes_refuse_mixed_billing_term() to app_jobs';
  end if;
end $$;
