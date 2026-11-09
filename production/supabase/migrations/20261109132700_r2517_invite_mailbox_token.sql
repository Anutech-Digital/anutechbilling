-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.membership_invites') and attname = 'token_hash' and not attisdropped) and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_company_invite_by_token(text)') and prosrc like '%R-2517%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_company_invite(uuid)') and prosrc like '%R-2517%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.invite_existing_login(text,public.user_role,text)') and prosrc like '%R-2517%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.company_invite_by_token(text)') and prosrc like '%R-2517%')
-- deploy-key: r2517invitetoken
-- 20261109132700_r2517_invite_mailbox_token.sql
--
-- R-2517 (follow-up of R-2477's independent review, 6 Nov 2026): accepting an invite from ANOTHER
-- company needs proof of the invited MAILBOX, not only the login. Whoever controls the login could
-- accept before — e.g. the owner of the login's own company who once set a temporary password the
-- teammate never used (they sign in with Google); the forced change-password clears the "must
-- change" flag, so no "reset pending" check helps. Spec: docs/specs/memberships.md §6.3.
--
--   1. membership_invites.token_hash — sha256 (hex) of a single-use random token. The app makes the
--      token (32 random bytes), stores only the hash here and puts the token ONLY in the invite
--      email's link (/invites/accept#token=… — in the fragment, so never in a server log). Nobody
--      can read the token back from the database.
--   2. invite_existing_login(email, role, token_hash) — the R-2477 function plus the hash (renewing
--      an invite replaces the hash, so an older link stops working). The 2-argument form stays for
--      old callers and makes an invite WITHOUT a link (it can never be accepted).
--   3. company_invite_by_token(token) — what the accept page shows (company, role, address, state;
--      'blocked' + reason when an R-2477 check would refuse it) for the signed-in login. accept_company_invite_by_token(token) — the accept: the token must
--      match AND the signed-in login must be the invited login, plus every R-2477 check (MFA, not
--      expired, same sign-in address, profile email = sign-in address, sender still an active
--      owner). The token is single-use (accepted_at), expired / used / replaced ones are refused
--      with a next step.
--   4. accept_company_invite(uuid) — the old in-app Accept (no mailbox proof) now always refuses
--      and names the emailed link. It is kept (not dropped) because the deploy peeks of
--      20261105192420 / 20261106034600 look for it; dropping it would make a deploy re-run them.
--   5. my_company_invites() also returns the address the invite was sent to and whether it has a
--      link, so the banner says "Open the link we emailed to <address>" (no Accept button).
--
-- Bodies redefined from their LATEST versions: 20261106034600_r2477_rereview_accept_profile_email.sql
-- (invite_existing_login, accept_company_invite) and 20261105192420_r2477_review_consent_email_guard.sql
-- (my_company_invites). New functions: SECURITY DEFINER, search_path '', EXECUTE revoked from
-- public/anon.

begin;

-- ── 1. the hash of the emailed link's token ────────────────────────────────────────────
alter table public.membership_invites add column if not exists token_hash text;
create unique index if not exists membership_invites_token_hash_key
  on public.membership_invites (token_hash) where token_hash is not null;
comment on column public.membership_invites.token_hash is
  'R-2517: sha256 (hex) of the single-use token in the invite email link. The token itself is never stored.';

-- ── 2. invite with a link ──────────────────────────────────────────────────────────────
create or replace function public.invite_existing_login(p_email text, p_role public.user_role, p_token_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
/* R-2517: the R-2477 invite (owner + MFA, 30 calls an hour per login, audit line, nothing written
   in another company) plus the hash of the emailed link's token. A renewed invite gets the new hash,
   so the older email's link stops working. p_token_hash null = an invite without a link, which can
   never be accepted (the 2-argument form below). */
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
  if p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The invite link could not be made. Try again.' using errcode = '22023';
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

  insert into public.membership_invites as i (tenant_id, user_id, email, role, invited_by, token_hash)
  values (v_tid, v_user, v_email, p_role, v_uid, p_token_hash)
  on conflict (tenant_id, user_id) do update
     set email = excluded.email, role = excluded.role, invited_by = excluded.invited_by,
         token_hash = excluded.token_hash,
         created_at = now(), expires_at = now() + interval '7 days', accepted_at = null;
  return 'invited';
end;
$$;

revoke all on function public.invite_existing_login(text, public.user_role, text) from public, anon;
grant execute on function public.invite_existing_login(text, public.user_role, text) to authenticated, service_role;

/* The 2-argument form (R-2477 re-review) — kept for old callers; its invite has no link. */
create or replace function public.invite_existing_login(p_email text, p_role public.user_role)
returns text
language sql
security definer
set search_path = ''
as $$
  /* R-2517: replaces the R-2477 re-review body — same checks, no emailed link (cannot be accepted). */
  select public.invite_existing_login(p_email, p_role, null::text);
$$;

revoke all on function public.invite_existing_login(text, public.user_role) from public, anon;
grant execute on function public.invite_existing_login(text, public.user_role) to authenticated, service_role;

-- ── 3a. what the accept page shows ─────────────────────────────────────────────────────
create or replace function public.r2517_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  /* R-2517: only a token of the shape the app makes (base64url, 32-128 chars) is hashed. */
  select case when p_token ~ '^[A-Za-z0-9_-]{32,128}$'
              then encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex') end;
$$;

revoke all on function public.r2517_token_hash(text) from public, anon, authenticated;
grant execute on function public.r2517_token_hash(text) to service_role;

create or replace function public.r2517_invite_blocker(p_invite_id uuid, p_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
/* R-2517: why an OPEN invite (addressed to p_uid, not used, not expired) still cannot be accepted —
   null when it can. ONE rule for the accept page (company_invite_by_token) and the accept itself
   (accept_company_invite_by_token), so the page never offers an Accept that will be refused.
   Internal: callable by no app role. */
declare
  v_inv  public.membership_invites;
  v_name text;
begin
  select * into v_inv from public.membership_invites i where i.id = p_invite_id;
  select t.name into v_name from public.tenants t where t.id = v_inv.tenant_id;
  /* The invite was addressed to the login's sign-in address — if that address changed since, the
     invite is not for whoever holds the login now. */
  if not exists (select 1 from auth.users au where au.id = p_uid and lower(au.email) = v_inv.email) then
    return format('This invite was sent to another email address. Ask %s to invite the address you sign in with.', coalesce(v_name, 'the company'));
  end if;
  /* R-2477 re-review: the profile email must still be the login's own address. */
  if not exists (select 1 from public.users u
                  join auth.users au on au.id = u.id
                 where u.id = p_uid and lower(coalesce(u.email, '')) = lower(coalesce(au.email, ''))) then
    return 'Your profile email is not the address you sign in with, so this invite cannot be accepted from here. Next step: ask ResellerOS support to fix your profile email, then accept again.';
  end if;
  /* Whoever sent it must still be an active owner there. */
  if v_inv.invited_by is null or not exists (
       select 1 from public.tenant_memberships m
        where m.user_id = v_inv.invited_by and m.tenant_id = v_inv.tenant_id and m.role = 'owner'
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
    return format('This invite from %s is no longer valid (the person who sent it is no longer an owner there). Ask them to invite you again.', coalesce(v_name, 'that company'));
  end if;
  return null;
end;
$$;

revoke all on function public.r2517_invite_blocker(uuid, uuid) from public, anon, authenticated;
grant execute on function public.r2517_invite_blocker(uuid, uuid) to service_role;

create or replace function public.company_invite_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
/* R-2517: the accept page (/invites/accept#token=…) asks what the emailed link is for. Answers only
   to a signed-in login after two-step sign-in. state:
     'open'        — the invite is for this login and can be accepted;
     'blocked'     — for this login but cannot be accepted (sender no longer an owner, sign-in or
                     profile address changed): 'reason' says why and what to do;
     'other_login' — the link was sent to another address (the signed-in login is not the invitee);
     'used'        — already accepted; 'expired'; 'not_found' — no such link (replaced / withdrawn).
   The inviting company's name is shown only to the invited login itself. */
declare
  v_uid  uuid := public.current_user_id();
  v_hash text := public.r2517_token_hash(p_token);
  v_inv  public.membership_invites;
  v_name text;
  v_why  text;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.session_mfa_ok() then
    raise exception 'Finish two-step sign-in first: type the 6-digit code from your authenticator app, then open the invite link again.'
      using errcode = '42501';
  end if;
  if v_hash is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into v_inv from public.membership_invites i where i.token_hash = v_hash;
  if v_inv.id is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_inv.user_id <> v_uid then
    return jsonb_build_object('state', 'other_login', 'email', v_inv.email);
  end if;
  select t.name into v_name from public.tenants t where t.id = v_inv.tenant_id;
  if v_inv.accepted_at is null and v_inv.expires_at > now() then
    v_why := public.r2517_invite_blocker(v_inv.id, v_uid);
  end if;
  return jsonb_build_object(
    'state', case when v_inv.accepted_at is not null then 'used'
                  when v_inv.expires_at <= now() then 'expired'
                  when v_why is not null then 'blocked'
                  else 'open' end,
    'reason', v_why,
    'company_name', v_name, 'role', v_inv.role, 'email', v_inv.email, 'expires_at', v_inv.expires_at);
end;
$$;

revoke all on function public.company_invite_by_token(text) from public, anon;
grant execute on function public.company_invite_by_token(text) to authenticated, service_role;

-- ── 3b. the accept, with the emailed token ─────────────────────────────────────────────
create or replace function public.accept_company_invite_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
/* R-2517: the login accepts an invite from another company with the token from the invite email —
   proof that whoever accepts can read the invited mailbox, not only sign in to the login. Every
   R-2477 check stays. Adds (or re-opens) the membership with the invited role; if the login's
   selected company is no longer usable, a blank workspace of its own, or its personal account, the
   new company becomes the selected one. Nothing is deleted. Single use. */
declare
  v_uid    uuid := public.current_user_id();
  v_hash   text := public.r2517_token_hash(p_token);
  v_inv    public.membership_invites;
  v_name   text;
  v_why    text;
  v_sel    uuid;
  v_who    text;
  v_select boolean := false;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.session_mfa_ok() then
    raise exception 'Finish two-step sign-in first: type the 6-digit code from your authenticator app, then accept the invite.'
      using errcode = '42501';
  end if;

  if v_hash is not null then
    select * into v_inv from public.membership_invites i where i.token_hash = v_hash for update;
  end if;
  if v_inv.id is null then
    raise exception 'This invite link is not valid any more (the company sent a newer invite or withdrew it). Open the newest invite email, or ask the company to invite you again.'
      using errcode = 'P0002';
  end if;
  if v_inv.user_id <> v_uid then
    raise exception 'This invite link was sent to another email address. Sign out, sign in with the address the email was sent to, then open the link again.'
      using errcode = '42501';
  end if;
  select t.name into v_name from public.tenants t where t.id = v_inv.tenant_id;
  if v_inv.accepted_at is not null then
    raise exception 'This invite link was already used. If you joined %, pick it from the company switcher in the top bar.', coalesce(v_name, 'the company')
      using errcode = '42501';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invite from % has expired. Ask them to invite you again.', coalesce(v_name, 'that company')
      using errcode = '42501';
  end if;
  /* sign-in address unchanged, profile email = sign-in address (R-2477 re-review), sender still an
     active owner — the same rule the accept page shows */
  v_why := public.r2517_invite_blocker(v_inv.id, v_uid);
  if v_why is not null then
    raise exception '%', v_why using errcode = '42501';
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
    or exists (select 1 from public.tenants t where t.id = v_sel and t.workspace_kind = 'personal'));
  if v_select then
    perform public.r2477_select_membership(v_uid, v_inv.tenant_id);
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_inv.tenant_id, v_uid, 'team_invite.accepted', 'users', v_uid::text,
          left(format('%s accepted the emailed invite and joined as %s', coalesce(v_who, v_inv.email), v_inv.role), 200));

  return jsonb_build_object('tenant_id', v_inv.tenant_id, 'company_name', v_name, 'role', v_inv.role,
                            'selected', v_select);
end;
$$;

revoke all on function public.accept_company_invite_by_token(text) from public, anon;
grant execute on function public.accept_company_invite_by_token(text) to authenticated, service_role;

-- ── 4. the old in-app Accept: refused, names the emailed link ──────────────────────────
create or replace function public.accept_company_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
/* R-2517: replaces the R-2477 re-review accept. An invite from another company is accepted only
   through the link in the invite email (accept_company_invite_by_token) — signing in to the login
   is no proof of the mailbox. Kept so older deploy peeks still find it. */
begin
  raise exception 'Open the link in the invite email to accept this invite. No email? Ask the company to invite you again.'
    using errcode = '42501';
end;
$$;

revoke all on function public.accept_company_invite(uuid) from public, anon;
grant execute on function public.accept_company_invite(uuid) to authenticated, service_role;

-- ── 5. the banner's list: the address and whether it has a link ────────────────────────
drop function if exists public.my_company_invites();
create function public.my_company_invites()
returns table(invite_id uuid, tenant_id uuid, company_name text, role public.user_role,
              invited_at timestamptz, expires_at timestamptz, email text, has_link boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
/* R-2517 (from R-2477 review): the signed-in login's OWN open invites (not accepted, not expired,
   not already a member there), with the inviting company's name, the address the invite email went
   to, and whether it has an emailed link (an invite without one can never be accepted — ask again).
   Nothing before two-step sign-in. Never the token or its hash. */
declare
  v_uid uuid := public.current_user_id();
begin
  if v_uid is null or not public.session_mfa_ok() then
    return;
  end if;
  return query
    select i.id, i.tenant_id, t.name, i.role, i.created_at, i.expires_at, i.email, i.token_hash is not null
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

commit;
