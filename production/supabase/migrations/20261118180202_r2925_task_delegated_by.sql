-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'delegated_at')
-- deploy-key: r2925taskdelegatedby
-- R-2925: assigning a task to a teammate now records who handed it over and when.
-- The two columns were first written in 20260821090000_performance_points.sql, a file from
-- before the deploy ledger; this makes sure they exist on every database. Safe to re-run.
alter table public.tasks
  add column if not exists delegated_by uuid references public.users(id) on delete set null,
  add column if not exists delegated_at timestamptz;

comment on column public.tasks.delegated_by is
  'Who reassigned this task to its current owner_id. NULL = never delegated.';
