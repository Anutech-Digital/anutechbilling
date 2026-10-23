-- deploy-peek: (to_regclass('public.cold_call_campaigns') is not null and to_regclass('public.cold_call_contacts') is not null)
-- deploy-key: r1661coldcall
-- prisma/migrations/20261019070000_r1661_cold_calling
-- R-1661 (Abhishek, 19 Oct 2026): Marketing Hub → Cold Calling. A calling list imported from
-- a spreadsheet, called by the AI voice agent (Bolna) on a schedule; an interested contact is
-- moved into leads only when a person presses the button.
--
--   cold_call_campaigns  one list + the agent that calls it + how many calls a day
--   cold_call_contacts   one row per number; the call's outcome lands on the same row
--
-- The list is NOT leads on purpose: a cold list is mostly people who will never buy, and
-- putting it in leads would bury the real pipeline.
--
-- Who: owner, manager, sales_senior and sales (Abhishek's decision). Every policy reads the
-- tenant from current_tenant_id(), so app_runtime (withTenant) and app_jobs (withJobsTenant)
-- see only their own tenant. The cron runner (app_jobs) has no user, so it is let through by
-- current_request_role() = 'app_jobs' — still only for the tenant withJobsTenant set.
-- Cloud SQL has no BYPASSRLS, so service_role gets its own policy.
begin;

create table if not exists public.cold_call_campaigns (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  name          text        not null check (length(btrim(name)) between 1 and 120),
  agent_id      text        not null check (length(agent_id) between 1 and 100),
  agent_name    text,
  status        text        not null default 'draft'
                check (status in ('draft', 'running', 'paused', 'done')),
  -- Calls per IST day. 50 by default: about 80 minutes at ~$0.06/min on a trial balance.
  daily_limit   integer     not null default 50 check (daily_limit between 1 and 1000),
  -- IST hours the calls may be placed in, Monday–Friday only (the runner adds the weekday).
  window_start  smallint    not null default 10 check (window_start between 0 and 23),
  window_end    smallint    not null default 18 check (window_end between 1 and 24),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (window_end > window_start)
);

create index if not exists cold_call_campaigns_tenant_idx
  on public.cold_call_campaigns (tenant_id, created_at desc);

create table if not exists public.cold_call_contacts (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  campaign_id      uuid        not null references public.cold_call_campaigns(id) on delete cascade,
  name             text,
  company          text,
  city             text,
  -- E.164, normalised on import. Kept even for DND rows so the list shows what was skipped.
  phone            text        not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  dnd              boolean     not null default false,
  status           text        not null default 'pending'
                   check (status in ('pending', 'calling', 'answered', 'interested', 'callback',
                                     'not_interested', 'no_answer', 'failed', 'skipped_dnd', 'moved')),
  attempts         integer     not null default 0 check (attempts >= 0),
  last_called_at   timestamptz,
  next_attempt_at  timestamptz,
  provider_call_id text,
  call_status      text,
  duration_sec     integer,
  transcript       text,
  summary          text,
  seats_heard      integer,
  extracted        jsonb       not null default '{}'::jsonb,
  error            text,
  lead_id          text,
  moved_at         timestamptz,
  moved_by         uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (campaign_id, phone)
);

create index if not exists cold_call_contacts_campaign_status_idx
  on public.cold_call_contacts (tenant_id, campaign_id, status);
create index if not exists cold_call_contacts_provider_call_idx
  on public.cold_call_contacts (provider_call_id) where provider_call_id is not null;

alter table public.cold_call_campaigns enable row level security;
alter table public.cold_call_contacts  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cold_call_campaigns', 'cold_call_contacts'] loop
    execute format('drop policy if exists cold_call_team on public.%I', t);
    execute format(
      'create policy cold_call_team on public.%I for all to authenticated
         using (tenant_id = public.current_tenant_id()
                and (public.current_user_has_role(''owner'', ''manager'', ''sales_senior'', ''sales'')
                     or public.current_request_role() = ''app_jobs''))
         with check (tenant_id = public.current_tenant_id()
                and (public.current_user_has_role(''owner'', ''manager'', ''sales_senior'', ''sales'')
                     or public.current_request_role() = ''app_jobs''))', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format(
      'create policy zzz_service_role_all on public.%I as permissive for all to service_role
         using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;

commit;
