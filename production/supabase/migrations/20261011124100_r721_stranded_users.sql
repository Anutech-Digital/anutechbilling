-- deploy-key: r721stranded
-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.list_stranded_auth_users()') and prosrc like '%R-721%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.merge_stranded_user_into_tenant(text,uuid,public.user_role)') and prosrc like '%R-721%')
-- 20261011124100_r721_stranded_users.sql
--
-- R-721 (P1 SECURITY, audit 10 Oct 2026): Team -> "Claim a colleague" was a platform-wide window.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   list_stranded_auth_users() (last body: baseline) only asked "is the caller an owner
--   ANYWHERE?" — every signup owns its own company — then returned EVERY auth account on the
--   platform with no public.users row: email, name, last sign-in. That includes people waiting
--   on a join request to some OTHER company, apprentices, customer-portal logins.
--   merge_stranded_user_into_tenant() then let that owner pull any of them (or anyone sitting
--   alone in an empty workspace) into their own company, and its errors told the caller whether
--   an address has an account at all, plus the other company's name, head-count and record counts.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   Both functions, signed-in callers:
--   * caller must be an ACTIVE owner of the workspace (role owner AND is_active; R-712's rule);
--   * only people with a PENDING invite (team_invites, accepted_at null) or a PENDING join
--     request (join_requests, pending_approval) TO THE CALLER'S workspace are listed / claimable.
--     An invite is the owner's own act, so it counts only once the person has signed in AFTER
--     it was sent — otherwise "invite any address, then claim it" would reopen the hole.
--     Someone already in the caller's workspace can still get a role fix (they are visible on
--     Team anyway).
--   * error text is generic: "no account" and "no invite/request" give the SAME message, and no
--     refusal names another company or counts its people or records.
--   Trusted server paths (service_role key, or a direct DB session with no request role — the
--   R-454 rule) keep the platform-admin view: full list, claim without an invite, detailed refusal.
--   On a successful claim the pending invite is marked accepted (the join request was already
--   marked approved).
--
-- Staging's apply() rewrites auth.uid()/auth.role() for the Prisma path (R-161), so write them plainly.
-- Idempotent: create or replace only; grants are kept.

begin;

create or replace function public.list_stranded_auth_users()
returns table(email text, full_name text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_trusted boolean;
  v_tid     uuid;
begin
  /* R-721: trusted server paths only (R-454 rule) see the whole platform. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));

  if not v_trusted then
    select u.tenant_id into v_tid
      from public.users u
     where u.id = auth.uid() and u.role = 'owner' and u.is_active;
    if v_tid is null then
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
     where not exists (select 1 from public.users u where u.id = au.id)
       and au.email is not null
       and (v_trusted
            or exists (select 1 from public.team_invites i
                        where i.tenant_id = v_tid and i.accepted_at is null
                          and lower(i.email) = lower(au.email)
                          and au.last_sign_in_at >= i.created_at)
            or exists (select 1 from public.join_requests jr
                        where jr.tenant_id = v_tid and jr.status = 'pending_approval'
                          and (jr.auth_user_id = au.id or lower(jr.email) = lower(au.email))))
     order by au.last_sign_in_at desc nulls last, au.created_at desc;
end;
$$;

comment on function public.list_stranded_auth_users() is
  'R-721: active owner sees only accounts with no public.users row that have a pending invite or join request to THEIR workspace; service_role sees all. Email and name only.';


create or replace function public.merge_stranded_user_into_tenant(
  p_email text, p_tenant_id uuid, p_role public.user_role default 'support'::public.user_role)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
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
begin
  v_generic := format(
    'Cannot claim %s. Only someone with a pending invite or join request to your workspace, who has signed in at least once, can be claimed. Invite them from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.',
    v_email);

  /* R-721: trusted server paths (R-454 rule) act as platform admin. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));

  -- ── 1. The caller must be an ACTIVE owner of the destination workspace ──
  if not v_trusted then
    if not exists (select 1 from public.users u
                    where u.id = auth.uid() and u.tenant_id = p_tenant_id
                      and u.role = 'owner' and u.is_active) then
      raise exception
        'Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.'
        using errcode = '42501';
    end if;
  end if;

  select t.name into v_dest_name from public.tenants t where t.id = p_tenant_id;
  if v_dest_name is null then
    raise exception 'That workspace does not exist.' using errcode = 'P0002';
  end if;

  -- ── 2. Already in this workspace? Only the role may need correcting. ────
  select u.id into v_member_id
    from public.users u
   where u.tenant_id = p_tenant_id and lower(u.email) = v_email
   limit 1;

  if v_member_id is not null then
    update public.users set role = p_role where id = v_member_id and role <> p_role;
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

    select u.tenant_id into v_old_tid from public.users u where u.id = v_auth_id;

    if v_old_tid = p_tenant_id then
      -- Row email differs from the login email but the person is here already.
      update public.users set role = p_role where id = v_auth_id and role <> p_role;
      v_action := case when found then 'role_updated' else 'already_member' end;

    -- 3b. Truly stranded: an auth account with no profile anywhere.
    elsif v_old_tid is null then
      insert into public.users (id, tenant_id, email, full_name, initials, role, color)
      values (
        v_auth_id, p_tenant_id, v_email, v_auth_name,
        upper(left(regexp_replace(coalesce(v_auth_name, v_email), '[^A-Za-z]', '', 'g'), 2)),
        p_role, 'indigo'
      );
      v_action := 'attached';

    -- 3c. They are sitting in another (accidental) workspace.
    else
      select t.name, (select count(*) from public.users u2 where u2.tenant_id = t.id)
        into v_old_name, v_old_users
        from public.tenants t where t.id = v_old_tid;

      if v_old_users > 1 then
        raise exception
          'Cannot claim %: they are in another company that has other people in it. That is a separate company, not an accidental workspace — moving them is a platform-admin job.%',
          v_email,
          case when v_trusted then format(' ("%s", %s people)', v_old_name, v_old_users) else '' end
          using errcode = '23505';
      end if;

      -- Count everything that is not bookkeeping. Fail-safe: unlisted table = data.
      select string_agg(
               format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L',
                      c.table_name, c.table_name, v_old_tid),
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
               'tenant_domains', 'join_requests', 'email_log', 'api_keys'
             );

      execute format(
        'select coalesce(jsonb_object_agg(tbl, n) filter (where n > 0), ''{}''::jsonb),
                coalesce(sum(n), 0) from (%s) s', v_sql)
        into v_holdings, v_rows;

      if v_rows > 0 then
        raise exception
          'Cannot claim %: their current workspace still holds records. Moving them out would leave that data with no one who can sign in and see it. They should move or export it first — this tool only clears empty workspaces.%',
          v_email,
          case when v_trusted then format(' ("%s": %s records, %s)', v_old_name, v_rows, v_holdings::text) else '' end
          using errcode = '23503';
      end if;

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
           case when v_deleted then format(' (removed empty workspace "%s")', v_old_name) else '' end)
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
$$;

comment on function public.merge_stranded_user_into_tenant(text, uuid, public.user_role) is
  'R-721: active owner of p_tenant_id may claim only someone with a pending invite or join request to that workspace (or fix the role of a member). Generic refusals; service_role = platform admin. Deletes the old workspace only when it is empty of people and business data.';

commit;
