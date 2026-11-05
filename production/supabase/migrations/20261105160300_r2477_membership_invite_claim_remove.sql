-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.remove_company_member(uuid)') and prosrc like '%R-2477%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.merge_stranded_user_into_tenant(text,uuid,public.user_role)') and prosrc like '%R-2477%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.guard_privileged_user_columns()') and prosrc like '%R-2477%')
-- deploy-key: r2477membershipremove
-- 20261105160300_r2477_membership_invite_claim_remove.sql
--
-- R-2477 (5 Nov 2026) — R-2471 slice 3: Invite / Claim / "Remove from this company" work on
-- memberships. Spec: docs/specs/memberships.md §6.
--
--   1. prepare_invite_for_existing_login(email) — Team → Invite for an address that already has a
--      login in ANOTHER company no longer refuses: the other company's ACCEPTED (used) invite row,
--      which only blocks the one-row-per-address index, is cleared so this company's invite can be
--      written. Answers 'already_member' when the login is already an active member HERE.
--   2. list_stranded_auth_users() also lists an existing login that is not a member here, has an
--      open invite here and signed in after it (their half of the R-721 handshake).
--   3. merge_stranded_user_into_tenant (Claim a colleague) — a login that belongs to a real company
--      gets a membership HERE (new, or an ended one re-opened) instead of being refused; they keep
--      their other company. A blank accidental workspace is still moved + removed as before. When
--      the login's selected company is no longer usable (removed / off / expired) the new
--      membership becomes the selected one.
--   4. remove_company_member(user) — ends ONLY this company's membership (owner only, MFA, never
--      yourself, never the last active owner; owners locked so two owners cannot remove each other
--      at once). Audit line in this company. The users row and every FK stay. If it was the
--      login's selected company, the selection moves to their newest other active membership, or
--      to none (mirror → users.is_active false → current_tenant_id() NULL).
--   5. company_members() / update_company_member(user, patch) — the Team page lists and edits the
--      company's MEMBERSHIPS (a member whose selected company is elsewhere is still on the list and
--      can still be edited); edits of the selected company reach users through the R-2471 mirror.
--   6. users_tenant_delete is dropped: an owner deleting a teammate's users row deleted the login's
--      memberships in EVERY company (spec §4). Remove replaces it.
--   7. guard_privileged_user_columns: the R-2471 switch branch now accepts a selection change for
--      the ROW's login (not only the caller's own) onto that login's active membership with exactly
--      its values — the definer move above. RLS (users_tenant_update WITH CHECK tenant =
--      current_tenant_id()) still keeps every direct PATCH inside the caller's company.
--
-- Bodies redefined from their LATEST versions:
--   guard_privileged_user_columns     20261105000000_r2471_tenant_memberships.sql
--   merge_stranded_user_into_tenant   20261105000000_r2471_tenant_memberships.sql
--   list_stranded_auth_users          20261018225100_r1615_definer_tenant_gate.sql
-- Every new function: SECURITY DEFINER, search_path pinned, EXECUTE revoked from public/anon.
-- The two "trusted server path" checks are written with public.current_request_role() (R-2487 —
-- maps every Cloud SQL gateway login by session_user), never a new raw auth.role() list.

begin;

-- ── 7. guard: a selection move onto the row login's own membership ──────────────────
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
  'R-712: signed-in callers can never change users.tenant_id (one exception, R-2471/R-2477: a selection change of the row''s login onto its own active membership with exactly its values); role / manager_id / can_view_deals / gets_new_leads / is_active / access_ends_on (R-1896) / email / employee_id need an ACTIVE owner of the SAME tenant (one exception: linking your own login to your own employee record, set_my_employee rules). employee_id must be in-tenant and unlinked; email may not collide with another login or another tenant''s pending invite. No auth.uid() / service_role passes through.';

-- ── internal: move a login's selection onto one of its active memberships ────────────
create or replace function public.r2477_select_membership(p_user uuid, p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477: internal (no grant to any app role). Remove / Claim use it to change ANOTHER login's
   selected company onto that login's own active membership — the same UPDATE switch_company does
   (R-2471), and the same activity-log rule (R-2476): the new company's log row names only the new
   company and role, never the old company's uuid / role / employee. */
declare
  v_m       public.tenant_memberships;
  v_old_tid uuid;
  v_name    text;
  v_new_co  text;
  v_log     bigint;
  v_mark    bigint;
begin
  select * into v_m from public.tenant_memberships m
   where m.user_id = p_user and m.tenant_id = p_tenant
     and m.is_active and m.ended_at is null
     and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
     for share;
  if v_m.id is null then
    raise exception 'Could not move them to their other company (that membership is no longer active). Refresh the Team page and try again.' using errcode = 'P0002';
  end if;

  select u.tenant_id, u.full_name into v_old_tid, v_name
    from public.users u where u.id = p_user for update;
  select coalesce(max(a.id), 0) into v_mark from public.activity_log a;

  update public.users
     set tenant_id = v_m.tenant_id, role = v_m.role, is_active = true,
         access_ends_on = v_m.access_ends_on, employee_id = v_m.employee_id,
         manager_id = v_m.manager_id, can_view_deals = v_m.can_view_deals,
         gets_new_leads = v_m.gets_new_leads
   where id = p_user;

  if v_old_tid is distinct from v_m.tenant_id then
    select t.name into v_new_co from public.tenants t where t.id = v_m.tenant_id;
    select max(a.id) into v_log from public.activity_log a
     where a.id > v_mark and a.tenant_id = v_m.tenant_id and a.action = 'update'
       and a.entity = 'users' and a.entity_id = p_user::text;
    if v_log is not null then
      delete from public.activity_log a
       where a.id > v_mark and a.id <> v_log and a.tenant_id = v_m.tenant_id and a.action = 'update'
         and a.entity = 'users' and a.entity_id = p_user::text;
      update public.activity_log a
         set label = left(coalesce(v_name, '') || ' now works in this company', 120),
             changes = jsonb_build_object(
               'company', jsonb_build_object('old', null, 'new', v_new_co),
               'role',    jsonb_build_object('old', null, 'new', v_m.role::text))
       where a.id = v_log;
    end if;
  end if;
end;
$$;

revoke all on function public.r2477_select_membership(uuid, uuid) from public, anon, authenticated;

-- ── 1. Invite of a login that already has another company ──────────────────────────
create or replace function public.prepare_invite_for_existing_login(p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477: Team → Invite calls this (session client) when release_stale_team_invite answered
   'member_elsewhere'. team_invites keeps ONE row per address across every company, so the other
   company's ACCEPTED invite — history only; the membership is the record now — would block this
   company's invite. It is deleted without a line in that company (it held nothing back, and a
   line would tell them another company invited their member). A live (not accepted) invite
   elsewhere is left alone: the route's insert then answers "open invite from another company".
   'already_member' — the login is already an active member of the caller's company.
   'ready'          — the invite can be written. Never names any other company. */
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tid   uuid;
  v_user  uuid;
  v_uid   uuid := public.current_user_id();
  v_n     int;
begin
  v_tid := public.current_tenant_id();
  if v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an active company owner can invite. Sign in again (with the authenticator code if you use one) and retry.'
      using errcode = '42501';
  end if;
  /* Same hourly cap as the address check that comes before it (R-2483: 30 per login), so a script
     calling this straight from the browser is capped too. */
  if (select count(*) from public.activity_log a
       where a.user_id = v_uid and a.action = 'team_invite.address_checked'
         and a.created_at > now() - interval '1 hour') > 30 then
    raise exception 'Too many invites in the last hour. Try again later.' using errcode = '54000';
  end if;
  if v_email = '' then
    return 'ready';
  end if;

  select u.id into v_user from public.users u where lower(u.email) = v_email limit 1;
  if v_user is null then
    return 'ready';
  end if;

  if exists (select 1 from public.tenant_memberships m
              where m.user_id = v_user and m.tenant_id = v_tid and m.ended_at is null) then
    return 'already_member';
  end if;

  delete from public.team_invites i
   where lower(i.email) = v_email and i.tenant_id <> v_tid and i.accepted_at is not null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    /* Audit in the CALLER's company only (never names the other one). */
    insert into public.activity_log (tenant_id, user_id, action, entity, label)
    values (v_tid, v_uid, 'stale_invite_released', 'team_invite',
            left(format('Cleared an old, already-used invite for %s held by another company so it could be invited here', v_email), 200));
  end if;
  return 'ready';
end;
$$;

revoke all on function public.prepare_invite_for_existing_login(text) from public, anon;
grant execute on function public.prepare_invite_for_existing_login(text) to authenticated, service_role;

-- ── 2. Claim list: also an existing login invited here that signed in after it ──────
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
           coalesce(
             nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
             split_part(au.email, '@', 1)
           )::text,
           au.created_at,
           au.last_sign_in_at
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
         /* R-2477: a login that already works in another company (or was removed from this one),
            invited HERE and signed in after the invite. */
         or (not v_trusted
             and exists (select 1 from public.users u where u.id = au.id)
             and not exists (select 1 from public.tenant_memberships m
                              where m.user_id = au.id and m.tenant_id = v_tid and m.ended_at is null)
             and exists (select 1 from public.team_invites i
                          where i.tenant_id = v_tid and i.accepted_at is null
                            and lower(i.email) = lower(au.email)
                            and au.last_sign_in_at >= i.created_at)))
     order by au.last_sign_in_at desc nulls last, au.created_at desc;
end;
$function$;

-- ── 3. Claim a colleague: a membership, not a move, for someone in a real company ───
create or replace function public.merge_stranded_user_into_tenant(
  p_email text, p_tenant_id uuid, p_role user_role default 'support'::user_role)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
/* R-2477: Claim activates a MEMBERSHIP. A login already in a real company (other members, any
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
                 'tenant_domains', 'join_requests', 'email_log', 'api_keys', 'tenant_memberships'
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

-- ── 4. Remove from this company ─────────────────────────────────────────────────────
create or replace function public.remove_company_member(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477: end ONLY this company's membership of p_user_id. Owner only (active membership, MFA
   step done — current_user_has_role), never yourself, never the last active owner. The users row
   and every FK stay (their records keep their author). Audit line in this company. If this was
   their selected company, the selection moves to their newest other active membership, or to
   none. Never says whether they have another company. */
declare
  v_uid    uuid := public.current_user_id();
  v_tid    uuid;
  v_m      public.tenant_memberships;
  v_sel    uuid;
  v_name   text;
  v_email  text;
  v_next   uuid;
begin
  v_tid := public.current_tenant_id();
  if v_uid is null or v_tid is null then
    raise exception 'Removing someone needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only an owner can remove someone from this company. Ask an owner to do it on the Team page.'
      using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'Pick the person to remove.' using errcode = '22023';
  end if;
  if p_user_id = v_uid then
    raise exception 'You cannot remove yourself. Ask another owner of this company to do it.'
      using errcode = '42501';
  end if;

  /* Every owner membership of this company, in one fixed order: two owners removing each other at
     the same moment wait for one another, so the second one sees the first one's result. */
  perform 1 from public.tenant_memberships m
   where m.tenant_id = v_tid and m.role = 'owner' and m.ended_at is null
   order by m.user_id
   for update;
  if not exists (select 1 from public.tenant_memberships m
                  where m.user_id = v_uid and m.tenant_id = v_tid and m.role = 'owner'
                    and m.is_active and m.ended_at is null
                    and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
    raise exception 'Only an owner can remove someone from this company. Ask an owner to do it on the Team page.'
      using errcode = '42501';
  end if;

  select * into v_m from public.tenant_memberships m
   where m.user_id = p_user_id and m.tenant_id = v_tid and m.ended_at is null
   for update;
  if v_m.id is null then
    raise exception 'That person is not a member of this company (they may have been removed already). Refresh the Team page.'
      using errcode = 'P0002';
  end if;

  if v_m.role = 'owner' and not exists (
       select 1 from public.tenant_memberships m
        where m.tenant_id = v_tid and m.role = 'owner' and m.user_id <> p_user_id
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
    raise exception 'This is the last active owner of this company, so they cannot be removed. Make someone else an owner first.'
      using errcode = '42501';
  end if;

  select u.tenant_id, coalesce(nullif(btrim(u.full_name), ''), u.email), lower(u.email)
    into v_sel, v_name, v_email
    from public.users u where u.id = p_user_id for update;

  if v_sel = v_tid then
    select m.tenant_id into v_next from public.tenant_memberships m
     where m.user_id = p_user_id and m.tenant_id <> v_tid
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
     order by m.created_at desc, m.tenant_id
     limit 1;
    if v_next is not null then
      perform public.r2477_select_membership(p_user_id, v_next);
    end if;
  end if;

  /* Ending it: the mirror (R-2471) turns users.is_active off when this is still the selected
     company (no other membership) — current_tenant_id() is then NULL and R-722 signs them out. */
  update public.tenant_memberships
     set ended_at = now(), end_reason = 'removed', ended_by = v_uid, updated_at = now()
   where id = v_m.id;

  /* This company's ACCEPTED invite for them is history now; left in place it would block the way
     back (invite again → Claim needs an open invite, and the address index allows one row). */
  delete from public.team_invites i
   where i.tenant_id = v_tid and lower(i.email) = v_email and i.accepted_at is not null;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tid, v_uid, 'member_removed', 'users', p_user_id::text,
          left('Removed ' || coalesce(v_name, 'a member') || ' from this company', 200));

  return jsonb_build_object('removed', p_user_id);
end;
$$;

revoke all on function public.remove_company_member(uuid) from public, anon;
grant execute on function public.remove_company_member(uuid) to authenticated, service_role;

-- ── 5. The Team list and edits work on memberships ──────────────────────────────────
drop function if exists public.company_members();   -- new in this file; re-run safe (return shape)
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
begin
  if v_tid is null then
    return;
  end if;
  return query
    select u.id, u.full_name, u.email, u.initials, u.color, m.role, m.is_active, m.can_view_deals,
           m.manager_id, m.gets_new_leads, m.access_ends_on, m.created_at,
           /* working in THIS company right now (their selected company) */
           (u.tenant_id = m.tenant_id)
      from public.tenant_memberships m
      join public.users u on u.id = m.user_id
     where m.tenant_id = v_tid and m.ended_at is null
     order by m.created_at, u.id;
end;
$$;

revoke all on function public.company_members() from public, anon;
grant execute on function public.company_members() to authenticated, service_role;

create or replace function public.update_company_member(p_user_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
/* R-2477: owner edits a member's role / reporting manager / deals access / new-lead turn IN THIS
   COMPANY (their membership). The selected company's values reach users through the R-2471
   mirror. Never the last active owner demoted; a manager must be a member of this company. */
declare
  v_uid  uuid := public.current_user_id();
  v_tid  uuid;
  v_m    public.tenant_memberships;
  v_key  text;
  v_role public.user_role;
  v_mgr  uuid;
begin
  v_tid := public.current_tenant_id();
  if v_uid is null or v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access or new-lead turn. Ask an owner to do it on the Team page.'
      using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to change — pick a new role, reporting manager, deals access or new-lead turn first.' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('role', 'manager_id', 'can_view_deals', 'gets_new_leads') then
      raise exception 'Only the role, reporting manager, deals access and new-lead turn can be changed on the Team page (not %).', v_key using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'role' then
    if not exists (select 1 from pg_enum e
                    where e.enumtypid = 'public.user_role'::regtype and e.enumlabel = (p_patch ->> 'role')) then
      raise exception 'Pick a role from the list.' using errcode = '22023';
    end if;
    v_role := (p_patch ->> 'role')::public.user_role;
    /* Owners locked in one order (see remove_company_member). */
    perform 1 from public.tenant_memberships m
     where m.tenant_id = v_tid and m.role = 'owner' and m.ended_at is null
     order by m.user_id for update;
  end if;

  select * into v_m from public.tenant_memberships m
   where m.user_id = p_user_id and m.tenant_id = v_tid and m.ended_at is null
   for update;
  if v_m.id is null then
    raise exception 'That person is not a member of this company. Refresh the Team page.'
      using errcode = 'P0002';
  end if;

  if p_patch ? 'role' and v_m.role = 'owner' and v_role <> 'owner' and not exists (
       select 1 from public.tenant_memberships m
        where m.tenant_id = v_tid and m.role = 'owner' and m.user_id <> p_user_id
          and m.is_active and m.ended_at is null
          and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())) then
    raise exception 'This is the last active owner of this company. Make someone else an owner first.'
      using errcode = '42501';
  end if;

  if p_patch ? 'manager_id' then
    v_mgr := nullif(p_patch ->> 'manager_id', '')::uuid;
    if v_mgr is not null and (v_mgr = p_user_id or not exists (
         select 1 from public.tenant_memberships m
          where m.user_id = v_mgr and m.tenant_id = v_tid and m.ended_at is null)) then
      raise exception 'Pick a manager who is a member of this company (not the person themselves).'
        using errcode = '22023';
    end if;
  end if;

  update public.tenant_memberships m
     set role           = case when p_patch ? 'role' then v_role else m.role end,
         manager_id     = case when p_patch ? 'manager_id' then v_mgr else m.manager_id end,
         can_view_deals = case when p_patch ? 'can_view_deals'
                               then coalesce((p_patch ->> 'can_view_deals')::boolean, false) else m.can_view_deals end,
         gets_new_leads = case when p_patch ? 'gets_new_leads'
                               then coalesce((p_patch ->> 'gets_new_leads')::boolean, false) else m.gets_new_leads end,
         updated_at     = now()
   where m.id = v_m.id;
end;
$$;

revoke all on function public.update_company_member(uuid, jsonb) from public, anon;
grant execute on function public.update_company_member(uuid, jsonb) to authenticated, service_role;

-- ── 6. No more deleting a teammate's login row ─────────────────────────────────────
drop policy if exists users_tenant_delete on public.users;

commit;
