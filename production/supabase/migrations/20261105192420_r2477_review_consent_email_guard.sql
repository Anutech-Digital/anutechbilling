-- deploy-peek: to_regclass('public.membership_invites') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_company_invite(uuid)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.guard_privileged_user_columns()') and prosrc like '%R-2477 review%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.merge_stranded_user_into_tenant(text,uuid,public.user_role)') and prosrc like '%R-2477 review%') and to_regprocedure('public.prepare_invite_for_existing_login(text)') is null
-- deploy-key: r2477reviewconsent
-- 20261105192420_r2477_review_consent_email_guard.sql
--
-- R-2477 independent review (BLOCK, 5 Nov 2026) — fixes on top of 20261105160300. Spec:
-- docs/specs/memberships.md §6.1. Coordinator decisions (Pardeep's delegation): explicit accept by
-- the login, never move/delete a workspace the login owns.
--
--   1. BLOCK, email takeover: guard_privileged_user_columns refuses a change of users.email by
--      anyone but the login itself while the login has a non-ended membership in another company.
--      (users.email is what Auth.js linkOAuthUser maps a Google sign-in to.)
--   2. Consent: a login that works in another company is invited into public.membership_invites
--      (invite_existing_login — owner + MFA, own hourly cap, audit line) and accepts it ITSELF:
--      my_company_invites() lists it, accept_company_invite(id) adds the membership. Claim refuses
--      such a login (a routine sign-in is no agreement). The inviting company sees only the address
--      it typed — list_stranded_auth_users no longer returns name / account age / last sign-in for a
--      login that has a profile, and only lists logins that work in no company right now.
--   3. Claim never moves out of, or deletes, a workspace the login OWNS — a membership instead.
--   4. prepare_invite_for_existing_login is dropped (it deleted other companies' accepted-invite
--      rows); nothing is deleted in another company any more.
--   Also: company_members().is_selected is shown to owners only; tenant_holds_business_records and
--   the Claim scan treat membership_invites as bookkeeping.
--
-- Bodies redefined from their LATEST versions:
--   guard_privileged_user_columns, list_stranded_auth_users, merge_stranded_user_into_tenant,
--   company_members   20261105160300_r2477_membership_invite_claim_remove.sql
--   tenant_holds_business_records   20261105000000_r2471_tenant_memberships.sql
-- New functions: SECURITY DEFINER, search_path pinned, EXECUTE revoked from public/anon.

begin;

-- ── 1. users.email of a multi-company login: only the login itself ────────────────────
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
  if new.email is distinct from old.email
     and old.id is distinct from v_uid
     and lower(coalesce(new.email, '')) is distinct from
         (select lower(au.email) from auth.users au where au.id = old.id)
     and (exists (select 1 from auth.users au where au.id = old.id and au.last_sign_in_at is not null)
          or exists (select 1 from public.tenant_memberships m
                      where m.user_id = old.id and m.tenant_id is distinct from new.tenant_id
                        and m.ended_at is null)
          /* an open invite from another company is the same lever (accept as them) */
          or exists (select 1 from public.membership_invites i
                      where i.user_id = old.id and i.tenant_id is distinct from new.tenant_id
                        and i.accepted_at is null and i.expires_at > now())) then
    raise exception 'This email is their sign-in identity (they have signed in, or they also work in or are invited to another company), so only they can change their email, never a company owner. Next step: ask them to contact ResellerOS support from their own login to change it.'
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
  'R-712 / R-2477: signed-in callers can never change users.tenant_id (one exception, R-2471/R-2477: a selection change of the row''s login onto its own active membership with exactly its values); role / manager_id / can_view_deals / gets_new_leads / is_active / access_ends_on (R-1896) / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite, and is changed by anyone but the login itself only back to the login''s own sign-in address, or for a login that never signed in and has no other company or open invite (R-2477). No auth.uid() / service_role passes through.';

-- ── 2. Invites for a login that works in another company: accepted by the login ──────────
create table if not exists public.membership_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  /* the address the inviting owner typed — all the inviting company ever sees of the login */
  email       text not null,
  role        public.user_role not null,
  invited_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  constraint membership_invites_tenant_user_key unique (tenant_id, user_id)
);
create index if not exists membership_invites_user_idx on public.membership_invites (user_id);
create index if not exists membership_invites_invited_by_idx on public.membership_invites (invited_by) where invited_by is not null;

comment on table public.membership_invites is
  'R-2477: an invite to a login that already works in another company. The login accepts it itself (accept_company_invite); the inviting company sees only the address it typed.';

alter table public.membership_invites enable row level security;
revoke all on public.membership_invites from public, anon, authenticated;
grant select, delete on public.membership_invites to authenticated;
grant all on public.membership_invites to service_role;

/* The inviting company's owner sees and withdraws its own invites. The invitee reads its invites
   only through my_company_invites() (company names are hidden by tenants RLS). */
drop policy if exists membership_invites_owner_read on public.membership_invites;
create policy membership_invites_owner_read on public.membership_invites
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner')));
drop policy if exists membership_invites_owner_delete on public.membership_invites;
create policy membership_invites_owner_delete on public.membership_invites
  for delete to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner')));
drop policy if exists membership_invites_service_role on public.membership_invites;
create policy membership_invites_service_role on public.membership_invites
  for all to service_role using (true) with check (true);

/* No log_row_change row trigger: it would copy the invitee's login id into the inviting company's
   activity log (readable by every member there). invite_existing_login and accept_company_invite
   write their own lines with the typed address only. */
drop trigger if exists membership_invites_activity on public.membership_invites;

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
     'no_company'     — the login works in no company right now: the plain invite + Claim path.
     'not_found'      — no login with this address: the plain invite path. */
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
    return 'not_found';
  end if;

  select u.id into v_user
    from auth.users au join public.users u on u.id = au.id
   where lower(au.email) = v_email
   limit 1;
  if v_user is null then
    return 'not_found';
  end if;

  if exists (select 1 from public.tenant_memberships m
              where m.user_id = v_user and m.tenant_id = v_tid and m.ended_at is null) then
    return 'already_member';
  end if;
  if not exists (select 1 from public.tenant_memberships m
                  where m.user_id = v_user and m.ended_at is null) then
    return 'no_company';
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

create or replace function public.my_company_invites()
returns table(invite_id uuid, tenant_id uuid, company_name text, role public.user_role,
              invited_at timestamptz, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
/* R-2477 review: the signed-in login's OWN open invites (not accepted, not expired, not already a
   member there), with the inviting company's name. Nothing before two-step sign-in. */
declare
  v_uid uuid := public.current_user_id();
begin
  if v_uid is null or not public.session_mfa_ok() then
    return;
  end if;
  return query
    select i.id, i.tenant_id, t.name, i.role, i.created_at, i.expires_at
      from public.membership_invites i
      join public.tenants t on t.id = i.tenant_id
     where i.user_id = v_uid and i.accepted_at is null and i.expires_at > now()
       and not exists (select 1 from public.tenant_memberships m
                        where m.user_id = v_uid and m.tenant_id = i.tenant_id and m.ended_at is null)
     order by i.created_at desc;
end;
$$;

revoke all on function public.my_company_invites() from public, anon;
grant execute on function public.my_company_invites() to authenticated, service_role;

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

-- ── 4. prepare_invite_for_existing_login is gone (it deleted other companies' rows) ───────
drop function if exists public.prepare_invite_for_existing_login(text);

-- ── bookkeeping, not business data ──────────────────────────────────────────────────────
create or replace function public.tenant_holds_business_records(p_tenant uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tbl text;
  v_hit boolean;
begin
  /* R-2469: same tables and carve-outs as merge_stranded_user_into_tenant (R-721/R-1834/
     R-1922) — but a yes/no, so one EXISTS per table and stop at the first hit (no full counts). */
  for v_tbl in
    select c.table_name
      from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name   = c.table_name
     and t.table_type   = 'BASE TABLE'
   where c.table_schema = 'public'
     and c.column_name  = 'tenant_id'
     and c.table_name not in (
           'users', 'activity_log', 'team_invites', 'tenant_secrets',
           'document_series', 'customer_number_seq', 'user_google_tokens',
           'tenant_domains', 'join_requests', 'email_log', 'api_keys', 'tenant_memberships',
           'membership_invites'
         )
  loop
    execute format('select exists (select 1 from public.%I where tenant_id = $1%s)',
                   v_tbl,
                   case when v_tbl = 'bank_accounts'
                        then ' and not (is_default_petty_cash and opening_balance = 0)'
                        when v_tbl = 'automation_jobs'
                        then ' and job <> ''customer_messages'''
                        else '' end)
      into v_hit using p_tenant;
    if v_hit then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- ── 2. Claim list: email only, and only logins that work in no company ──────────────────
create or replace function public.list_stranded_auth_users()
returns table(email text, full_name text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone)
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_trusted boolean;
  v_tid     uuid;
begin
  /* R-721: trusted server paths only (R-454 rule) see the whole platform. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));

  if not v_trusted then
    /* R-1615: current_tenant_id() + current_user_has_role() — active, MFA step done. */
    v_tid := public.current_tenant_id();
    if v_tid is null then
      raise exception 'Seeing who is waiting to join needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
        using errcode = '28000';
    end if;
    if not public.current_user_has_role('owner') then
      raise exception 'Only an active workspace owner can see this.' using errcode = '42501';
    end if;
  end if;

  return query
    select au.email::text,
           /* R-2477 review: for a login that already has a profile, this company sees only the
              address it typed — never their name, account age or last sign-in. */
           case when exists (select 1 from public.users u where u.id = au.id) then null
                else coalesce(
                       nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
                       nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
                       split_part(au.email, '@', 1))
           end::text,
           case when exists (select 1 from public.users u where u.id = au.id) then null else au.created_at end,
           case when exists (select 1 from public.users u where u.id = au.id) then null else au.last_sign_in_at end
      from auth.users au
     where au.email is not null
       and (
         (not exists (select 1 from public.users u where u.id = au.id)
          and (v_trusted
               or exists (select 1 from public.team_invites i
                           where i.tenant_id = v_tid and i.accepted_at is null
                             and lower(i.email) = lower(au.email)
                             and au.last_sign_in_at >= i.created_at)
               or exists (select 1 from public.join_requests jr
                           where jr.tenant_id = v_tid and jr.status = 'pending_approval'
                             and (jr.auth_user_id = au.id or lower(jr.email) = lower(au.email)))))
         /* R-2477: a login that works in NO company right now (removed everywhere, or removed from
            this one), invited HERE and signed in after the invite. A login that works in another
            company accepts the invite itself (membership_invites) — never claimed. */
         or (not v_trusted
             and exists (select 1 from public.users u where u.id = au.id)
             and not exists (select 1 from public.tenant_memberships m
                              where m.user_id = au.id and m.ended_at is null)
             and exists (select 1 from public.team_invites i
                          where i.tenant_id = v_tid and i.accepted_at is null
                            and lower(i.email) = lower(au.email)
                            and au.last_sign_in_at >= i.created_at)))
     order by 4 desc nulls last, 3 desc nulls last;
end;
$function$;

-- ── 2 + 3. Claim: never a login of another company, never an owned workspace ────────────
create or replace function public.merge_stranded_user_into_tenant(
  p_email text, p_tenant_id uuid, p_role user_role default 'support'::user_role)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
/* R-2477 review: a login that works in ANOTHER company is never claimed — they accept the
   invite themselves (accept_company_invite). A workspace the login OWNS is never moved or
   deleted. Earlier: Claim activates a MEMBERSHIP. A login already in a real company (other members, any
   business record, or another active membership) gets a membership here and keeps the other
   company; an ended membership here is re-opened. Only a blank accidental workspace is still
   moved + removed. The other company's name is never returned for that case. */
declare
  v_email        text := lower(btrim(p_email));
  v_trusted      boolean;
  v_dest_name    text;
  v_auth_id      uuid;
  v_auth_name    text;
  v_old_tid      uuid;
  v_old_name     text;
  v_old_users    int;
  v_sql          text;
  v_holdings     jsonb;
  v_rows         bigint;
  v_action       text;
  v_deleted      boolean := false;
  v_member_id    uuid;
  v_generic      text;
  v_last_sign_in timestamptz;
  v_real         boolean;
  v_reopen       boolean;
begin
  v_generic := format(
    'Cannot claim %s. Only someone with a pending invite or join request to your workspace, who has signed in at least once, can be claimed. Invite them from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.',
    v_email);

  /* R-721: trusted server paths (R-454 rule) act as platform admin. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));

  -- ── 1. The caller must be an ACTIVE owner of the destination workspace ──
  --    R-1615: current_tenant_id() + current_user_has_role() (active AND MFA step done).
  if not v_trusted then
    if public.current_tenant_id() is null then
      raise exception
        'Claiming a colleague needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
        using errcode = '28000';
    end if;
    if p_tenant_id is distinct from public.current_tenant_id()
       or not public.current_user_has_role('owner') then
      raise exception
        'Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.'
        using errcode = '42501';
    end if;
  end if;

  select t.name into v_dest_name from public.tenants t where t.id = p_tenant_id;
  if v_dest_name is null then
    raise exception 'That workspace does not exist.' using errcode = 'P0002';
  end if;

  -- ── 2. Already a member here (membership not ended)? Only the role may need correcting. ──
  select m.user_id into v_member_id
    from public.tenant_memberships m
    join public.users u on u.id = m.user_id
   where m.tenant_id = p_tenant_id and m.ended_at is null and lower(u.email) = v_email
   limit 1;

  if v_member_id is not null then
    update public.tenant_memberships
       set role = p_role, updated_at = now()
     where user_id = v_member_id and tenant_id = p_tenant_id and role <> p_role;
    v_action  := case when found then 'role_updated' else 'already_member' end;
    v_auth_id := v_member_id;
    select coalesce(nullif(btrim(u.full_name), ''), split_part(v_email, '@', 1))
      into v_auth_name from public.users u where u.id = v_member_id;
  else
    select au.id,
           coalesce(
             nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
             split_part(au.email, '@', 1)
           ),
           au.last_sign_in_at
      into v_auth_id, v_auth_name, v_last_sign_in
      from auth.users au
     where lower(au.email) = v_email
     limit 1;

    -- ── 3. R-721: they must have asked, or been asked, to join THIS workspace.
    --    A join request is their own act. An invite is the owner's act, so it counts only
    --    once they have signed in AFTER it was sent (their half of the handshake) — an owner
    --    cannot invite someone else's address and pull them in the same minute.
    --    "No account" and "no request" give the SAME words: no existence oracle.
    if v_auth_id is null
       or (not v_trusted and not (
            exists (select 1 from public.join_requests jr
                     where jr.tenant_id = p_tenant_id and jr.status = 'pending_approval'
                       and (jr.auth_user_id = v_auth_id or lower(jr.email) = v_email))
         or exists (select 1 from public.team_invites i
                     where i.tenant_id = p_tenant_id and i.accepted_at is null
                       and lower(i.email) = v_email
                       and v_last_sign_in >= i.created_at))) then
      raise exception '%', v_generic using errcode = '42501';
    end if;

    select u.tenant_id into v_old_tid from public.users u where u.id = v_auth_id for update;

    /* R-2477 review (consent): a routine sign-in is no agreement to join another company. */
    if not v_trusted and exists (select 1 from public.tenant_memberships m
                                  where m.user_id = v_auth_id and m.tenant_id <> p_tenant_id
                                    and m.ended_at is null)
       /* their own join request to THIS company is their agreement */
       and not exists (select 1 from public.join_requests jr
                        where jr.tenant_id = p_tenant_id and jr.status = 'pending_approval'
                          and (jr.auth_user_id = v_auth_id or lower(jr.email) = v_email)) then
      raise exception 'Cannot claim %: they already work in another company on ResellerOS. Invite them from Team → Invite member: they see your invite at the top of their app and accept it themselves.', v_email
        using errcode = '42501';
    end if;

    -- 3b. Truly stranded: an auth account with no profile anywhere.
    if v_old_tid is null and not exists (select 1 from public.users u where u.id = v_auth_id) then
      insert into public.users (id, tenant_id, email, full_name, initials, role, color)
      values (
        v_auth_id, p_tenant_id, v_email, v_auth_name,
        upper(left(regexp_replace(coalesce(v_auth_name, v_email), '[^A-Za-z]', '', 'g'), 2)),
        p_role, 'indigo'
      );
      v_action := 'attached';
    else
      /* R-2477: is the selected workspace a real company? Anyone else with a membership there,
         another active membership of this login anywhere, or any business record. Selected
         HERE (their membership here ended) counts as real: nothing to move. */
      select (v_old_tid = p_tenant_id)
          or exists (select 1 from public.tenant_memberships m
                      where m.tenant_id = v_old_tid and m.user_id <> v_auth_id and m.ended_at is null)
          or exists (select 1 from public.users u2 where u2.tenant_id = v_old_tid and u2.id <> v_auth_id)
          or exists (select 1 from public.tenant_memberships m
                      where m.user_id = v_auth_id and m.tenant_id <> v_old_tid and m.ended_at is null)
          /* R-2477 review: a workspace with any owner (a membership that says owner, even an ended
             one, or a users row with role owner) is never moved out of or deleted — a membership is
             added instead. Only an ownerless blank leftover may still be cleaned up. */
          or exists (select 1 from public.tenant_memberships m
                      where m.tenant_id = v_old_tid and m.role = 'owner')
          or exists (select 1 from public.users u3 where u3.tenant_id = v_old_tid and u3.role = 'owner')
        into v_real;

      if not v_real then
        -- Count everything that is not bookkeeping. Fail-safe: unlisted table = data.
        select string_agg(
                 format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L%s',
                        c.table_name, c.table_name, v_old_tid,
                        case when c.table_name = 'bank_accounts'
                             then ' and not (is_default_petty_cash and opening_balance = 0)'
                             when c.table_name = 'automation_jobs'
                             then ' and job <> ''customer_messages'''
                             else '' end),
                 ' union all ')
          into v_sql
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema
           and t.table_name   = c.table_name
           and t.table_type   = 'BASE TABLE'
         where c.table_schema = 'public'
           and c.column_name  = 'tenant_id'
           and c.table_name not in (
                 'users', 'activity_log', 'team_invites', 'tenant_secrets',
                 'document_series', 'customer_number_seq', 'user_google_tokens',
                 'tenant_domains', 'join_requests', 'email_log', 'api_keys', 'tenant_memberships',
                 'membership_invites'
               );

        execute format(
          'select coalesce(jsonb_object_agg(tbl, n) filter (where n > 0), ''{}''::jsonb),
                  coalesce(sum(n), 0) from (%s) s', v_sql)
          into v_holdings, v_rows;
        v_real := v_rows > 0;
      end if;

      if v_real and exists (select 1 from public.tenant_memberships m
                             where m.user_id = v_auth_id and m.tenant_id = p_tenant_id and m.ended_at is null) then
        -- Already a member here (users.email differs from the login email): role fix only, as before.
        update public.tenant_memberships
           set role = p_role, updated_at = now()
         where user_id = v_auth_id and tenant_id = p_tenant_id and role <> p_role;
        v_action := case when found then 'role_updated' else 'already_member' end;
      elsif v_real then
        -- 3c. R-2477: a membership HERE; their other company stays theirs.
        select exists (select 1 from public.tenant_memberships m
                        where m.user_id = v_auth_id and m.tenant_id = p_tenant_id)
          into v_reopen;
        insert into public.tenant_memberships as m
          (user_id, tenant_id, role, is_active, created_by)
        values (v_auth_id, p_tenant_id, p_role, true, auth.uid())
        on conflict (user_id, tenant_id) do update
           set role = excluded.role, is_active = true, access_ends_on = null,
               manager_id = null, can_view_deals = false, gets_new_leads = false,
               ended_at = null, end_reason = null, ended_by = null, updated_at = now();
        v_action := case when v_reopen then 'rejoined' else 'added' end;

        /* Their selected company no longer usable (removed / switched off / expired, or they
           were removed from HERE earlier) → this membership becomes the selected one. */
        if not exists (
             select 1 from public.tenant_memberships m
               join public.users u on u.id = m.user_id and u.tenant_id = m.tenant_id
              where m.user_id = v_auth_id and m.tenant_id <> p_tenant_id
                and m.is_active and m.ended_at is null and u.is_active
                and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
          perform public.r2477_select_membership(v_auth_id, p_tenant_id);
        end if;
      else
        -- 3d. A blank accidental workspace (only them, no records): move + remove it (R-721).
        select t.name, (select count(*) from public.users u2 where u2.tenant_id = t.id)
          into v_old_name, v_old_users
          from public.tenants t where t.id = v_old_tid;

        update public.users
           set tenant_id = p_tenant_id,
               role      = p_role,
               email     = v_email
         where id = v_auth_id;

        delete from public.tenants where id = v_old_tid;
        v_deleted := true;
        v_action  := 'moved';
      end if;
    end if;
  end if;

  -- ── 4. Any open request / invite from this person is now settled ────────
  update public.join_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and status = 'pending_approval';

  update public.team_invites
     set accepted_at = now()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and accepted_at is null;

  -- ── 5. Visible in the destination workspace, not just in a server log ───
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (
    p_tenant_id, auth.uid(), v_action, 'user', v_auth_id::text,
    format('Claimed %s into %s as %s%s',
           v_email, coalesce(v_dest_name, 'this workspace'), p_role,
           case when v_deleted then format(' (removed empty workspace "%s")', v_old_name)
                when v_action in ('added', 'rejoined') then ' (they keep any other company they work in)'
                else '' end)
  );

  return jsonb_build_object(
    'action',             v_action,
    'email',              v_email,
    'full_name',          v_auth_name,
    'auth_user_id',       v_auth_id,
    'role',               p_role,
    'tenant_id',          p_tenant_id,
    'tenant_name',        v_dest_name,
    'old_tenant_name',    v_old_name,
    'old_tenant_deleted', v_deleted
  );
end;
$function$;

-- ── company_members: "working elsewhere right now" for owners only ──────────────────────
create or replace function public.company_members()
returns table(
  id uuid, full_name text, email text, initials text, color text,
  role public.user_role, is_active boolean, can_view_deals boolean, manager_id uuid,
  gets_new_leads boolean, access_ends_on date, created_at timestamptz, is_selected boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
/* R-2477: members of the caller's SELECTED company — from tenant_memberships (not ended), so a
   member whose selected company is elsewhere is still listed. Same audience as users_tenant_read
   (any member with a current company). Only this company's rows; nothing about other companies. */
declare
  v_tid uuid := public.current_tenant_id();
  v_owner boolean;
begin
  if v_tid is null then
    return;
  end if;
  v_owner := public.current_user_has_role('owner');
  return query
    select u.id, u.full_name, u.email, u.initials, u.color, m.role, m.is_active, m.can_view_deals,
           m.manager_id, m.gets_new_leads, m.access_ends_on, m.created_at,
           /* working in THIS company right now (their selected company) */
           /* R-2477 review: only an owner learns that a colleague is working elsewhere right now */
           case when v_owner then (u.tenant_id = m.tenant_id) end
      from public.tenant_memberships m
      join public.users u on u.id = m.user_id
     where m.tenant_id = v_tid and m.ended_at is null
     order by m.created_at, u.id;
end;
$$;

revoke all on function public.company_members() from public, anon;
grant execute on function public.company_members() to authenticated, service_role;

commit;
