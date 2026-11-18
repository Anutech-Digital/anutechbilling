-- deploy-peek: to_regclass('public.task_digest_log') is not null
-- deploy-key: r2929taskdigestlog
-- 20261118165943_r2929_task_digest_log
--
-- R-2929 (18 Nov 2026, Pardeep — task-management video audit): the morning task digest
-- (/api/cron/task-digest) sends each person ONE list of their overdue + today's tasks a day, and
-- the owner ONE team summary.
--
-- This table is what makes "one a day" true. The cron claims a row BEFORE it sends; the unique
-- index on (tenant_id, user_id, digest_date, kind) makes a Scheduler retry, a "Run now" after the morning
-- run, or two overlapping instances fail here instead of mailing the person twice. tenant_id is in the
-- key because one login can belong to several companies (R-2471) and gets each company's own
-- digest. When nothing went out the cron deletes its claim so a Retry can send; a row whose run
-- died between claim and send stays (one missed digest, never two).
--
-- Service role only: RLS is on and the only policy is the service role's. No browser session
-- reads or writes it — it is bookkeeping about notifications.
begin;

create table if not exists public.task_digest_log (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  user_id              uuid not null references public.users(id) on delete cascade,
  -- The IST calendar day the digest was for, not the instant it ran.
  digest_date          date not null,
  kind                 text not null check (kind in ('personal', 'owner_summary')),
  overdue_count        integer not null default 0,
  today_count          integer not null default 0,
  claimed_at           timestamptz not null default now(),
  -- Null = the slot was claimed and nothing went out.
  sent_at              timestamptz,
  email_status         text check (email_status in ('sent', 'stubbed', 'failed')),
  whatsapp_status      text check (whatsapp_status in ('sent', 'failed', 'skipped')),
  whatsapp_skip_reason text,
  error                text
);

-- The guarantee.
create unique index if not exists task_digest_log_once
  on public.task_digest_log (tenant_id, user_id, digest_date, kind);

alter table public.task_digest_log enable row level security;
drop policy if exists zzz_service_role_all on public.task_digest_log;
create policy zzz_service_role_all on public.task_digest_log for all to service_role using (true) with check (true);
revoke all on public.task_digest_log from public, anon, authenticated;
grant select, insert, update, delete on public.task_digest_log to service_role;

comment on table public.task_digest_log is
  'R-2929: one row per company per person per IST day per kind (personal / owner_summary) of the morning task digest. The unique index makes a repeated cron run harmless. Service role only.';

commit;
