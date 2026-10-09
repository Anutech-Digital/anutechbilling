-- deploy-key: sitepromoowner
-- deploy-peek: (exists(select 1 from pg_policy where polname = 'site_promos_insert_admin' and polrelid = to_regclass('public.site_promos')) and not exists(select 1 from pg_policy where polname = 'site_promos_tenant_write' and polrelid = to_regclass('public.site_promos')))
-- 20261009233000_site_promo_owner_only.sql
--
-- R-700 (security, 9 Oct 2026).
--
-- ══ WHAT WAS OPEN ════════════════════════════════════════════════════════════
--
--   create_site_promo(p_tenant_id, …, p_created_by)   baseline.sql:1096
--     SECURITY DEFINER, granted to `authenticated`, and it checked NOTHING: not who the
--     caller is, not that p_tenant_id is the caller's tenant, not their role. Signup is
--     open, so anybody could make an account, call it with ANUTECH's tenant id and
--     discount 100 percent. /api/public/checkout/workspace auto-applies the newest active
--     promo of BUY_PAGE_TENANT_ID (route.ts:258-290) → Google Workspace sold for Rs 0 on
--     the public site. p_created_by was also caller-chosen, so the trail could name
--     anybody.
--
--   site_promos_tenant_write   tenant only, no role. The menu shows "Website offer
--     banner" to owner/manager only (nav.ts, roles OM), but a sales or support login
--     could insert / switch on / rewrite a promo straight through PostgREST.
--
--   anon   baseline GRANT ALL on site_promos. RLS stopped it; nothing anonymous reads the
--     table (the public routes use the service-role client).
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════
--
--   create_site_promo: a signed-in caller must be an active owner/manager OF p_tenant_id;
--     created_by is always auth.uid() (p_created_by is ignored for users, kept in the
--     signature so the app call does not change). The service connection (no user) may
--     still call it. A percent discount above 100 is refused for everybody.
--   site_promos writes → owner / manager of the tenant. Reads unchanged.
--   anon loses its table grant.
--
-- Local DB had 0 site_promos rows when this was written; no data is touched.

begin;

create or replace function public.create_site_promo(
  p_tenant_id uuid, p_headline text, p_subheadline text, p_badge_text text,
  p_discount_type text, p_discount_value integer, p_applies_to_tier text,
  p_min_seats integer, p_max_seats integer, p_banner_style text,
  p_valid_until timestamp with time zone, p_created_by uuid
) returns text
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_id         text;
  v_created_by uuid;
begin
  if coalesce(auth.role() = 'service_role', false) then
    v_created_by := p_created_by;
  else
    if auth.uid() is null then
      raise exception 'Sign in first, then create the offer from Website offer banner.'
        using errcode = '42501';
    end if;
    if p_tenant_id is distinct from public.current_tenant_id() then
      raise exception 'You can only create offers for your own company. Open Website offer banner in your own workspace.'
        using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner', 'manager') then
      raise exception 'Only an owner or manager can create a website offer. Ask your owner to create it, or to change your role in Team.'
        using errcode = '42501';
    end if;
    v_created_by := auth.uid();
  end if;

  if p_discount_type = 'percent' and p_discount_value > 100 then
    raise exception 'A percent offer cannot be more than 100. Enter 100 or less.'
      using errcode = '22023';
  end if;

  v_id := 'SP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into site_promos (
    id, tenant_id, headline, subheadline, badge_text,
    discount_type, discount_value,
    applies_to_tier, min_seats, max_seats,
    banner_style, valid_until, created_by
  ) values (
    v_id, p_tenant_id, p_headline, p_subheadline, p_badge_text,
    p_discount_type, p_discount_value,
    p_applies_to_tier, coalesce(p_min_seats, 1), p_max_seats,
    coalesce(p_banner_style, 'amber'), p_valid_until, v_created_by
  );
  return v_id;
end;
$$;

revoke all on function public.create_site_promo(uuid, text, text, text, text, integer, text, integer, integer, text, timestamp with time zone, uuid) from public, anon;
grant execute on function public.create_site_promo(uuid, text, text, text, text, integer, text, integer, integer, text, timestamp with time zone, uuid) to authenticated, service_role;

-- ── site_promos: writes by owner / manager only ─────────────────────────────────
revoke all on table public.site_promos from anon;

drop policy if exists site_promos_tenant_write   on public.site_promos;
drop policy if exists site_promos_insert_admin   on public.site_promos;
drop policy if exists site_promos_update_admin   on public.site_promos;
drop policy if exists site_promos_delete_admin   on public.site_promos;

create policy site_promos_insert_admin on public.site_promos for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy site_promos_update_admin on public.site_promos for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy site_promos_delete_admin on public.site_promos for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));

commit;
