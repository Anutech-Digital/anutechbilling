-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_tenants_customer_messages_on' and tgrelid = to_regclass('public.tenants')) and exists(select 1 from pg_trigger where tgname = 'trg_demo_tenants_customer_messages_off' and tgrelid = to_regclass('public.demo_tenants')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.merge_stranded_user_into_tenant(text,uuid,user_role)') and prosrc like '%R-1922%')
-- deploy-key: r1922custmsgson
-- 20261025160239_r1922_new_company_customer_messages_on.sql
--
-- R-1922 (G-ONBOARD OB-1, 25 Oct 2026). Pardeep's decision on the card: a NEW company starts
-- with Customer messages ON; scheduled jobs (crons) stay OFF.
--
-- Why: R-897 made a missing automation_jobs row mean OFF, and every customer email goes through
-- lib/messaging (sendCustomerEmail → automation_state('customer_messages')). So a brand-new
-- company's very first "Save & send" on a quote was refused with "Customer messages are
-- switched off" — before the owner had even heard of the Automation page. Pressing Send is a
-- human action; only the crons need the "nothing reaches a customer until you say so" default.
--
-- What this does (no money, no existing company touched — there is NO backfill):
--   1. AFTER INSERT trigger on tenants: the new company gets its customer_messages row with
--      enabled = true, in the SAME transaction as the company row. It is the same row the
--      /automation switch reads and writes, and the same row automation_state() (the gate)
--      reads — the owner can turn it off there like before. Signup, onboarding new-tenant and
--      the demo account all insert into tenants, so one trigger covers every path.
--      ON CONFLICT DO NOTHING → never overrides a row that already exists.
--      The R-897 audit trigger logs it to activity_log as "System: customer_messages: on".
--   2. AFTER INSERT trigger on demo_tenants: the public "Try the demo" workspace is registered
--      right after its company row is made — its switch goes back OFF, so a demo visitor can
--      never email a stranger through the app.
--   3. merge_stranded_user_into_tenant (latest body: 20261024101339_r1834) counts every tenant
--      row of an accidental workspace as "records"; the auto customer_messages row would make
--      every accidental workspace unclaimable. Same body; the only change is automation_jobs
--      skipping the customer_messages row. create or replace keeps its grants.
--
-- §17c: both new functions are TRIGGER functions (returns trigger) — they cannot be called
-- through the API or with a caller-chosen tenant; each only writes NEW's own company's row.
-- SECURITY DEFINER because the company row is inserted before its users row exists, so the
-- automation_jobs insert policy (owner of current_tenant_id()) would refuse it.
-- EXECUTE is revoked from public/anon/authenticated.
--
-- Proof: supabase/tests/new_company_customer_messages_on.test.sql (one rollback) and
-- supabase/tests/merge_stranded_user.test.sql (an accidental workspace is still claimable).

begin;

-- ── 1. New company → Customer messages ON, same transaction ─────────────────
create or replace function public.tg_tenant_customer_messages_on()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1922: only the customer_messages switch — every cron stays without a row = OFF. */
  insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
  values (new.id, 'customer_messages', true, false)
  on conflict (tenant_id, job) do nothing;
  return new;
end;
$$;

revoke all on function public.tg_tenant_customer_messages_on() from public, anon, authenticated;

drop trigger if exists trg_tenants_customer_messages_on on public.tenants;
create trigger trg_tenants_customer_messages_on
  after insert on public.tenants
  for each row execute function public.tg_tenant_customer_messages_on();

-- ── 2. The demo workspace never emails anyone ───────────────────────────────
create or replace function public.tg_demo_tenant_customer_messages_off()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1922: the public demo is read-only; its company must not reach real inboxes. */
  update public.automation_jobs
     set enabled = false
   where tenant_id = new.tenant_id
     and job = 'customer_messages'
     and enabled;
  return new;
end;
$$;

revoke all on function public.tg_demo_tenant_customer_messages_off() from public, anon, authenticated;

drop trigger if exists trg_demo_tenants_customer_messages_off on public.demo_tenants;
create trigger trg_demo_tenants_customer_messages_off
  after insert on public.demo_tenants
  for each row execute function public.tg_demo_tenant_customer_messages_off();

-- ── 3. Claim-a-stranded-user: the auto switch row is not "records" ──────────
create or replace function public.merge_stranded_user_into_tenant(
  p_email text, p_tenant_id uuid, p_role user_role default 'support'::user_role)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
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
               format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L%s',
                      c.table_name, c.table_name, v_old_tid,
                      /* R-1834: the empty Petty Cash every company is born with is not data. Its
                         bank lines (if any) still count, through bank_transactions. */
                      case when c.table_name = 'bank_accounts'
                           then ' and not (is_default_petty_cash and opening_balance = 0)'
                           /* R-1922: the Customer messages switch every company is born with is a
                              setting, not data. Any other switch row still counts. */
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
$function$;

commit;
