-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.release_stale_team_invite(text)') and prosrc like '%R-2469%')
-- deploy-key: r2469staleinvite
-- 20261104063105_r2469_release_stale_team_invite.sql
--
-- R-2469 (4 Nov 2026, staging): an employee (Pratik, Excel) ended up in an accidental blank
-- workspace. The Excel owner could not bring him back: Team → Invite refused with "That email is
-- already invited to a different workspace" (team_invites_email_unique is ONE row per address
-- across every workspace and RLS hides the other row), and Claim a colleague needs an invite or
-- join request to THIS workspace. A dead end with no next step.
--
-- release_stale_team_invite(email): the invite route calls it (session client, so auth.uid() is
-- the owner) only after its own insert hit the unique index. It deletes the OTHER workspace's
-- invite for that address only when the invite holds nobody back:
--   * a PENDING invite that has EXPIRED (R-733: links work 7 days) — it can no longer be used;
--   * an ACCEPTED invite for someone who is no longer a member of that workspace — used up;
--   * any invite in a BLANK workspace: no member other than the invitee, and no business records
--     (same count as merge_stranded_user_into_tenant: every table with tenant_id except
--     bookkeeping, the empty default Petty Cash (R-1834) and the Customer messages switch (R-1922)).
-- Everything else stays — a live invite or a member of a real company is never touched, so an
-- owner cannot pull anyone out of a real company (the claim itself still runs every R-721 check).
--
-- Privacy (R-721): returns only true/false, never which workspace or how big; the audit row is
-- written in the CALLER's workspace and does not name the other one.
-- Caller: active owner of a workspace, MFA step done (R-1615 helpers). Otherwise 42501.

begin;

create or replace function public.release_stale_team_invite(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email     text := lower(btrim(coalesce(p_email, '')));
  v_tid       uuid;
  v_inv       record;
  v_member    boolean;
  v_others    boolean;
  v_sql       text;
  v_rows      bigint := 0;
  v_why       text;
begin
  /* R-2469: caller must be an active owner who has finished sign-in. */
  v_tid := public.current_tenant_id();
  if v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an active workspace owner can do this.' using errcode = '42501';
  end if;

  if v_email = '' then
    return false;
  end if;

  select i.id, i.tenant_id, i.accepted_at, i.expires_at
    into v_inv
    from public.team_invites i
   where lower(i.email) = v_email
   for update;

  if not found or v_inv.tenant_id = v_tid then
    return false;  -- nothing there, or it is the caller's own (the route handles that itself)
  end if;

  select exists (select 1 from public.users u
                  where u.tenant_id = v_inv.tenant_id and lower(u.email) = v_email)
    into v_member;
  select exists (select 1 from public.users u
                  where u.tenant_id = v_inv.tenant_id and lower(coalesce(u.email, '')) <> v_email)
    into v_others;

  if v_inv.accepted_at is null and v_inv.expires_at is not null and v_inv.expires_at <= now() then
    v_why := 'expired';
  elsif v_inv.accepted_at is not null and not v_member then
    v_why := 'already used';
  elsif not v_others then
    /* Blank workspace: count everything that is not bookkeeping (fail-safe: an unlisted table
       counts as data). Kept in step with merge_stranded_user_into_tenant (R-721/R-1834/R-1922). */
    select string_agg(
             format('select count(*)::bigint as n from public.%I where tenant_id = %L%s',
                    c.table_name, v_inv.tenant_id,
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
             'tenant_domains', 'join_requests', 'email_log', 'api_keys'
           );
    execute format('select coalesce(sum(n), 0) from (%s) s', v_sql) into v_rows;
    if v_rows = 0 then
      v_why := 'empty workspace';
    end if;
  end if;

  if v_why is null then
    return false;
  end if;

  delete from public.team_invites where id = v_inv.id;

  insert into public.activity_log (tenant_id, user_id, action, entity, label)
  values (v_tid, auth.uid(), 'stale_invite_released', 'team_invite',
          format('Cleared an old invite for %s held elsewhere (%s) so it could be invited here', v_email, v_why));

  return true;
end;
$$;

comment on function public.release_stale_team_invite(text) is
  'R-2469: active owner clears ANOTHER workspace''s invite for an address only if it is expired, already used by someone who left, or sits in a blank workspace (no other member, no records). Returns true/false only.';

revoke all on function public.release_stale_team_invite(text) from public, anon;
grant execute on function public.release_stale_team_invite(text) to authenticated, service_role;

commit;
