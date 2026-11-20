-- deploy-peek: to_regprocedure('public.task_collaborators_guard()') is not null and to_regprocedure('public.tasks_followup_guard()') is not null and exists(select 1 from pg_trigger t where t.tgname = 'trg_task_collaborators_guard' and t.tgrelid = to_regclass('public.task_collaborators') and t.tgenabled <> 'D') and exists(select 1 from pg_trigger t where t.tgname = 'trg_tasks_followup_guard' and t.tgrelid = to_regclass('public.tasks') and t.tgenabled <> 'D') and exists(select 1 from pg_class c where c.oid = to_regclass('public.task_collaborators') and c.relrowsecurity) and exists(select 1 from pg_constraint k where k.conname = 'tasks_link_url_check' and k.conrelid = to_regclass('public.tasks')) and not coalesce(has_table_privilege('anon', to_regclass('public.task_collaborators'), 'select, insert, update, delete'), true)
-- deploy-key: r2941taskguards
-- R-2941: database guards for "Working with" (R-2933) and the Remind button (R-2928), from the
-- independent review of those two cards. Until now these rules lived only in the route and the
-- screen; a signed-in user writing to the table directly went around them.
--
-- 1. public.task_collaborators_guard() — BEFORE INSERT OR UPDATE on task_collaborators, every
--    writer (also the server):
--      a. the task AND the person must belong to the row's company. One message for "other
--         company" and "does not exist", for the task and for the person, raised before the
--         foreign keys are checked — so the answer no longer tells whether a uuid exists in
--         someone else's company. For an app session the row's tenant_id must be the caller's
--         own company, said before anything is looked up.
--      b. at most 3 people per task. The task row is locked (FOR NO KEY UPDATE) before the
--         count, so two requests at the same moment go one after the other and the second one
--         counts the first one's row.
-- 2. public.tasks_followup_guard() — BEFORE INSERT OR UPDATE on tasks: tasks.last_followup_at
--    and followup_count change only on the server path (POST /api/tasks/remind →
--    lib/tasks/remind-notice.server.ts, which writes them with the service client). An app
--    session that changes either is refused; a task created by an app session starts as
--    "never reminded" whatever it sent.
--
-- Who is "an app session": public.current_request_role() in ('anon', 'authenticated') — the
-- same test as tg_salary_payments_tds_lock (R-2812). On Cloud SQL that comes from the database
-- LOGIN (session_user app_runtime / app_anon), on Supabase from the verified token's role;
-- neither is a setting a signed-in user can change. service_role, app_jobs and a direct
-- database session (migrations, repairs) are the server path.
--
-- 3. Re-states what 20261119205800 (R-2933) set and its deploy-peek did not prove — RLS on
--    task_collaborators, no rights for anon / PUBLIC, the http(s)-only link check — so this
--    file's peek proves all of it. No data is changed. Safe to re-run.
-- Test: supabase/tests/r2941_task_guards.test.sql (rolled back).

-- ── 1. task_collaborators: same company, at most 3 ──────────────────────────────────
create or replace function public.task_collaborators_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_task_tenant uuid;
  v_user_tenant uuid;
  v_others      integer;
begin
  if coalesce(public.current_request_role(), '') in ('anon', 'authenticated')
     and NEW.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'R-2941: the people working on a task can be changed only in your own company'
      using errcode = '42501';
  end if;

  -- Lock the task first: a second writer for the same task waits here, then counts our row.
  select t.tenant_id into v_task_tenant from public.tasks t where t.id = NEW.task_id for no key update;
  select u.tenant_id into v_user_tenant from public.users u where u.id = NEW.user_id;
  if v_task_tenant is distinct from NEW.tenant_id or v_user_tenant is distinct from NEW.tenant_id then
    raise exception 'R-2941: this task or this person is not in this company'
      using errcode = '23514';
  end if;

  -- The same person again is the unique rule's answer (task_collaborators_uniq), not the limit's.
  select count(*) into v_others
    from public.task_collaborators c
   where c.task_id = NEW.task_id
     and c.user_id <> NEW.user_id
     and (TG_OP = 'INSERT' or c.id <> NEW.id);
  if v_others >= 3 then
    raise exception 'R-2941: a task can have up to 3 people working with its owner — remove one to add another'
      using errcode = '23514';
  end if;
  return NEW;
end
$function$;

comment on function public.task_collaborators_guard() is
  'R-2941: task and person must be in the row''s company (one message, no existence oracle); at most 3 people per task, counted under a lock on the task row.';

revoke all on function public.task_collaborators_guard() from public, anon, authenticated;

drop trigger if exists trg_task_collaborators_guard on public.task_collaborators;
create trigger trg_task_collaborators_guard
  before insert or update on public.task_collaborators
  for each row execute function public.task_collaborators_guard();

-- ── 2. tasks: the two Remind columns belong to the server ───────────────────────────
create or replace function public.tasks_followup_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(public.current_request_role(), '') not in ('anon', 'authenticated') then
    return NEW;
  end if;
  if TG_OP = 'INSERT' then
    -- A new task has never been reminded, whatever the request sent.
    NEW.last_followup_at := null;
    NEW.followup_count   := 0;
    return NEW;
  end if;
  if NEW.last_followup_at is distinct from OLD.last_followup_at
     or NEW.followup_count is distinct from OLD.followup_count then
    raise exception 'R-2941: only the Remind button changes when a task was last reminded'
      using errcode = '42501';
  end if;
  return NEW;
end
$function$;

comment on function public.tasks_followup_guard() is
  'R-2941: tasks.last_followup_at / followup_count change only on the server path (POST /api/tasks/remind); an app session is refused, and a task it creates starts as never reminded.';

revoke all on function public.tasks_followup_guard() from public, anon, authenticated;

drop trigger if exists trg_tasks_followup_guard on public.tasks;
create trigger trg_tasks_followup_guard
  before insert or update on public.tasks
  for each row execute function public.tasks_followup_guard();

-- ── 3. what R-2933 set, stated again so this file's peek proves it ──────────────────
alter table public.task_collaborators enable row level security;
revoke all on public.task_collaborators from public, anon;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_link_url_check' and conrelid = to_regclass('public.tasks')) then
    alter table public.tasks
      add constraint tasks_link_url_check check (link_url is null or (length(link_url) <= 2000 and link_url ~* '^https?://[^[:space:]]+$'));
  end if;
end $$;
