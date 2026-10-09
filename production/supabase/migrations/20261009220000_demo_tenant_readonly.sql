-- deploy-peek: (to_regclass('public.demo_tenants') is not null and to_regprocedure('public.demo_pre_request()') is not null and to_regprocedure('public.demo_readonly_probe()') is not null)
-- deploy-key: demotenant
-- 20261009220000_demo_tenant_readonly
--
-- WHAT THIS CHANGES (R-524 — Pardeep's decision 2A, 9 Oct 2026: "Try the demo" = a READ-ONLY
-- sample account, no signup)
--
--   1. public.demo_tenants — the ONE sample workspace and its two logins:
--        visitor_user_id  the login every "Try the demo" visitor is signed in as. READ-ONLY.
--        seeder_user_id   the login the nightly reset writes sample data with. Never handed out.
--      Rows are written only by the server (service_role). Nobody can make their own tenant a
--      demo tenant, and a real tenant is never in this table.
--
--   2. public.demo_pre_request() — PostgREST runs it before EVERY request (pgrst.db_pre_request
--      on the authenticator role, set at the end). When the caller is a demo visitor it turns the
--      request's transaction READ ONLY. From then on Postgres itself refuses every INSERT,
--      UPDATE, DELETE, nextval and DDL in that request — including inside SECURITY DEFINER RPCs
--      and triggers — with SQLSTATE 25006. This is the server-side wall: it does not depend on
--      any one table's RLS policy or any one route remembering to check.
--      For everyone else it is one indexed lookup (or nothing at all for anon).
--
--   3. public.demo_readonly_probe() — returns 'on' when the wall is up for the caller. The app
--      calls it right after signing a visitor in and REFUSES to hand out the session unless it
--      says 'on' (fail closed: if this migration or the PostgREST config is missing, the demo
--      button says "not available" instead of opening a writable session).
--
--   4. Storage (uploads go straight to the storage API, not through PostgREST): RESTRICTIVE
--      policies on storage.objects refuse insert/update/delete for a demo visitor — and the
--      PostgREST wiring (ALTER ROLE authenticator). Both need the postgres user on Cloud SQL, so
--      they live in the next file, 20261009220100_demo_readonly_wiring.sql (deploy-user postgres).
--
--   5. _demo_data_tenant() (R-361's gate for the demo invoice RPCs) also accepts the demo
--      tenant's seeder, so the nightly reset can add sample invoices on a database whose
--      demo_data_switch is off (live). Still owner/manager + the caller's own tenant only.
--
-- Data isolation: the visitor is an ordinary public.users row in the demo tenant, so every
-- existing RLS policy (current_tenant_id()) already keeps other tenants' rows out of reach.
--
-- Until 20261009220100 is applied the wall is NOT up — and /api/demo/session refuses to open
-- the demo (it checks demo_readonly_probe() = 'on'), so nothing is ever writable. Idempotent.

begin;

-- ── 1. The demo tenant registry ─────────────────────────────────────────────────

create table if not exists public.demo_tenants (
  tenant_id        uuid primary key references public.tenants(id) on delete cascade,
  visitor_user_id  uuid not null unique,
  seeder_user_id   uuid not null unique,
  created_at       timestamptz not null default now(),
  constraint demo_tenants_two_logins check (visitor_user_id <> seeder_user_id)
);
comment on table public.demo_tenants is
  'R-524: the read-only sample workspace behind "Try the demo". Server (service_role) writes only.';

alter table public.demo_tenants enable row level security;
revoke all on table public.demo_tenants from anon, authenticated;
grant select, insert, update, delete on table public.demo_tenants to service_role;
drop policy if exists demo_tenants_service_role on public.demo_tenants;
create policy demo_tenants_service_role on public.demo_tenants
  to service_role using (true) with check (true);

-- ── 2. The read-only wall ───────────────────────────────────────────────────────

create or replace function public.is_demo_visitor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (select 1 from public.demo_tenants d where d.visitor_user_id = auth.uid());
$$;
comment on function public.is_demo_visitor() is
  'R-524: true when the caller is the read-only "Try the demo" login.';
revoke all on function public.is_demo_visitor() from public;
grant execute on function public.is_demo_visitor() to anon, authenticated, service_role;

create or replace function public.demo_pre_request()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and exists (select 1 from public.demo_tenants d where d.visitor_user_id = auth.uid()) then
    perform pg_catalog.set_config('transaction_read_only', 'on', true);
  end if;
end $$;
comment on function public.demo_pre_request() is
  'R-524: PostgREST db_pre_request. Makes every request of a demo visitor a READ ONLY transaction.';
revoke all on function public.demo_pre_request() from public;
grant execute on function public.demo_pre_request() to anon, authenticated, service_role;

create or replace function public.demo_readonly_probe()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select pg_catalog.current_setting('transaction_read_only');
$$;
comment on function public.demo_readonly_probe() is
  'R-524: ''on'' when this request runs read-only. The demo session is refused unless it is.';
revoke all on function public.demo_readonly_probe() from public;
grant execute on function public.demo_readonly_probe() to authenticated, service_role;

-- ── 5. Demo invoices for the demo tenant's seeder (R-361 gate) ──────────────────

create or replace function public._demo_data_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if not exists (select 1 from public.demo_data_switch where enabled)
     and not exists (select 1 from public.demo_tenants d
                      where d.tenant_id = v_tenant and d.seeder_user_id = auth.uid()) then
    raise exception 'Demo invoices are switched off for this database (public.demo_data_switch).'
      using errcode = '42501';
  end if;
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can add or clear demo data.'
      using errcode = '42501';
  end if;
  return v_tenant;
end $$;
revoke all on function public._demo_data_tenant() from public, anon, authenticated;

-- Storage policies and the PostgREST wiring need the postgres user on Cloud SQL — they are in
-- 20261009220100_demo_readonly_wiring.sql. The grant below (made here, by the function's owner)
-- lets storage's policies call the check.
grant execute on function public.is_demo_visitor() to supabase_storage_admin;

commit;
