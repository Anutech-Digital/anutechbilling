-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content' and column_name = 'scheduled_at') and to_regclass('public.social_content_due_idx') is not null
-- deploy-key: r2510socialschedule
-- R-2510 (G-SOCIAL): a post can carry the time it should go out. Only an APPROVED post whose
-- time has come is published by the social-publish cron; a draft or a post in review never is.
begin;

alter table public.social_content add column if not exists scheduled_at timestamptz;

create index if not exists social_content_due_idx
  on public.social_content (scheduled_at)
  where status = 'approved' and scheduled_at is not null;

comment on column public.social_content.scheduled_at is
  'R-2510: when the approved post should be published (UTC). Null = publish only by hand.';

commit;
