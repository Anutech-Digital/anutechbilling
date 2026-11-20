-- deploy-peek: to_regprocedure('public.task_collaborators_guard()') is not null and to_regprocedure('public.tasks_followup_guard()') is not null and exists(select 1 from pg_trigger t where t.tgname = 'trg_task_collaborators_guard' and t.tgrelid = to_regclass('public.task_collaborators') and t.tgenabled <> 'D') and exists(select 1 from pg_trigger t where t.tgname = 'trg_tasks_followup_guard' and t.tgrelid = to_regclass('public.tasks') and t.tgenabled <> 'D') and exists(select 1 from pg_class c where c.oid = to_regclass('public.task_collaborators') and c.relrowsecurity)
-- deploy-key: r2941taskguards
-- R-2941: database guards for "Working with" (R-2933) and the Remind button (R-2928), from the
-- independent review of those two cards. Until now these rules lived only in the route and the
-- screen; a signed-in user writing to the table directly went around them.
--
-- 1. public.task_collaborators_guard() — BEFORE INSERT, and UPDATE of tenant_id / task_id /
--    user_id, on task_collaborators. For EVERY writer (also the server):
--      a. the task must belong to the row's company and the person must be an active member of
--         it. One message and one SQLSTATE (23503) for "another company" and "does not exist",
--         for the task and for the person, raised BEFORE the foreign keys are checked — so the
--         answer no longer tells whether a uuid exists in someone else's company. (A signed-in
--         user's lookups run under their own row-level security: another company's task or
--         person simply is not there for them.)
--      b. at most 3 people per task (SQLSTATE 23514). The task row is locked (FOR NO KEY
--         UPDATE) before the count, so two requests at the same moment go one after the other
--         and the second one counts the first one's row.
--    Not on other updates: the foreign key's own "added_by → NULL" when a user is deleted must
--    never be refused by this guard.
-- 2. public.tasks_followup_guard() — BEFORE INSERT, and UPDATE of last_followup_at /
--    followup_count, on tasks: the two Remind columns change only on the server path
--    (POST /api/tasks/remind → lib/tasks/remind-notice.server.ts, which writes them with the
--    service client). A direct request login that changes either is refused (42501); a task it
--    creates starts as "never reminded" whatever it sent.
--
-- Who is "a direct request login": public.is_direct_request_login() (R-2485) — the ONE list
-- every trigger guard asks: authenticated / anon / authenticator (Supabase) and app_runtime /
-- app_anon / app_jobs (the Cloud SQL logins). It reads current_user, which a signed-in user
-- cannot change, so both functions are SECURITY INVOKER. The server path is what is left:
-- service_role / app_service (the admin client), SECURITY DEFINER RPC bodies, the migration owner.
--
-- 3. RLS on task_collaborators is switched on again (it already is — R-2933; that file's
--    deploy-peek did not prove it, this one does). No data is changed. Safe to re-run.
-- Tests: supabase/tests/r2941_task_guards.test.sql (rolled back);
--        node scripts/dev/r2941-concurrency-check.mjs (two real sessions, local scratch database).
begin;

-- ── 1. task_collaborators: same company, at most 3 ──────────────────────────────────
create or replace function public.task_collaborators_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_task_tenant uuid;
  v_user_tenant uuid;
  v_others      integer;
begin
  -- R-2941. Read first, lock after: a row that is refused never holds a lock on a task.
  select t.tenant_id into v_task_tenant from public.tasks t where t.id = NEW.task_id;
  select u.tenant_id into v_user_tenant from public.users u where u.id = NEW.user_id and u.is_active is not false;
  if v_task_tenant is distinct from NEW.tenant_id or v_user_tenant is distinct from NEW.tenant_id then
    raise exception 'R-2941: this task or this person is not in this company'
      using errcode = '23503';
  end if;

  -- A second writer for the same task waits here, then counts our row.
  perform 1 from public.tasks t where t.id = NEW.task_id for no key update;

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
  'R-2941: the task must be in the row''s company and the person an active member of it (one message, 23503 — no existence oracle); at most 3 people per task (23514), counted under a lock on the task row.';

revoke all on function public.task_collaborators_guard() from public, anon, authenticated;

drop trigger if exists trg_task_collaborators_guard on public.task_collaborators;
create trigger trg_task_collaborators_guard
  before insert or update of tenant_id, task_id, user_id on public.task_collaborators
  for each row execute function public.task_collaborators_guard();

-- ── 2. tasks: the two Remind columns belong to the server ───────────────────────────
create or replace function public.tasks_followup_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  -- R-2941: one list of request logins (R-2485); everyone else is the server path.
  if not public.is_direct_request_login() then
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
  'R-2941: tasks.last_followup_at / followup_count change only on the server path (POST /api/tasks/remind); a direct request login is refused, and a task it creates starts as never reminded.';

revoke all on function public.tasks_followup_guard() from public, anon, authenticated;

drop trigger if exists trg_tasks_followup_guard on public.tasks;
create trigger trg_tasks_followup_guard
  before insert or update of last_followup_at, followup_count on public.tasks
  for each row execute function public.tasks_followup_guard();

-- ── 3. RLS stays on (already on since R-2933; stated so this file's peek proves it) ──
alter table public.task_collaborators enable row level security;

commit;
