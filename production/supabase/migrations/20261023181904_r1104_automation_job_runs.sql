-- deploy-peek: to_regclass('public.automation_job_runs') is not null and exists(select 1 from pg_policy where polname = 'automation_job_runs_select_owner_manager' and polrelid = to_regclass('public.automation_job_runs')) and exists(select 1 from pg_trigger where tgname = 'trg_automation_job_runs_keep')
-- deploy-key: r1104jobruns
-- 20261023181904_r1104_automation_job_runs.sql
--
-- R-1104 (23 Oct 2026, Pardeep): run history for the scheduled jobs on /automation.
--
-- ══ WHY ══════════════════════════════════════════════════════════════════════════
--   R-897 keeps ONE line per (company, job): last_run_at / last_result on automation_jobs.
--   A run overwrites the one before, so "it failed on Tuesday, did Wednesday's run fix it?"
--   had no answer, and a failed run could not be retried from the page.
--
-- ══ WHAT ═════════════════════════════════════════════════════════════════════════
--   automation_job_runs — one row per run of a job for a company:
--     status   ok | failed | skipped | practice
--     trigger  schedule (Cloud Scheduler) | manual ("Run now") | retry ("Retry" on a failed run)
--     result   the same short line as automation_jobs.last_result (cron-gate.ts summarise():
--              numbers from the job's answer; a practice run also names up to 3 recipients it
--              would have written to — readable by owner / manager only, like last_result)
--     started_by / retry_of  who pressed the button, and which failed run it retried.
--   Written ONLY by the server (service role, lib/automation/gate.server.ts recordRun) —
--   nobody signed in can insert or change a row, so the history cannot be edited.
--   RLS: owner and manager read their own company's rows (the /automation page); everyone
--   else reads nothing. Same rule as automation_jobs.
--   Kept small: the newest 50 runs per (company, job); older ones are removed on insert.
--
-- Test: supabase/tests/r1104_automation_job_runs.test.sql (rolled back).

begin;

create table if not exists public.automation_job_runs (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  job         text        not null check (job ~ '^[a-z0-9_-]{1,64}$'),
  ran_at      timestamptz not null default now(),
  status      text        not null check (status in ('ok', 'failed', 'skipped', 'practice')),
  trigger     text        not null default 'schedule' check (trigger in ('schedule', 'manual', 'retry')),
  result      text        check (result is null or length(result) <= 500),
  started_by  uuid        references public.users(id) on delete set null,
  retry_of    uuid        references public.automation_job_runs(id) on delete set null
);

comment on table public.automation_job_runs is
  'R-1104: one row per run of a scheduled job for a company (newest 50 per job kept). Server-written only.';

create index if not exists automation_job_runs_tenant_job_idx
  on public.automation_job_runs (tenant_id, job, ran_at desc);

alter table public.automation_job_runs enable row level security;

drop policy if exists automation_job_runs_select_owner_manager on public.automation_job_runs;
drop policy if exists zzz_service_role_all                     on public.automation_job_runs;

create policy automation_job_runs_select_owner_manager on public.automation_job_runs
  for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager'));

-- No insert / update / delete policy for signed-in users: the history is the server's record.
create policy zzz_service_role_all on public.automation_job_runs
  as permissive for all to service_role using (true) with check (true);

revoke all on public.automation_job_runs from anon, authenticated;
grant select on public.automation_job_runs to authenticated;
grant select, insert, update, delete on public.automation_job_runs to service_role;


-- ── Keep the newest 50 per (company, job) ──────────────────────────────────────────
create or replace function public.automation_job_runs_keep()
returns trigger
language plpgsql
security invoker            -- only the service role inserts here, and it may delete
set search_path = public
as $function$
begin
  /* R-1104: a job that runs every minute would otherwise grow without end. */
  delete from public.automation_job_runs r
   where r.tenant_id = new.tenant_id
     and r.job = new.job
     and r.id in (select x.id from public.automation_job_runs x
                   where x.tenant_id = new.tenant_id and x.job = new.job
                   order by x.ran_at desc, x.id desc
                   offset 50);
  return null;
end
$function$;

revoke all on function public.automation_job_runs_keep() from public, anon, authenticated;

drop trigger if exists trg_automation_job_runs_keep on public.automation_job_runs;
create trigger trg_automation_job_runs_keep
  after insert on public.automation_job_runs
  for each row execute function public.automation_job_runs_keep();

commit;
