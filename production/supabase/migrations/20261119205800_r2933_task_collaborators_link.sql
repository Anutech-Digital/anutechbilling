-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'link_url') and to_regclass('public.task_collaborators') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'task_collaborators' and policyname = 'task_collaborators_insert')
-- deploy-key: r2933taskcollaboratorslink
-- R-2933: up to 3 teammates can work on a task WITH its owner, and a task can carry a web link.
--
-- 1. tasks.link_url — the task's link (Drive file, document, page). Only http(s) is accepted,
--    because the task row opens it.
-- 2. public.task_collaborators — first written in 20260821090000_performance_points.sql, a file
--    from before the deploy ledger (it is not in the deploy peeks), so a database may not have
--    it. This makes sure the table, its indexes, RLS, policies and grants exist everywhere.
--    Same shape and same policies as that file. Safe to re-run.
--
-- The limit of 3 is applied by the one writer, POST /api/tasks/collaborators
-- (lib/tasks/collaborators.server.ts), which also tells the people it adds.
begin;

alter table public.tasks
  add column if not exists link_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_link_url_check' and conrelid = to_regclass('public.tasks')) then
    alter table public.tasks
      add constraint tasks_link_url_check check (link_url is null or (length(link_url) <= 2000 and link_url ~* '^https?://[^[:space:]]+$'));
  end if;
end $$;

comment on column public.tasks.link_url is
  'R-2933: a web link for the task (Drive file, document, page). http(s) only. NULL = none.';

create table if not exists public.task_collaborators (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  task_id    uuid not null references public.tasks(id)   on delete cascade,
  user_id    uuid not null references public.users(id)   on delete cascade,
  added_by   uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint task_collaborators_uniq unique (task_id, user_id)
);

create index if not exists task_collaborators_task_idx on public.task_collaborators (task_id);
create index if not exists task_collaborators_user_idx on public.task_collaborators (tenant_id, user_id);

alter table public.task_collaborators enable row level security;

drop policy if exists "task_collaborators_select" on public.task_collaborators;
create policy "task_collaborators_select" on public.task_collaborators
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "task_collaborators_insert" on public.task_collaborators;
create policy "task_collaborators_insert" on public.task_collaborators
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "task_collaborators_delete" on public.task_collaborators;
create policy "task_collaborators_delete" on public.task_collaborators
  for delete to authenticated using (tenant_id = public.current_tenant_id());

revoke all on public.task_collaborators from public, anon;
grant select, insert, delete on public.task_collaborators to authenticated;
grant select, insert, update, delete on public.task_collaborators to service_role;

comment on table public.task_collaborators is
  'R-2933: teammates working on a task WITH its owner (up to 3, applied by POST /api/tasks/collaborators). One row per task per person.';

commit;
