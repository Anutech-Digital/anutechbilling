-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.release_stale_team_invite(text)') and prosrc like '%R-2469%') and to_regprocedure('public.tenant_holds_business_records(uuid)') is not null
-- deploy-key: r2469staleinvite
-- 20261104090100_r2469_release_stale_team_invite.sql
--
-- R-2469 (4 Nov 2026, staging): the Excel owner could not invite an employee — Team → Invite
-- refused with "That email is already invited to a different workspace" (team_invites_email_unique
-- is ONE row per address across every workspace, and RLS hides the other row), and Claim a
-- colleague needs an invite or join request to THIS workspace. A dead end with no next step.
-- (On staging the person turned out to be an active member of ANOTHER real company — that case
-- must stay refused, with a clear next step.)
--
-- release_stale_team_invite(email) → text. The invite route calls it (session client, so
-- auth.uid() is the owner) BEFORE inserting the invite:
--   'member_elsewhere' — the address is a member of another workspace that is a real company
--                        (another member, or any business record). Nothing is touched: an owner
--                        can never pull someone out of a real company.
--   'released'         — another workspace's invite for the address held nobody back and was
--                        deleted, so the caller's invite can be written:
--                          * a PENDING invite that has EXPIRED (R-733: links work 7 days);
--                          * an ACCEPTED invite for someone who is no longer a member there;
--                          * any invite in a BLANK workspace (no member other than the invitee,
--                            no business records).
--   'in_use'           — another workspace holds a live invite; left alone.
--   'none'             — no other workspace's invite (none at all, or it is the caller's own).
-- A person alone in a blank workspace of their own is NOT 'member_elsewhere': once invited here
-- and signed in, Claim a colleague (merge_stranded_user_into_tenant) moves them and removes it.
--
-- Privacy (R-721): never says which workspace, how many people or records. The audit row is
-- written in the CALLER's workspace and does not name the other one.
-- Caller: active owner, MFA step done (R-1615 helpers). Otherwise 42501.
--
-- tenant_holds_business_records(tenant): the same count merge_stranded_user_into_tenant uses
-- (every public table with tenant_id except bookkeeping; the empty default Petty Cash (R-1834)
-- and the Customer messages switch (R-1922) are not data; an unlisted table counts as data).
-- Internal: no grant to app roles.

begin;

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
           'tenant_domains', 'join_requests', 'email_log', 'api_keys'
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

revoke all on function public.tenant_holds_business_records(uuid) from public, anon, authenticated;
grant execute on function public.tenant_holds_business_records(uuid) to service_role;

create or replace function public.release_stale_team_invite(p_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tid   uuid;
  v_inv   record;
  v_why   text;
begin
  /* R-2469: caller must be an active owner who has finished sign-in. */
  v_tid := public.current_tenant_id();
  if v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an active workspace owner can do this.' using errcode = '42501';
  end if;

  if v_email = '' then
    return 'none';
  end if;

  /* A member of another REAL company stays where they are. A workspace is "real" when it has
     anyone besides this person, or any business record. */
  if exists (
       select 1 from public.users u
        where lower(u.email) = v_email
          and u.tenant_id <> v_tid
          and (exists (select 1 from public.users o
                        where o.tenant_id = u.tenant_id and o.id <> u.id)
               or public.tenant_holds_business_records(u.tenant_id))) then
    return 'member_elsewhere';
  end if;

  select i.id, i.tenant_id, i.accepted_at, i.expires_at
    into v_inv
    from public.team_invites i
   where lower(i.email) = v_email
   for update;

  if not found or v_inv.tenant_id = v_tid then
    return 'none';
  end if;

  if v_inv.accepted_at is null and v_inv.expires_at is not null and v_inv.expires_at <= now() then
    v_why := 'expired';
  elsif v_inv.accepted_at is not null
        and not exists (select 1 from public.users u
                         where u.tenant_id = v_inv.tenant_id and lower(u.email) = v_email) then
    v_why := 'already used';
  elsif not exists (select 1 from public.users u
                     where u.tenant_id = v_inv.tenant_id and lower(coalesce(u.email, '')) <> v_email)
        and not public.tenant_holds_business_records(v_inv.tenant_id) then
    v_why := 'empty workspace';
  end if;

  if v_why is null then
    return 'in_use';
  end if;

  delete from public.team_invites where id = v_inv.id;

  /* Both workspaces get a line; neither names the other, and the caller's line does not say
     what state the other workspace was in (R-721). The owner who lost the invite sees why. */
  insert into public.activity_log (tenant_id, user_id, action, entity, label)
  values (v_tid, auth.uid(), 'stale_invite_released', 'team_invite',
          format('Cleared an old invite for %s from another workspace so it could be invited here', v_email)),
         (v_inv.tenant_id, null, 'stale_invite_released', 'team_invite',
          format('Your invite for %s (%s) was removed because another company invited them', v_email, v_why));

  return 'released';
end;
$$;

comment on function public.release_stale_team_invite(text) is
  'R-2469: before an owner invites an address — member_elsewhere (real company, untouched) | released (another workspace''s expired / used / blank-workspace invite deleted) | in_use | none. Never names the other workspace.';

revoke all on function public.release_stale_team_invite(text) from public, anon;
grant execute on function public.release_stale_team_invite(text) to authenticated, service_role;

commit;
