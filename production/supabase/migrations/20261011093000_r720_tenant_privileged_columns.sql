-- deploy-key: r720tenants
-- deploy-peek: (to_regprocedure('public.r720_tenants_column_guard()') is not null and to_regprocedure('public.r720_tenant_domains_guard()') is not null and exists(select 1 from pg_trigger where tgname = 'a00_r720_tenants_column_guard' and tgrelid = to_regclass('public.tenants')) and exists(select 1 from pg_trigger where tgname = 'a00_r720_tenant_domains_guard' and tgrelid = to_regclass('public.tenant_domains')) and not exists(select 1 from pg_policy where polname = 'tenants_signup_insert' and polrelid = to_regclass('public.tenants')) and not exists(select 1 from pg_policy where polname = 'tenant_domains_write' and polrelid = to_regclass('public.tenant_domains')))
-- 20261011093000_r720_tenant_privileged_columns.sql
--
-- R-720 (P1 SECURITY, audit 10 Oct 2026): an owner could write the columns that only the
-- platform is supposed to decide.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct (all later migrations applied) ═══
--
--   tenant_domains_write   FOR ALL to authenticated, "own tenant + owner" — nothing about
--                          verified_at. One REST call: insert victimcorp.com with
--                          verified_at = now(). findVerifiedDomainTenant() then sends every
--                          new @victimcorp.com signup to the attacker's workspace as a join
--                          request (their name + email land with the attacker), and the
--                          unique index on lower(domain) stops the real company claiming it.
--   tenants_self_update    owner, no column guard: tier, parent_tenant_id (→ get_partner_catalog
--                          returns ANOTHER distributor's partner prices), gstin_verified_at /
--                          gstin_verification (a "GSTN verified" badge nobody verified), and
--                          gmail_sender_user_id (point the Gmail sender at a user of another
--                          workspace → routeForTenant() sends our mail with THEIR Google token).
--   tenants_signup_insert  authenticated, WITH CHECK (true): a tenant row with any columns,
--                          parent_tenant_id / tier / gstin_verified_at included.
--
-- ══ WHO WRITES THESE TODAY — mapped from production/src before changing anything ══════
--
--   tenants insert          /api/auth/signup, /api/auth/onboarding/new-tenant, demo account —
--                           all createAdminClient (service_role). Same on anutech/staging.
--   tenant_domains          the same two signup routes insert an UNVERIFIED claim with the
--                           admin client; findVerifiedDomainTenant reads with the admin client.
--                           No screen writes tenant_domains and NOTHING in the app sets
--                           verified_at — verification is an operator step (service_role / SQL).
--   tier                    /platform → /api/platform/signups/[id] (admin client).
--   gstin_verified_at,      /api/gstin/verify (admin client, only when the verified GSTIN equals
--   gstin_verification      the tenant's saved GSTIN).
--   gmail_sender_user_id    /api/integrations/email-provider (admin client, after checking the
--                           sender has a Google token).
--   everything else         Settings / Setup wizard / compliance / overdue cards via the user
--                           client — unchanged.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--
--   Both guards fire only for request roles (authenticated / anon locally and on PostgREST,
--   app_runtime on staging). service_role (the admin client), SECURITY DEFINER functions
--   (current_user = owner) and psql / scripts pass untouched — the R-719 rule.
--
--   tenants (BEFORE INSERT OR UPDATE)
--     id, tier, parent_tenant_id         request roles cannot change them
--     gstin_verified_at,                 request roles cannot SET them (clearing is allowed);
--     gstin_verification                 when a request role changes the GSTIN itself, both are
--                                        cleared — the old verification was for another number
--     gmail_sender_user_id               a request role may only point it at a member of the
--                                        same workspace (or clear it)
--     insert                             tenants_signup_insert dropped → request roles cannot
--                                        insert tenants at all (signup is server-side)
--   tenant_domains (BEFORE INSERT OR UPDATE + split policies)
--     insert / update                    owner, own tenant, verified_at must stay NULL
--     a verified row                     read-only for request roles (no domain swap that would
--                                        carry the verification to another domain); the owner
--                                        may still delete their own row
--
-- Visible change: editing the company GSTIN in Settings now resets the "verified" badge until
-- it is verified again. Nothing else on any screen changes.
--
-- Re-runnable: create or replace / drop … if exists. No auth.users, no extensions schema,
-- no auth.role() (current_user is used, as in R-719).
-- Test: supabase/tests/r720_tenant_domain_fields.test.sql (rolled back).

begin;

-- ── tenants: platform-owned columns ─────────────────────────────────────────────────
create or replace function public.r720_tenants_column_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if current_user::text not in ('authenticated', 'anon', 'app_runtime') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- No request-role insert policy exists any more; this is the second wall.
    if new.parent_tenant_id is not null
       or new.gstin_verified_at is not null
       or new.gstin_verification is not null
       or coalesce(new.tier, 'reseller') <> 'reseller' then
      raise exception 'Only the server can create a workspace with a tier, parent or GSTIN verification.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tier is distinct from old.tier
     or new.parent_tenant_id is distinct from old.parent_tenant_id then
    raise exception 'Workspace tier and parent distributor are set by the platform, not from the app.'
      using errcode = '42501';
  end if;

  if (new.gstin_verified_at is distinct from old.gstin_verified_at and new.gstin_verified_at is not null)
     or (new.gstin_verification is distinct from old.gstin_verification and new.gstin_verification is not null) then
    raise exception 'GSTIN verification is recorded only by the Verify with GSTN check.'
      using errcode = '42501';
  end if;

  -- A new GSTIN is not the one that was verified.
  if upper(btrim(coalesce(new.gstin, ''))) is distinct from upper(btrim(coalesce(old.gstin, ''))) then
    new.gstin_verified_at  := null;
    new.gstin_verification := null;
  end if;

  if new.gmail_sender_user_id is distinct from old.gmail_sender_user_id
     and new.gmail_sender_user_id is not null
     and not exists (select 1 from public.users u
                      where u.id = new.gmail_sender_user_id and u.tenant_id = new.id) then
    raise exception 'The Gmail sender must be a member of this workspace.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function public.r720_tenants_column_guard() from public, anon, authenticated;

drop trigger if exists a00_r720_tenants_column_guard on public.tenants;
create trigger a00_r720_tenants_column_guard
  before insert or update on public.tenants
  for each row execute function public.r720_tenants_column_guard();

-- Signup creates tenants with the admin client only.
drop policy if exists tenants_signup_insert on public.tenants;

-- ── tenant_domains: verified_at belongs to the platform ────────────────────────────
create or replace function public.r720_tenant_domains_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if current_user::text not in ('authenticated', 'anon', 'app_runtime') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.verified_at is not null then
      raise exception 'A domain is marked verified only after the DNS check, by the server.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.verified_at is not null then
    raise exception 'A verified domain cannot be changed from the app.'
      using errcode = '42501';
  end if;
  if new.verified_at is not null then
    raise exception 'A domain is marked verified only after the DNS check, by the server.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.r720_tenant_domains_guard() from public, anon, authenticated;

drop trigger if exists a00_r720_tenant_domains_guard on public.tenant_domains;
create trigger a00_r720_tenant_domains_guard
  before insert or update on public.tenant_domains
  for each row execute function public.r720_tenant_domains_guard();

drop policy if exists tenant_domains_write  on public.tenant_domains;
drop policy if exists tenant_domains_insert_owner on public.tenant_domains;
drop policy if exists tenant_domains_update_owner on public.tenant_domains;
drop policy if exists tenant_domains_delete_owner on public.tenant_domains;

create policy tenant_domains_insert_owner on public.tenant_domains for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner')
              and verified_at is null);
create policy tenant_domains_update_owner on public.tenant_domains for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner')
              and verified_at is null)
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner')
              and verified_at is null);
create policy tenant_domains_delete_owner on public.tenant_domains for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner'));

commit;
