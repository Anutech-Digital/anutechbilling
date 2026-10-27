-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.bank_accounts') and attname = 'is_default_petty_cash' and not attisdropped) and exists(select 1 from pg_trigger where tgname = 'trg_tenants_default_petty_cash') and to_regprocedure('public.backfill_default_petty_cash()') is not null
-- deploy-key: r1834pettycash
-- 20261024101339_r1834_default_petty_cash.sql
--
-- R-1834 (24 Oct 2026, Pardeep: "company me ek petty cash account bhi default hona chahiye").
-- Almost every Indian SME pays some expenses in cash, but a company had no cash account until
-- someone created one by hand — so a cash spend had nowhere to sit, and Add expense defaulted
-- to "Don't deduct from petty cash".
--
-- What this does (no stored amount changes — every row added is an EMPTY account, ₹0):
--   1. bank_accounts.is_default_petty_cash marks THE auto-created Petty Cash. A partial unique
--      index allows exactly one per company. The guard is "one AUTO account", not "one cash
--      account": a company may still add more cash accounts by hand (a second office's cash
--      box). The app uses the mark to pick the default for the Cash method when a company has
--      several cash accounts.
--   2. AFTER INSERT trigger on tenants: a new company gets "Petty Cash" in the SAME transaction
--      as the company row. Signup, onboarding new-tenant and the demo account all insert into
--      tenants, so one trigger covers every path. ON CONFLICT DO NOTHING → idempotent.
--   3. Backfill (backfill_default_petty_cash, run once below): one Petty Cash for every
--      existing company that has NO cash account at all. A company that already keeps cash in
--      an account of its own gets nothing; running it again adds nothing (NOT EXISTS + ON
--      CONFLICT).
--
-- Opening date = 1 April of the current IST financial year: books start at the FY, so a cash
-- spend back-entered from earlier in this FY still falls inside the account's life. Opening ₹0.
--
-- Backfilled rows get created_at = the company's created_at (or 1 s before its oldest
-- account): the Banking list and ~10 "From account" pickers (bills, loans, assets, salary)
-- sort newest first and pre-pick accounts[0]. A Petty Cash stamped "now" would jump to the top
-- and become the default source for BANK payments in existing companies. A new company's Petty
-- Cash is its first account anyway, so both paths sort the same way.
--
-- §17c: tg_tenant_default_petty_cash is a TRIGGER function (returns trigger) — it cannot be
-- called through the API or with a caller-chosen tenant; it only ever writes NEW.id's own row.
-- SECURITY DEFINER because the company row is inserted before its users row exists, so
-- bank_accounts' RLS insert policy (tenant_id = current_tenant_id()) would refuse it.
-- backfill_default_petty_cash takes no tenant and carries the trusted-only guard (§17c form).
-- EXECUTE is revoked from public/anon/authenticated on both.
--
-- Delete: bank_transactions → bank_accounts is ON DELETE RESTRICT and tg_bank_account_delete_guard
-- refuses a delete while an account has lines, so Petty Cash can be deleted only while empty —
-- the same rule as every account. Rename = the ordinary Edit on the Banking page.
--
-- Proof: supabase/tests/default_petty_cash.test.sql (one rollback, mutation-checked).

begin;

alter table public.bank_accounts
  add column if not exists is_default_petty_cash boolean not null default false;

comment on column public.bank_accounts.is_default_petty_cash is
  'R-1834: true only on the Petty Cash account created automatically with the company (one per company). More cash accounts may be added by hand.';

create unique index if not exists bank_accounts_one_default_petty_cash
  on public.bank_accounts (tenant_id)
  where is_default_petty_cash;

-- ── New company → Petty Cash, same transaction ──────────────────────────────
create or replace function public.tg_tenant_default_petty_cash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.ist_today();
begin
  insert into public.bank_accounts
    (tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date,
     is_active, is_default_petty_cash, notes)
  values
    (new.id, 'Petty Cash', 'Cash in hand', 'cash', 0,
     make_date(extract(year from v_today)::int - case when extract(month from v_today) < 4 then 1 else 0 end, 4, 1),
     true, true,
     'Created with the company for cash spends. Rename it if you like; top it up with Move money / withdraw from a bank account.')
  on conflict (tenant_id) where is_default_petty_cash do nothing;
  return new;
end;
$$;

revoke all on function public.tg_tenant_default_petty_cash() from public, anon, authenticated;

drop trigger if exists trg_tenants_default_petty_cash on public.tenants;
create trigger trg_tenants_default_petty_cash
  after insert on public.tenants
  for each row execute function public.tg_tenant_default_petty_cash();

-- ── Existing companies → backfill (a function so the SQL test can prove it) ──
create or replace function public.backfill_default_petty_cash()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
    or (auth.role() is null and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_today date := public.ist_today();
  v_n integer;
begin
  if not v_trusted then
    raise exception 'Only the database owner can add default Petty Cash accounts' using errcode = '42501';
  end if;

  -- Only companies with NO cash account at all. Inserts empty accounts; touches no other row.
  insert into public.bank_accounts
    (tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date,
     is_active, is_default_petty_cash, notes, created_at, updated_at)
  select
    t.id, 'Petty Cash', 'Cash in hand', 'cash', 0,
    make_date(extract(year from v_today)::int - case when extract(month from v_today) < 4 then 1 else 0 end, 4, 1),
    true, true,
    'Created with the company for cash spends. Rename it if you like; top it up with Move money / withdraw from a bank account.',
    least(coalesce(t.created_at, now()),
          coalesce((select min(b.created_at) from public.bank_accounts b where b.tenant_id = t.id) - interval '1 second', now())),
    now()
  from public.tenants t
  where not exists (
    select 1 from public.bank_accounts b
     where b.tenant_id = t.id and b.account_type = 'cash'
  )
  on conflict (tenant_id) where is_default_petty_cash do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.backfill_default_petty_cash() from public, anon, authenticated;
grant execute on function public.backfill_default_petty_cash() to service_role;

select public.backfill_default_petty_cash();


-- ── Claim-a-stranded-user: an untouched Petty Cash is not "records" ─────────
-- merge_stranded_user_into_tenant (R-721, last body 20261018225100_r1615) refuses to clear an
-- accidental workspace that holds any tenant row outside a short bookkeeping list. Every
-- workspace now has a Petty Cash, so without this every accidental workspace would read as
-- "still holds records" and the owner could never claim the person. Same body as r1615; the
-- only change is the bank_accounts count skipping the auto Petty Cash while it is ₹0 opening.
-- create or replace keeps its grants.
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
                           then ' and not (is_default_petty_cash and opening_balance = 0)' else '' end),
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

commit;
