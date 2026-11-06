-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_company_invite(uuid)') and prosrc like '%R-2477 re-review%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.invite_existing_login(text,public.user_role)') and prosrc like '%R-2477 re-review%')
-- deploy-key: r2477rereview
-- 20261106034600_r2477_rereview_accept_profile_email.sql
--
-- R-2477 re-review (BLOCK, 6 Nov 2026) — two levers to act as an invited login before it accepts.
-- Spec: docs/specs/memberships.md §6.2. The temporary-password route (app side) now also refuses a
-- login with an open invite from another company; Auth.js linkOAuthUser no longer links a Google
-- sign-in through a profile email that differs from a never-signed-in login's own address.
--
--   1. accept_company_invite refuses when the login's profile email (users.email) is no longer its
--      sign-in address (auth.users.email) — an owner may set it for a never-signed-in teammate.
--   2. invite_existing_login answers 'plain' for both "no login" and "works in no company" (was
--      not_found / no_company), so it does not say whether an address has a login.
--
-- Bodies redefined from their LATEST versions: 20261105192420_r2477_review_consent_email_guard.sql.

begin;

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
