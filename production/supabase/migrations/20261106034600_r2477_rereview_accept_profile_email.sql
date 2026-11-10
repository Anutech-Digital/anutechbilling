-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.guard_privileged_user_columns()') and prosrc like '%R-2477 re-review%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_company_invite(uuid)') and prosrc like '%R-2477 re-review%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.invite_existing_login(text,public.user_role)') and prosrc like '%R-2477 re-review%')
-- deploy-key: r2477rereview
-- 20261106034600_r2477_rereview_accept_profile_email.sql
--
-- R-2477 re-review (BLOCK, 6 Nov 2026) — two levers to act as an invited login before it accepts.
-- Spec: docs/specs/memberships.md §6.2. The temporary-password route (app side) now also refuses a
-- login with an open invite from another company; Auth.js linkOAuthUser no longer links a Google
-- sign-in through a profile email that differs from a never-signed-in login's own address.
--
--   0. guard_privileged_user_columns: the never-signed-in exception is removed — anyone but the
--      login itself may set users.email only back to the login's own sign-in address (the root
--      cause of the re-pointed-email lever; a mistyped invite is withdrawn and re-sent instead).
--   1. accept_company_invite refuses when the login's profile email (users.email) is no longer its
--      sign-in address (auth.users.email) — an owner may set it for a never-signed-in teammate.
--   2. invite_existing_login answers 'plain' for both "no login" and "works in no company" (was
--      not_found / no_company), so it does not say whether an address has a login.
--
-- Bodies redefined from their LATEST versions: 20261105192420_r2477_review_consent_email_guard.sql
-- (guard_privileged_user_columns, invite_existing_login, accept_company_invite).

begin;

create or replace function public.guard_privileged_user_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_is_owner  boolean;
  v_emp_email text;
begin
  /* R-712: nothing guarded changed → the common case (names, reminder prefs) pays nothing. */
  if new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.gets_new_leads is not distinct from old.gets_new_leads
     and new.tenant_id      is not distinct from old.tenant_id
     and new.is_active      is not distinct from old.is_active
     and new.access_ends_on is not distinct from old.access_ends_on
     and new.employee_id    is not distinct from old.employee_id
     and new.email          is not distinct from old.email then
    return new;
  end if;

  /* Server paths (OAuth callback re-link, claim-merge, reset-data, scripts) carry no user. */
  if v_uid is null or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  /* R-2471: switching a selected company. R-2477: for the ROW's login (its own switch, or the
     definer move when an owner removes them / claims them back) — allowed only onto an ACTIVE,
     not-ended, not-expired membership of THAT login, with exactly that membership's values, so a
     selection change can never invent a company or a role. A direct PATCH cannot reach this for
     another login: users_tenant_update's WITH CHECK keeps the row in the caller's company. */
  if new.tenant_id is distinct from old.tenant_id
     and new.email is not distinct from old.email
     and new.is_active
     and exists (
       select 1 from public.tenant_memberships m
        where m.user_id = old.id and m.tenant_id = new.tenant_id
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
          and m.role = new.role
          and m.access_ends_on is not distinct from new.access_ends_on
          and m.employee_id    is not distinct from new.employee_id
          and m.manager_id     is not distinct from new.manager_id
          and m.can_view_deals = new.can_view_deals
          and m.gets_new_leads = new.gets_new_leads) then
    return new;
  end if;

  /* Moving a login between workspaces: never your own row. The one legitimate signed-in path
     is merge_stranded_user_into_tenant (Team -> Claim a colleague, SECURITY DEFINER, its own
     empty-workspace checks): an ACTIVE owner of the DESTINATION pulling someone else in. RLS
     hides other workspaces' rows from a plain PATCH, so only definer code reaches this branch. */
  if new.tenant_id is distinct from old.tenant_id then
    if old.id = v_uid or not exists (
         select 1 from public.users u
          where u.id = v_uid and u.role = 'owner' and u.is_active and u.tenant_id = new.tenant_id) then
      raise exception 'A login cannot be moved to another workspace from the app.'
        using errcode = '42501';
    end if;
  end if;

  if new.employee_id is distinct from old.employee_id and new.employee_id is not null then
    if not exists (select 1 from public.employees e
                    where e.id = new.employee_id and e.tenant_id = new.tenant_id) then
      raise exception 'Employee not in your workspace' using errcode = '42501';
    end if;
    if exists (select 1 from public.users u
                where u.employee_id = new.employee_id and u.id <> old.id) then
      raise exception 'This employee record is already linked to another login.' using errcode = '42501';
    end if;
  end if;

  /* R-2477 review (BLOCK): users.email is the LOGIN's identity — Auth.js maps a verified Google
     sign-in to the profile with that email (server/auth/accounts.ts linkOAuthUser). Pointed at an
     address someone else controls, it hands them the login — and with it every company the login
     works in now or LATER (security review: the change can be made while the login is still in one
     company and used after it joins another). So anyone but the login itself may change it only
       (a) back to the login's own sign-in address (auth.users.email) — re-aligning, never
           redirecting; or
       (b) for a login that has never signed in and has no other company and no open invite from
           one (the R-712 owner fix of a mistyped teammate address keeps working).
     Server paths with no user pass above. Same spirit as the temporary-password route. */
  /* R-2477 re-review: the never-signed-in exception is gone — re-pointing a never-signed-in
     teammate's address was the last lever (sign in as them via linkOAuthUser, accept another
     company's invite). Anyone but the login itself may only set it BACK to the login's own sign-in
     address. A mistyped invite is fixed by withdrawing it and inviting the right address. */
  if new.email is distinct from old.email
     and old.id is distinct from v_uid
     and lower(coalesce(new.email, '')) is distinct from
         (select lower(au.email) from auth.users au where au.id = old.id) then
    raise exception 'This email is their sign-in identity, so only they can change their email, never a company owner. Next step: if the address was mistyped, remove them and invite the right address; otherwise ask them to contact ResellerOS support from their own login.'
      using errcode = '42501';
  end if;

  if new.email is distinct from old.email then
    if new.email is null
       or exists (select 1 from public.users u
                   where lower(u.email) = lower(new.email) and u.id <> old.id)
       or exists (select 1 from public.team_invites i
                   where lower(i.email) = lower(new.email) and i.accepted_at is null
                     and i.tenant_id <> new.tenant_id) then
      raise exception 'This email already belongs to another login or a pending invite.' using errcode = '42501';
    end if;
  end if;

  select exists (
    select 1 from public.users u
     where u.id = v_uid and u.role = 'owner' and u.is_active and u.tenant_id = new.tenant_id
  ) into v_is_owner;

  if v_is_owner then
    return new;
  end if;

  /* The one self-service change: link MY login to MY employee record (set_my_employee rules). */
  if old.id = v_uid
     and new.employee_id is distinct from old.employee_id and new.employee_id is not null
     and new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.gets_new_leads is not distinct from old.gets_new_leads
     and new.is_active      is not distinct from old.is_active
     and new.access_ends_on is not distinct from old.access_ends_on
     and new.email          is not distinct from old.email then
    select e.email into v_emp_email from public.employees e where e.id = new.employee_id;
    if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(old.email, '')) then
      raise exception 'Your login email does not match this employee record. Ask an owner to link you.' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access, new-lead assignment, active status, login end date, email or employee link. Ask an owner to do it on the Team page (/team).'
    using errcode = '42501';
end;
$$;

comment on function public.guard_privileged_user_columns() is
  'R-712 / R-2477: signed-in callers can never change users.tenant_id (one exception, R-2471/R-2477: a selection change of the row''s login onto its own active membership with exactly its values); role / manager_id / can_view_deals / gets_new_leads / is_active / access_ends_on (R-1896) / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite, and is changed by anyone but the login itself only back to the login''s own sign-in address (R-2477 re-review). No auth.uid() / service_role passes through.';


create or replace function public.invite_existing_login(p_email text, p_role public.user_role)
returns text
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477 review: Team → Invite for an address whose LOGIN already works in another company.
   Owner + MFA (current_user_has_role). Every call is counted (30 an hour per login) and leaves an
   audit line in the caller's company. Writes nothing in any other company.
     'invited'        — a membership_invites row (new or renewed for 7 days); the login accepts it.
     'already_member' — they are a member of this company already.
     'plain'          — no login with this address, or one that works in no company right now:
                        the plain invite (+ Claim) path. R-2477 re-review: one answer for both, so
                        it says nothing about whether an address has a login at all. */
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid := public.current_user_id();
  v_tid   uuid;
  v_user  uuid;
begin
  v_tid := public.current_tenant_id();
  if v_uid is null or v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an active company owner can invite. Sign in again (with the authenticator code if you use one) and retry.'
      using errcode = '42501';
  end if;
  /* lib/auth/roles.ts INVITABLE_ROLES — never 'personal' / 'partner_agent' (set by the server only) */
  if p_role is null or p_role::text in ('personal', 'partner_agent') then
    raise exception 'Pick a role for them from the list.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('r2477-invite-existing:' || v_uid::text, 0));
  if (select count(*) from public.activity_log a
       where a.user_id = v_uid and a.action = 'team_invite.existing_login'
         and a.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many invites in the last hour. Try again later.' using errcode = '54000';
  end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, label)
  values (v_tid, v_uid, 'team_invite.existing_login', 'team_invite',
          left(format('Invite for %s as %s', v_email, p_role), 200));

  if v_email = '' then
    return 'plain';
  end if;

  select u.id into v_user
    from auth.users au join public.users u on u.id = au.id
   where lower(au.email) = v_email
   limit 1;
  if v_user is null then
    return 'plain';
  end if;

  if exists (select 1 from public.tenant_memberships m
              where m.user_id = v_user and m.tenant_id = v_tid and m.ended_at is null) then
    return 'already_member';
  end if;
  if not exists (select 1 from public.tenant_memberships m
                  where m.user_id = v_user and m.ended_at is null) then
    return 'plain';
  end if;

  insert into public.membership_invites as i (tenant_id, user_id, email, role, invited_by)
  values (v_tid, v_user, v_email, p_role, v_uid)
  on conflict (tenant_id, user_id) do update
     set email = excluded.email, role = excluded.role, invited_by = excluded.invited_by,
         created_at = now(), expires_at = now() + interval '7 days', accepted_at = null;
  return 'invited';
end;
$$;

revoke all on function public.invite_existing_login(text, public.user_role) from public, anon;
grant execute on function public.invite_existing_login(text, public.user_role) to authenticated, service_role;

create or replace function public.accept_company_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477 review: the login accepts an invite addressed to IT — the explicit agreement Claim used to
   assume from a sign-in. Adds (or re-opens) the membership with the invited role. If the login's
   selected company is no longer usable, or is a blank workspace of its own (only them, no
   records), the new company becomes the selected one; nothing is deleted. */
declare
  v_uid   uuid := public.current_user_id();
  v_inv   public.membership_invites;
  v_name  text;
  v_sel   uuid;
  v_who   text;
  v_select boolean := false;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.session_mfa_ok() then
    raise exception 'Finish two-step sign-in first: type the 6-digit code from your authenticator app, then accept the invite.'
      using errcode = '42501';
  end if;

  select * into v_inv from public.membership_invites i
   where i.id = p_invite_id and i.user_id = v_uid
   for update;
  if v_inv.id is null then
    raise exception 'This invite is not for you, or it was withdrawn. Ask the company to invite you again.'
      using errcode = 'P0002';
  end if;
  select t.name into v_name from public.tenants t where t.id = v_inv.tenant_id;
  if v_inv.accepted_at is not null then
    return jsonb_build_object('tenant_id', v_inv.tenant_id, 'company_name', v_name, 'role', v_inv.role,
                              'already', true, 'selected', false);
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invite from % has expired. Ask them to invite you again.', coalesce(v_name, 'that company')
      using errcode = '42501';
  end if;
  /* The invite was addressed to the login's sign-in address — if that address changed since, the
     invite is not for whoever holds the login now. */
  if not exists (select 1 from auth.users au where au.id = v_uid and lower(au.email) = v_inv.email) then
    raise exception 'This invite was sent to another email address. Ask % to invite the address you sign in with.', coalesce(v_name, 'the company')
      using errcode = '42501';
  end if;
  /* R-2477 re-review: the profile email (users.email — what a Google sign-in is linked by) must
     still be the login's own address. A company owner may set it for a teammate who never signed
     in; re-pointed, it could let that owner sign in as the teammate and accept here. */
  if not exists (select 1 from public.users u
                  join auth.users au on au.id = u.id
                 where u.id = v_uid and lower(coalesce(u.email, '')) = lower(coalesce(au.email, ''))) then
    raise exception 'Your profile email is not the address you sign in with, so this invite cannot be accepted from here. Next step: ask ResellerOS support to fix your profile email, then accept again.'
      using errcode = '42501';
  end if;
  /* Whoever sent it must still be an active owner there, or nobody with authority stands behind it. */
  if v_inv.invited_by is null or not exists (
       select 1 from public.tenant_memberships m
        where m.user_id = v_inv.invited_by and m.tenant_id = v_inv.tenant_id and m.role = 'owner'
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
    raise exception 'This invite from % is no longer valid (the person who sent it is no longer an owner there). Ask them to invite you again.', coalesce(v_name, 'that company')
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.tenant_memberships m
                  where m.user_id = v_uid and m.tenant_id = v_inv.tenant_id and m.ended_at is null) then
    insert into public.tenant_memberships as m (user_id, tenant_id, role, is_active, created_by)
    values (v_uid, v_inv.tenant_id, v_inv.role, true, v_inv.invited_by)
    on conflict (user_id, tenant_id) do update
       set role = excluded.role, is_active = true, access_ends_on = null,
           manager_id = null, can_view_deals = false, gets_new_leads = false,
           ended_at = null, end_reason = null, ended_by = null, updated_at = now();
  end if;
  update public.membership_invites set accepted_at = now() where id = v_inv.id;

  select u.tenant_id, coalesce(nullif(btrim(u.full_name), ''), u.email)
    into v_sel, v_who from public.users u where u.id = v_uid for update;
  v_select := v_sel is distinct from v_inv.tenant_id and (
       not exists (select 1 from public.tenant_memberships m
                     join public.users u on u.id = m.user_id and u.tenant_id = m.tenant_id
                    where m.user_id = v_uid and m.is_active and m.ended_at is null and u.is_active
                      and (m.access_ends_on is null or m.access_ends_on >= public.ist_today()))
    or (not exists (select 1 from public.tenant_memberships m
                     where m.tenant_id = v_sel and m.user_id <> v_uid and m.ended_at is null)
        and not exists (select 1 from public.users u2 where u2.tenant_id = v_sel and u2.id <> v_uid)
        and not public.tenant_holds_business_records(v_sel))
    /* a personal account (G-PERSONAL) joining a business: work in the business; the personal
       workspace stays and the switcher brings it back */
    or exists (select 1 from public.tenants t where t.id = v_sel and t.workspace_kind = 'personal'));
  if v_select then
    perform public.r2477_select_membership(v_uid, v_inv.tenant_id);
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_inv.tenant_id, v_uid, 'team_invite.accepted', 'users', v_uid::text,
          left(format('%s accepted the invite and joined as %s', coalesce(v_who, v_inv.email), v_inv.role), 200));

  return jsonb_build_object('tenant_id', v_inv.tenant_id, 'company_name', v_name, 'role', v_inv.role,
                            'already', false, 'selected', v_select);
end;
$$;

revoke all on function public.accept_company_invite(uuid) from public, anon;
grant execute on function public.accept_company_invite(uuid) to authenticated, service_role;

commit;
