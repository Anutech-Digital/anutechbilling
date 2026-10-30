-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consent_events' and column_name = 'user_id') and exists(select 1 from pg_proc where proname = 'consent_events_no_update' and prosrc like '%GP-03%')
-- deploy-key: gp03consentaccount
-- 20261030021113_gp03_consent_account.sql
--
-- R-2113 / GP-03 (30 Oct 2026, goal G-PERSONAL). consent_events (R-2010) was built for the
-- website cookie banner: every row belonged to a tenant and an anon browser id / lead. A personal
-- account's DPDP consent (terms, processing of personal financial records, marketing) is given by
-- a USER at signup — before the workspace exists (password signup has no tenant until verify).
--
-- ─── WHAT CHANGES ──────────────────────────────────────────────────────────
--   tenant_id   nullable; FK now ON DELETE SET NULL (was CASCADE), so the proof survives the
--               tenant's erasure. Whether proof is finally kept or deleted with the ACCOUNT is
--               the owner's decision (card R-2113 needsDecision) — nothing here deletes it.
--   user_id     new uuid column (no FK: the proof must outlive the login too) + index.
--   who         a row needs anon_id OR lead_id OR user_id.
--   purpose     + account_terms, personal_finance_processing, marketing.
--   source      + signup, upgrade.
--
-- ─── STILL INSERT-ONLY ─────────────────────────────────────────────────────
--   The update trigger now allows exactly two changes, both to tenant_id alone:
--     1. NULL → a tenant, only for a user row (attachConsentTenant at the verify step);
--     2. a tenant → NULL, only when that tenant no longer exists (the FK's ON DELETE SET NULL).
--   Anything else (choice, purpose, version, user, moving to another tenant) is refused (42501).
--   service_role gets UPDATE on the tenant_id column only; no DELETE grant to anyone.
--
-- No existing row changes. Test: supabase/tests/gp03_consent_events.test.sql

begin;

alter table public.consent_events alter column tenant_id drop not null;

alter table public.consent_events drop constraint if exists consent_events_tenant_id_fkey;
alter table public.consent_events
  add constraint consent_events_tenant_id_fkey
  foreign key (tenant_id) references public.tenants (id) on delete set null;

alter table public.consent_events add column if not exists user_id uuid;

alter table public.consent_events drop constraint if exists consent_events_who;
alter table public.consent_events
  add constraint consent_events_who check (anon_id is not null or lead_id is not null or user_id is not null);

alter table public.consent_events drop constraint if exists consent_events_purpose_check;
alter table public.consent_events
  add constraint consent_events_purpose_check
  check (purpose in ('meta_ads', 'account_terms', 'personal_finance_processing', 'marketing'));

alter table public.consent_events drop constraint if exists consent_events_source_check;
alter table public.consent_events
  add constraint consent_events_source_check
  check (source in ('banner', 'checkout', 'signup', 'upgrade'));

create index if not exists consent_events_user_idx
  on public.consent_events (user_id, created_at desc) where user_id is not null;

comment on column public.consent_events.user_id is
  'GP-03: the login that gave an account consent (signup / upgrade). No FK — the proof outlives the login.';

-- Insert-only, with the two tenant_id moves above as the only exceptions.
create or replace function public.consent_events_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- GP-03: only tenant_id may change, and only in the two ways below.
  if (to_jsonb(new) - 'tenant_id') = (to_jsonb(old) - 'tenant_id') then
    -- 1. verify step: a user's signup consent gets its workspace, once.
    if old.tenant_id is null and new.tenant_id is not null and old.user_id is not null then
      return new;
    end if;
    -- 2. tenant erasure (FK ON DELETE SET NULL): the tenant is already gone.
    if old.tenant_id is not null and new.tenant_id is null
       and not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
      return new;
    end if;
  end if;
  raise exception 'consent_events is insert-only (R-2010/GP-03): a consent record is never changed — add a new row'
    using errcode = '42501';
end;
$$;
revoke all on function public.consent_events_no_update() from public, anon, authenticated;

drop policy if exists zzz_service_role_updates on public.consent_events;
create policy zzz_service_role_updates on public.consent_events
  as permissive for update to service_role using (true) with check (true);

grant update (tenant_id) on public.consent_events to service_role;

commit;
