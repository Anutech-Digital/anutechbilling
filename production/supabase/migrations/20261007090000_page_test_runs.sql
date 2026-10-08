-- deploy-key: testruns
-- deploy-peek: (to_regclass('public.page_test_runs') is not null)
-- ============================================================================
-- R-352 (7 Oct 2026): page_test_runs — browser test results come back into the app
--
-- WHY
--   Pardeep ran AI Help's suggested tests in a browser (/deals, /online-orders), but "Check
--   this page" suggested the same tests again. The result only went to the work board; the app
--   never knew. Now the test session posts its result here (POST /api/agent/page-test-runs,
--   agent token), and AI Help reads the last run of the page: shows "Last tested … 5 ✓ 1 ✗"
--   and tells the model not to repeat tests that passed on the same build.
--
-- WHO MAY DO WHAT
--   read ........ owner, manager of the same tenant
--   write ....... nobody signed in; only the agent endpoint (service role)
--
-- SAFE TO SKIP
--   The app treats a missing table (42P01 / PGRST205) as "no previous runs" — AI Help works
--   as before until this migration is applied.
-- ============================================================================
begin;

create table if not exists public.page_test_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  page_path   text not null check (page_path ~ '^/' and length(page_path) <= 300),
  run_at      timestamptz not null default now(),
  build_sha   text not null check (length(build_sha) between 1 and 64),
  run_by      text not null default 'AI browser test' check (length(run_by) between 1 and 80),
  -- [{test, result: pass|fail|skipped, note, card}] — validated by the endpoint
  results     jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  created_at  timestamptz not null default now()
);
create index if not exists page_test_runs_tenant_page_idx
  on public.page_test_runs (tenant_id, page_path, run_at desc);

alter table public.page_test_runs enable row level security;

drop policy if exists page_test_runs_select on public.page_test_runs;
create policy page_test_runs_select on public.page_test_runs for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner', 'manager')));

drop policy if exists zzz_service_role_all on public.page_test_runs;
create policy zzz_service_role_all on public.page_test_runs as permissive for all to service_role using (true) with check (true);

-- Read-only for signed-in members; writes only through the service role (agent endpoint).
revoke all on public.page_test_runs from anon, authenticated;
grant select on public.page_test_runs to authenticated;
grant select, insert, update, delete on public.page_test_runs to service_role;

commit;
