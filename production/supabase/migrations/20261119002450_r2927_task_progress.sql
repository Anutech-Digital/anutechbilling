-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'progress')
-- deploy-key: r2927taskprogress
-- R-2927: an open task can be marked "In progress" or "On hold" from its row.
--
-- This is a STEP of an open task (tasks.progress), deliberately NOT two new values of the
-- task_status enum: about thirty functions decide "is this task still open?" with
-- status in ('pending', 'snoozed') — nav_badges (the Overdue badge), today_inbox, and the payment /
-- renewal / grace functions that finish or remove their own auto tasks. With new enum values each
-- of those would have to be rewritten (several are money functions) or an in-progress task would
-- silently drop out of the counts and never be auto-closed. With a step column status stays
-- 'pending', so every count and every auto-close keeps working unchanged.
alter table public.tasks
  add column if not exists progress text not null default 'not_started';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_progress_check' and conrelid = to_regclass('public.tasks')) then
    alter table public.tasks
      add constraint tasks_progress_check check (progress in ('not_started', 'in_progress', 'on_hold'));
  end if;
end $$;

comment on column public.tasks.progress is
  'R-2927: step of an OPEN task — not_started / in_progress / on_hold. status stays pending; done / cancelled tasks keep their last step.';
