-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'last_followup_at')
-- deploy-key: r2928taskfollowup
-- R-2928: "Remind" on a teammate's task. The task remembers when its owner was last reminded
-- and how many times, so the row can say "Last reminded 18 Nov, 4:10 pm" and the server can
-- allow one reminder per task per hour (lib/tasks/remind-notice.server.ts stamps both columns
-- with a compare-and-set before it sends the bell notice + email). Safe to re-run.
alter table public.tasks
  add column if not exists last_followup_at timestamptz,
  add column if not exists followup_count integer not null default 0;

comment on column public.tasks.last_followup_at is
  'R-2928: when the owner of this task was last reminded (Remind button). NULL = never.';
comment on column public.tasks.followup_count is
  'R-2928: how many reminders were sent for this task.';
