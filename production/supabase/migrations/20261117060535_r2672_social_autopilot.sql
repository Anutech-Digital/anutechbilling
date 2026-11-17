-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content_settings' and column_name = 'autopilot') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'social_content_settings' and column_name = 'picture_urls')
-- deploy-key: r2672socialautopilot
-- R-2672 (G-SOCIAL): the weekly AI posts either wait for a person's Approve (autopilot = false,
-- as before) or go out by themselves at their planned time (autopilot = true — the owner chose it).
-- posts_per_week: how many posts the AI plans each week. picture_urls: public images the AI may
-- use in turn, so Instagram (which needs a picture) can be posted too.
begin;

alter table public.social_content_settings
  add column if not exists autopilot boolean not null default false,
  add column if not exists posts_per_week smallint not null default 3,
  add column if not exists picture_urls text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'social_content_settings_posts_per_week_check') then
    alter table public.social_content_settings add constraint social_content_settings_posts_per_week_check check (posts_per_week between 1 and 7);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'social_content_settings_picture_urls_check') then
    alter table public.social_content_settings add constraint social_content_settings_picture_urls_check check (cardinality(picture_urls) <= 30);
  end if;
end $$;

commit;
