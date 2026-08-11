-- 0199 — Birthday / anniversary greeting log.
--
-- The birthday-greetings cron (api/cron/birthday-greetings) runs nightly and
-- emails a wish to every contact whose birthday/anniversary is TODAY. This log
-- makes that idempotent: one (contact, kind, channel, year) can only be greeted
-- once — the cron claims a row first (unique constraint) and only sends if the
-- claim was fresh, so re-runs / retries never double-send. On send-failure the
-- claim is deleted so a later run can retry within the same day.

create table if not exists public.contact_greeting_log (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id)  on delete cascade,
  contact_id    text not null references public.contacts(id) on delete cascade,
  kind          text not null check (kind in ('birthday','anniversary')),
  channel       text not null default 'email' check (channel in ('email')),
  greeting_year int  not null,
  recipient     text,
  subject       text,
  status        text not null,          -- sent | stubbed | failed | skipped
  provider_id   text,
  error_message text,
  sent_at       timestamptz not null default now(),
  unique (tenant_id, contact_id, kind, channel, greeting_year)
);

create index if not exists contact_greeting_log_tenant_idx
  on public.contact_greeting_log (tenant_id, sent_at desc);

alter table public.contact_greeting_log enable row level security;

-- Read-only for the owning tenant (audit visibility). All writes happen through
-- the service-role cron, which bypasses RLS.
drop policy if exists contact_greeting_log_select on public.contact_greeting_log;
create policy contact_greeting_log_select on public.contact_greeting_log
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));
