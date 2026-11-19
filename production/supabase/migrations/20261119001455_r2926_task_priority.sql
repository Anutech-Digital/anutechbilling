-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'priority')
-- deploy-key: r2926taskpriority
-- R-2926: a task has a priority — Low / Medium / High. Every existing task, and every task
-- made by a function that does not name the column (team chat, lead follow-up, renewal and
-- credit auto tasks), is Medium.
alter table public.tasks
  add column if not exists priority text not null default 'medium';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_check' and conrelid = to_regclass('public.tasks')) then
    alter table public.tasks
      add constraint tasks_priority_check check (priority in ('low', 'medium', 'high'));
  end if;
end $$;

comment on column public.tasks.priority is
  'R-2926: low / medium / high. Shown as a coloured badge; High sorts first inside each group of the Tasks list.';
