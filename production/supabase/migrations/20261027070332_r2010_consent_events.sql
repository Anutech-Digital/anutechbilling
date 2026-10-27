-- deploy-peek: to_regclass('public.consent_events') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'consent_events' and policyname = 'r2010_owner_reads')
-- deploy-key: r2010consentevents
-- 20261027070332_r2010_consent_events.sql
--
-- R-2010 (27 Oct 2026, goal G-DPDP). DPDP Act 2023 / Rules 2025: a Data Fiduciary must be able
-- to show a visitor's consent — which notice, which purpose, when, and that it was withdrawn.
-- Until now the website's cookie choice lived ONLY in the visitor's browser (localStorage
-- "anutech.consent.v1"); nothing on our side recorded it.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   consent_events   one row per choice: the cookie banner ("banner": the visitor pressed
--                    Accept all / Only necessary, or changed it in Cookie settings) and one at
--                    checkout ("checkout": ties the browser's anon id to the lead + quote with
--                    the choice in force when they bought).
--                    purpose 'meta_ads' = "Advertising measurement (Meta)"; choice granted /
--                    denied (a later 'denied' after 'granted' for the same anon_id = withdrawn).
--                    The IP is never stored — only an HMAC (ip_hash, 64 hex) made by the app.
--
-- ─── WHO ────────────────────────────────────────────────────────────────────
--   Written only by the server (service_role: POST /api/public/consent, checkout route).
--   INSERT-ONLY: no update / delete grant to anyone, and an update trigger refuses changes.
--   Read: the tenant's OWNER only (RLS current_tenant_id() + current_user_has_role('owner')).
--   anon gets nothing — the browser never talks to this table directly.
--
-- No functions callable by users, no existing data changed.
-- Test: supabase/tests/r2010_consent_events.test.sql

begin;

create table if not exists public.consent_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  anon_id         uuid,
  lead_id         text,
  quote_id        text,
  purpose         text not null check (purpose in ('meta_ads')),
  choice          text not null check (choice in ('granted', 'denied')),
  notice_version  text not null check (char_length(notice_version) between 1 and 40),
  source          text not null default 'banner' check (source in ('banner', 'checkout')),
  page            text check (page is null or char_length(page) <= 200),
  ip_hash         text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent      text check (user_agent is null or char_length(user_agent) <= 400),
  created_at      timestamptz not null default now(),
  constraint consent_events_who check (anon_id is not null or lead_id is not null)
);

comment on table public.consent_events is
  'R-2010 (DPDP): insert-only record of website cookie consent (banner / checkout). IP only as an HMAC. Owner reads.';

create index if not exists consent_events_tenant_time_idx on public.consent_events (tenant_id, created_at desc);
create index if not exists consent_events_anon_idx on public.consent_events (tenant_id, anon_id, created_at desc);
create index if not exists consent_events_lead_idx on public.consent_events (tenant_id, lead_id) where lead_id is not null;

-- Insert-only, even for a role that someday gets an update grant by mistake.
create or replace function public.consent_events_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'consent_events is insert-only (R-2010): a consent record is never changed — add a new row'
    using errcode = '42501';
end;
$$;
revoke all on function public.consent_events_no_update() from public, anon, authenticated;

drop trigger if exists trg_consent_events_no_update on public.consent_events;
create trigger trg_consent_events_no_update before update on public.consent_events
  for each row execute function public.consent_events_no_update();

alter table public.consent_events enable row level security;

drop policy if exists r2010_owner_reads on public.consent_events;
create policy r2010_owner_reads on public.consent_events
  as permissive for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner')));

drop policy if exists zzz_service_role_reads on public.consent_events;
create policy zzz_service_role_reads on public.consent_events
  as permissive for select to service_role using (true);

drop policy if exists zzz_service_role_inserts on public.consent_events;
create policy zzz_service_role_inserts on public.consent_events
  as permissive for insert to service_role with check (true);

revoke all on public.consent_events from public, anon, authenticated, service_role;
grant select on public.consent_events to authenticated;
grant select, insert on public.consent_events to service_role;

commit;
