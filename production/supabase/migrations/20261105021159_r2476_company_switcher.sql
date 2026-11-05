-- deploy-peek: to_regprocedure('public.my_companies()') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.switch_company(uuid)') and prosrc like '%R-2476%')
-- R-2476 — R-2471 slice 2: company switcher in the top bar. Spec: docs/specs/memberships.md §2.5 / §4.
--
--   1. my_companies() — what the switcher lists: the caller's ACTIVE, not-ended, not-expired
--      memberships with company name, role in that company and which one is selected. A login's own
--      memberships only (tenant_memberships RLS lets it read them, but tenants RLS hides the other
--      companies' names — hence SECURITY DEFINER). Nothing before two-step sign-in (R-731).
--   2. switch_company() — redefined from its only body (20261105000000_r2471; R-2481 did not touch
--      it). Changes: (a) the MFA refusal names the next step (§24); (b) R-2471 review.left #5 — the
--      users UPDATE made log_row_change write ONE activity row in the NEW company holding the OLD
--      company's uuid, role and employee link. Now each company's log gets only its own facts:
--      the new company "switched in, as <role>", the old company "switched out, was <role>".
--      Switching to the company already selected writes nothing (no change).

-- ── 1. my_companies ──────────────────────────────────────────────────────────────────
create or replace function public.my_companies()
returns table (tenant_id uuid, company_name text, role text, is_current boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
/* R-2476: the company switcher's list. Own memberships only; selected one first. */
declare
  v_uid uuid := public.current_user_id();
begin
  if v_uid is null or not public.session_mfa_ok() then
    return;
  end if;
  return query
    select m.tenant_id, t.name::text, m.role::text, (m.tenant_id = u.tenant_id)
      from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      join public.users u on u.id = m.user_id
     where m.user_id = v_uid
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
     order by (m.tenant_id = u.tenant_id) desc, lower(t.name), m.tenant_id;
end;
$$;

revoke all on function public.my_companies() from public, anon;
grant execute on function public.my_companies() to authenticated;

-- ── 2. switch_company ────────────────────────────────────────────────────────────────
create or replace function public.switch_company(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
/* R-2471: select which company this login works in. Only onto an ACTIVE membership of the
   caller (not ended, not past access_ends_on), only after MFA when enrolled. Every column the
   membership owns is copied onto users in the same UPDATE, so role / active / employee link
   always match the selected company.
   R-2476: each company's activity log gets only its own facts (see the migration header). */
declare
  v_uid      uuid := public.current_user_id();
  v_m        public.tenant_memberships;
  v_old_tid  uuid;
  v_old_role text;
  v_name     text;
  v_old_co   text;
  v_new_co   text;
  v_log      bigint;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.session_mfa_ok() then
    raise exception 'Finish two-step sign-in before switching company: open the two-step sign-in page, type the 6-digit code from your authenticator app, then switch again.'
      using errcode = '42501';
  end if;
  select * into v_m from public.tenant_memberships m
   where m.user_id = v_uid and m.tenant_id = p_tenant_id
     and m.is_active and m.ended_at is null
     and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
     for share;   -- a concurrent change to this membership waits for the switch (and v.v.)
  if v_m.id is null then
    raise exception 'You are not a member of that company, or your access there has ended. Ask that company''s owner to invite you again.'
      using errcode = '42501';
  end if;

  select u.tenant_id, u.role::text, u.full_name into v_old_tid, v_old_role, v_name
    from public.users u where u.id = v_uid for update;

  update public.users
     set tenant_id = v_m.tenant_id, role = v_m.role, is_active = true,
         access_ends_on = v_m.access_ends_on, employee_id = v_m.employee_id,
         manager_id = v_m.manager_id, can_view_deals = v_m.can_view_deals,
         gets_new_leads = v_m.gets_new_leads
   where id = v_uid;

  if v_old_tid is distinct from v_m.tenant_id then
    select t.name into v_new_co from public.tenants t where t.id = v_m.tenant_id;
    select t.name into v_old_co from public.tenants t where t.id = v_old_tid;

    /* The row users_activity (log_row_change) just wrote in the NEW company carries the old
       company's tenant_id / role / employee_id. Same transaction (created_at = now()), so it is
       this switch's row — rewrite it to the new company's facts only. */
    select max(a.id) into v_log from public.activity_log a
     where a.tenant_id = v_m.tenant_id and a.entity = 'users' and a.entity_id = v_uid::text
       and a.action = 'update' and a.created_at = now() and a.changes ? 'tenant_id';
    if v_log is not null then
      update public.activity_log a
         set label = left(coalesce(v_name, '') || ' switched into this company', 120),
             changes = jsonb_build_object(
               'company', jsonb_build_object('old', null, 'new', v_new_co),
               'role',    jsonb_build_object('old', null, 'new', v_m.role::text))
       where a.id = v_log;
    else
      insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
      values (v_m.tenant_id, v_uid, 'update', 'users', v_uid::text,
              left(coalesce(v_name, '') || ' switched into this company', 120),
              jsonb_build_object(
                'company', jsonb_build_object('old', null, 'new', v_new_co),
                'role',    jsonb_build_object('old', null, 'new', v_m.role::text)));
    end if;

    if v_old_tid is not null then
      insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
      values (v_old_tid, v_uid, 'update', 'users', v_uid::text,
              left(coalesce(v_name, '') || ' switched to another company', 120),
              jsonb_build_object(
                'company', jsonb_build_object('old', v_old_co, 'new', null),
                'role',    jsonb_build_object('old', v_old_role, 'new', null)));
    end if;
  end if;

  return v_m.tenant_id;
end;
$$;

revoke all on function public.switch_company(uuid) from public, anon;
grant execute on function public.switch_company(uuid) to authenticated, service_role;
