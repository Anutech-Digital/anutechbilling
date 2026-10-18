-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.consume_prepaid_advance(uuid,integer,date,text,integer,text)') and prosrc like '%R-1615%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.undo_my_last_punch()') and prosrc like '%R-1615%')
-- deploy-key: r1615definer
-- 20261018225100_r1615_definer_tenant_gate.sql
--
-- R-1615 (P1 security), found by the R-1560 catalog guard.
--
-- ══ THE HOLE ══════════════════════════════════════════════════════════════════════
--   Fourteen SECURITY DEFINER functions found the caller's company with
--       select tenant_id from public.users where id = auth.uid()
--   instead of public.current_tenant_id(). current_tenant_id() is NULL for a deactivated
--   user (R-722) and for an MFA-enrolled user whose session has not passed the second step
--   (R-731). So a deactivated user, or a password-only (aal1) session of an MFA user, could
--   still: spend a prepaid advance into a paid expense (consume_prepaid_advance — money),
--   clone partner items into the price list (sync_partner_item x2), read the partner MRR /
--   catalog / parent company, punch-undo and link attendance, write the activity log, and —
--   for an MFA owner on aal1 — list and claim stranded logins into the company (the two
--   stranded-user functions checked is_active but not the second sign-in step).
--
-- ══ THE FIX ═════════════════════════════════════════════════════════════════════
--   Every one takes the tenant from public.current_tenant_id() (same rule as R-1556):
--     • functions that change something (and the plpgsql readers): NULL → refuse with
--       28000 and a message that says what to do (CLAUDE.md §24);
--     • log_activity: NULL → write nothing, return quietly (fire-and-forget by contract —
--       callers never surface its errors; see api/vault/[id]/reveal/route.ts);
--     • the three LANGUAGE sql readers (get_my_tenant_with_parent, get_partner_catalog,
--       get_partner_metrics): NULL → no rows, exactly like an RLS policy built on it.
--   Role gates:
--     • sync_partner_item writes public.items, whose RLS allows owner/manager only — the
--       definer now asks current_user_has_role('owner','manager') too (it bypassed RLS).
--     • list_stranded_auth_users / merge_stranded_user_into_tenant: the owner check moves
--       from "users.role = owner and is_active" to current_user_has_role('owner') (adds the
--       MFA step) plus p_tenant_id = current_tenant_id(). Their trusted server path
--       (service_role / platform session, R-454 rule) is unchanged — it has no user.
--       These are NOT kept allowlisted: the stranded person is the TARGET; the CALLER is
--       always a signed-in owner of the destination company (api/team/claim uses the
--       session client), so a tenant session exists.
--   Attendance self-service (my_attendance_today/history, set_my_employee,
--   record_attendance_consent, undo_my_last_punch) needs no role — any active staff member
--   who finished sign-in keeps working; the employee link is read from the caller's row
--   only inside current_tenant_id()'s company.
--   Signatures, return types, defaults, search_path and grants are unchanged (create or
--   replace keeps owner and ACL).
--
-- Cloud SQL: staging's apply() rewrites auth.uid() → public.current_user_id(); the stranded
-- functions keep search_path public, auth (cloudsql/06 gives auth.users there).
-- Test: supabase/tests/r1615_definer_tenant_gate.test.sql. Catalog: r1560 allowlist emptied.
-- Idempotent: create or replace only.

begin;

-- ── 1. consume_prepaid_advance (money) ──────────────────────────────────────────────
create or replace function public.consume_prepaid_advance(
  p_advance_id uuid, p_amount integer, p_date date default current_date,
  p_note text default null::text, p_gst integer default 0, p_attachment text default null::text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_exp_id text;
  v_new    int;
begin
  if v_tenant is null then
    raise exception 'Using a prepaid advance needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry — if your account was switched off, ask your workspace owner to turn it on in Team.'
      using errcode = '28000';
  end if;
  select * into v_adv from public.prepaid_advances where id = p_advance_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Advance not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if p_amount > (v_adv.total_amount - v_adv.consumed_amount) then raise exception 'Amount exceeds remaining balance'; end if;

  v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, expense_date, paid, paid_date, bill_type, payment_method, description, notes, attachment_url, prepaid_advance_id)
  values
    (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_adv.vendor_id, p_amount, greatest(0, coalesce(p_gst,0)), p_date, true, p_date,
     case when coalesce(p_gst,0) > 0 then 'gst' else 'none' end, 'advance',
     'Consumed from ' || v_adv.vendor_name || ' advance', p_note, p_attachment, p_advance_id);

  v_new := v_adv.consumed_amount + p_amount;
  update public.prepaid_advances set consumed_amount = v_new, updated_at = now()
   where id = p_advance_id and tenant_id = v_tenant;
  return v_adv.total_amount - v_new;
end $function$;

-- ── 2. log_activity (fire-and-forget: NULL tenant → nothing written) ─────────────────
create or replace function public.log_activity(
  p_action text, p_entity text default 'session'::text,
  p_entity_id text default null::text, p_label text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: a deactivated user / half-signed-in MFA session logs nothing. */
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then return; end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), p_action, coalesce(p_entity, 'session'), p_entity_id, left(p_label, 120));
end $function$;

-- ── 3. Stranded-user admin (owner of THIS company, finished sign-in) ─────────────────
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
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and auth.uid() is null
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
$function$;

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
$function$;

-- ── 4. Partner (reseller hierarchy) ──────────────────────────────────────────────────
create or replace function public.get_my_tenant_with_parent()
returns table(id uuid, name text, tier text, parent_tenant_id uuid, parent_name text, parent_tier text, parent_gstin text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-1615: current_tenant_id() — no rows for a deactivated user / half-signed-in MFA session. */
  select
    t.id, t.name, t.tier, t.parent_tenant_id,
    p.name, p.tier, p.gstin
  from public.tenants t
  left join public.tenants p on p.id = t.parent_tenant_id
  where t.id = public.current_tenant_id();
$function$;

create or replace function public.get_partner_catalog()
returns table(id text, tenant_id uuid, name text, vendor text, kind text, hsn text, msrp integer, partner_price integer, prices jsonb, is_active boolean, already_synced boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-1615: current_tenant_id() — no rows for a deactivated user / half-signed-in MFA session. */
  with me as (
    select t.id as child_tenant, t.parent_tenant_id as parent_tenant
    from public.tenants t
    where t.id = public.current_tenant_id()
    limit 1
  )
  select
    pi.id,
    pi.tenant_id,
    pi.name,
    pi.vendor::text,
    pi.kind::text,
    pi.hsn,
    pi.msrp,
    pi.partner_price,
    pi.prices,
    pi.is_active,
    exists (
      select 1
      from public.items ci
      where ci.tenant_id = (select child_tenant from me)
        and ci.synced_from_partner_id = pi.id
    ) as already_synced
  from public.items pi
  where pi.tenant_id = (select parent_tenant from me)
    and pi.is_partner_visible = true
    and pi.is_active = true
  order by pi.vendor, pi.kind, pi.name;
$function$;

create or replace function public.get_partner_metrics()
returns table(tenant_id uuid, tenant_name text, tenant_gstin text, active_subscriptions integer, total_seats_sold integer, mrr integer, invoiced_this_month integer, paid_this_month integer, renewals_due_30d integer, renewal_revenue_30d integer, last_invoice_date date)
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-1615: current_tenant_id() — no rows for a deactivated user / half-signed-in MFA session. */
  with caller as (
    select public.current_tenant_id() as tenant_id
  ),
  month_start as (
    select date_trunc('month', current_date)::date as d
  ),
  children as (
    select t.id, t.name, t.gstin
    from public.tenants t
    where t.parent_tenant_id = (select tenant_id from caller)
  )
  select
    c.id, c.name, c.gstin,
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(seats)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(mrr)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.invoice_date >= (select d from month_start)), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.status = 'paid' and i.paid_date is not null
        and i.paid_date >= (select d from month_start)), 0),
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    coalesce((select sum(mrr * 12)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    (select max(invoice_date) from public.invoices i where i.tenant_id = c.id)
  from children c
  order by c.name;
$function$;

create or replace function public.sync_partner_item(
  p_partner_item_id text, p_my_msrp integer default null::integer, p_link_existing_id text default null::text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_child_tenant  uuid := public.current_tenant_id();
  v_parent_tenant uuid;
  v_parent        items%rowtype;
  v_short         text;
  v_new_id        text;
  v_existing_id   text;
begin
  /* R-1615: active user, second sign-in step done, and a role that may edit the price list
     (items RLS: owner/manager) — this function writes items past RLS. */
  if v_child_tenant is null then
    raise exception 'Adding a partner item needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can add partner items to your price list. Ask your workspace owner to add it from Items → Partner catalog.'
      using errcode = '42501';
  end if;

  select t.parent_tenant_id into v_parent_tenant
    from public.tenants t where t.id = v_child_tenant;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_short := substr(v_child_tenant::text, 1, 3);

  -- 1. Caller asked to link a specific existing row → trust it (verify ownership).
  if p_link_existing_id is not null then
    if not exists (
      select 1 from public.items
      where id = p_link_existing_id and tenant_id = v_child_tenant
    ) then
      raise exception 'Cannot link to item % — not in your tenant', p_link_existing_id;
    end if;
    update public.items
      set synced_from_partner_id = p_partner_item_id,
          wholesale              = v_parent.partner_price,
          msrp                   = case when p_my_msrp is not null then p_my_msrp else msrp end,
          is_active              = true
      where id = p_link_existing_id and tenant_id = v_child_tenant;
    return p_link_existing_id;
  end if;

  -- 2. Already synced from this exact parent → refresh.
  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id and tenant_id = v_child_tenant;
    return v_existing_id;
  end if;

  -- 3. New clone.
  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    coalesce(p_my_msrp, v_parent.msrp), v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $function$;

create or replace function public.sync_partner_item(
  p_partner_item_id text, p_my_msrp integer default null::integer)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_child_tenant  uuid := public.current_tenant_id();
  v_parent_tenant uuid;
  v_parent        items%rowtype;
  v_short         text;
  v_new_id        text;
  v_existing_id   text;
  v_msrp          integer;
begin
  /* R-1615: same gate as the 3-argument version. */
  if v_child_tenant is null then
    raise exception 'Adding a partner item needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can add partner items to your price list. Ask your workspace owner to add it from Items → Partner catalog.'
      using errcode = '42501';
  end if;

  select t.parent_tenant_id into v_parent_tenant
    from public.tenants t where t.id = v_child_tenant;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_msrp := coalesce(p_my_msrp, v_parent.msrp);
  v_short := substr(v_child_tenant::text, 1, 3);

  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id and tenant_id = v_child_tenant;
    return v_existing_id;
  end if;

  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    v_msrp, v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $function$;

-- ── 5. Attendance self-service (any active staff member who finished sign-in) ────────
create or replace function public.my_attendance_history(p_days integer default 14)
returns table(work_date date, check_in timestamp with time zone, check_out timestamp with time zone, source text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_emp    uuid;
begin
  if v_tenant is null then
    raise exception 'Your attendance needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  select u.employee_id into v_emp from public.users u where u.id = auth.uid() and u.tenant_id = v_tenant;
  if v_emp is null then return; end if;
  return query
    select a.work_date, a.check_in, a.check_out, a.source
    from public.attendance a
    where a.tenant_id = v_tenant and a.employee_id = v_emp
      and a.work_date >= ((now() at time zone 'Asia/Kolkata')::date - greatest(p_days, 1))
    order by a.work_date desc;
end $function$;

create or replace function public.my_attendance_today()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_emp uuid; v_name text; v_date date; v_row public.attendance;
  v_consent timestamptz; v_retention int; v_face timestamptz;
begin
  if v_tenant is null then
    raise exception 'Your attendance needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  select u.employee_id into v_emp from public.users u where u.id = auth.uid() and u.tenant_id = v_tenant;
  if v_emp is null then return jsonb_build_object('linked', false); end if;
  select name, attendance_consent_at, face_enrolled_at into v_name, v_consent, v_face
    from public.employees where id = v_emp and tenant_id = v_tenant;
  select coalesce(selfie_retention_days, 180) into v_retention from public.attendance_settings where tenant_id = v_tenant;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  return jsonb_build_object(
    'linked', true, 'employee_name', v_name, 'work_date', v_date,
    'check_in', v_row.check_in, 'check_out', v_row.check_out,
    'consent_at', v_consent, 'retention_days', coalesce(v_retention, 180),
    'face_enrolled', (v_face is not null)
  );
end $function$;

create or replace function public.record_attendance_consent()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_emp    uuid;
begin
  if v_tenant is null then
    raise exception 'Giving attendance consent needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  select u.employee_id into v_emp from public.users u where u.id = auth.uid() and u.tenant_id = v_tenant;
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  update public.employees
    set attendance_consent_at = now(), attendance_consent_source = 'self'
    where id = v_emp and tenant_id = v_tenant;
end $function$;

create or replace function public.set_my_employee(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_user_email text; v_emp_email text;
begin
  if v_tenant is null then
    raise exception 'Linking your employee record needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  select u.email into v_user_email from public.users u where u.id = auth.uid() and u.tenant_id = v_tenant;
  if not exists (select 1 from public.employees where id = p_employee_id and tenant_id = v_tenant) then
    raise exception 'Employee not in your workspace';
  end if;
  if exists (select 1 from public.users where employee_id = p_employee_id and id <> auth.uid()) then
    raise exception 'Ye employee record kisi aur user se already linked hai — owner se kaho.';
  end if;
  select email into v_emp_email from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(v_user_email, '')) then
    raise exception 'Aapka login email is employee se match nahi karta — owner se kaho ki Employees me aapko link kare.';
  end if;
  update public.users set employee_id = p_employee_id where id = auth.uid() and tenant_id = v_tenant;
end $function$;

create or replace function public.undo_my_last_punch()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_emp uuid; v_date date; v_row public.attendance;
begin
  if v_tenant is null then
    raise exception 'Undoing a punch needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  select u.employee_id into v_emp from public.users u where u.id = auth.uid() and u.tenant_id = v_tenant;
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then raise exception 'Aaj ka koi attendance record nahi.'; end if;

  if v_row.check_out is not null then
    if now() - v_row.check_out > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    update public.attendance set check_out = null, selfie_out = null, geo_out = null, check_out_device = null where id = v_row.id;
    return 'undo_checkout';
  else
    if now() - v_row.check_in > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    delete from public.attendance where id = v_row.id;
    return 'undo_checkin';
  end if;
end $function$;

commit;
