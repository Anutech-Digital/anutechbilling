-- deploy-peek: to_regprocedure('public.current_request_role()') is not null and to_regprocedure('public.current_user_id()') is not null
-- deploy-key: r1901ctxhelpers
-- 20261025065946_r1901_request_context_helpers.sql
--
-- R-1901 (25 Oct 2026, staging train dry run): public.current_request_role() and
-- public.current_user_id() were created ONLY by the Prisma migrations
-- prisma/migrations/20261005120000_tenant_context and 20261005150000_gateway_logins.
-- Six supabase migrations of 24 Oct (r1863, r1866, r1864, r1867, r1877, r1891) call them
-- directly, so:
--   · CI "SQL tests" (built from supabase/migrations only) failed 10 files with
--     "function public.current_request_role() does not exist";
--   · the LIVE deploy-db script (supabase/cloudsql/live/deploy-db-2026-10-07.sh), which runs
--     supabase/migrations only, would have left those RPCs calling a missing function.
--
-- This file creates both helpers with the EXACT bodies of their latest definition
-- (prisma 20261005150000_gateway_logins), so a database that already has them (staging) gets
-- the same functions; the grant leaves out anon (see the grant below). Where no app_* login
-- is used (local Supabase, CI, PostgREST callers) they fall back to auth.uid() / auth.role(),
-- exactly as before.
--
-- STAGING NOTE: the staging deploy script rewrites auth.uid()/auth.role() into these helpers
-- before applying a file. That rewrite must never reach THIS file (it would make each helper
-- call itself). It cannot: the peek above is true on staging (the script refuses to run at all
-- unless both helpers exist — its `cuid` check), so this file is always "already on staging,
-- skipped" there.
--
-- Plain functions (not security definer), search_path = '' — same as the Prisma originals.
-- The plpgsql RPCs of the six files resolve these names at call time, not at create time, so
-- applying this file after them in the same run (file order) is enough.

create or replace function public.current_user_id() returns uuid
  language sql stable set search_path = ''
as $$
  select case
    when session_user in ('app_runtime', 'app_jobs')
      then nullif(current_setting('app.user_id', true), '')::uuid
    when session_user in ('app_service', 'app_anon') then null
    else auth.uid()
  end;
$$;

create or replace function public.current_request_role() returns text
  language sql stable set search_path = ''
as $$
  select case session_user
    when 'app_runtime' then 'authenticated'
    when 'app_jobs'    then 'app_jobs'
    when 'app_service' then 'service_role'
    when 'app_anon'    then 'anon'
    else auth.role()
  end;
$$;

-- Grants: authenticated + service_role only, NOT anon (R-013 guard,
-- src/lib/security/definer-hardening-holds.test.ts: no migration after 20260927100000 may hand
-- anon EXECUTE back). Every caller in the six 24 Oct files is a SECURITY DEFINER RPC, which runs
-- these as its owner, so anon never needs EXECUTE. Staging keeps the Prisma grant (incl. anon):
-- this file is skipped there, see the STAGING NOTE above.
grant execute on function public.current_user_id(), public.current_request_role()
  to authenticated, service_role;
