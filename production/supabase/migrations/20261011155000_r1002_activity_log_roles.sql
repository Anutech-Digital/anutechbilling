-- deploy-peek: exists(select 1 from pg_policy where polrelid = to_regclass('public.activity_log') and polname = 'activity_log_sel_owner_manager') and not exists(select 1 from pg_policy where polrelid = to_regclass('public.activity_log') and polname = 'activity_log_sel') and exists(select 1 from pg_proc where oid = to_regprocedure('public.log_row_change()') and prosrc like '%R-1002%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.audit_strip_secrets(jsonb)'))
-- deploy-key: r1002activitylog
-- 20261011155000_r1002_activity_log_roles.sql (reserved slot 141000 was passed on manager-pardeep; renamed before first push)
--
-- R-1002 (P1 SECURITY, launch blocker, data-leak audit 11 Oct 2026): the audit log was
-- readable by every role and held secrets.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   (a) activity_log_sel (baseline) = `tenant_id = current_tenant_id()` — every member of the
--       company (sales, support, delivery, billing, accountant …) could read the WHOLE audit
--       trail: every salary, payment, employee change and who made it.
--   (b) log_row_change() (newest body: 20261007240000_audit_actor_admin_writes) copies the
--       changed columns (UPDATE) or the whole row (DELETE) into `changes` — including
--       employees.pin_hash (the kiosk PIN hash) and quotes / project_sales.public_token (the
--       secret link a customer opens to see and pay a quote). Measured on the local DB 11 Oct:
--       24 tables carry the trigger; those three are the secret-shaped columns among them.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   1. Who may READ activity_log (Pardeep's decision via Super Manager, card R-1002):
--        owner        yes — whole company's log
--        manager      yes — whole company's log
--        accountant   no
--        billing      no
--        sales        no
--        sales_senior no
--        support      no
--        delivery     no
--        partner_agent no
--        no users row / deactivated (is_active = false) / another company: no
--      Policy activity_log_sel_owner_manager = same tenant AND current_user_has_role('owner',
--      'manager') (which already requires is_active). The old tenant-wide activity_log_sel is
--      dropped. Trust rule as R-454: service_role is trusted — zzz_service_role_all is
--      (re)created so Cloud SQL (no BYPASSRLS) keeps server-side reads/writes working.
--      Writes are unchanged: rows are only ever written by SECURITY DEFINER functions
--      (log_row_change, log_activity, log_attendance_change, merge_stranded_user_into_tenant)
--      and admin-client routes; there is still no INSERT/UPDATE/DELETE policy for users.
--      App screens: /activity is owner/manager-only already. The deal page's stage / quote
--      history, the payroll "attendance changes" box and the performance page's activity
--      count read activity_log with the user's client — for other roles they now get 0 rows
--      (no error) and show their empty state.
--   2. Secrets never enter the log. public.audit_secret_key(name) is the ONE denylist:
--        pin_hash, and any column whose name has a part (split on _) equal to
--        secret(s) password passwd passphrase token(s) hash salt otp cipher ciphertext nonce
--        vault credential(s) encrypted, or contains private_key / api_key / key_enc / enc_key.
--      (pin_code, pin_set, pan, bank_account_id do NOT match — not secrets.)
--      public.audit_strip_secrets(jsonb) removes those keys at the top level and inside an
--      `old` / `new` row object (the DELETE / INSERT shapes).
--      log_row_change(): an UPDATE that changes a secret column records only its NAME under
--      `_redacted` (e.g. {"_redacted": ["pin_hash"]}) — the log still says "the PIN was
--      changed", never the value; DELETE rows are stripped. Body otherwise identical to
--      20261007240000.
--      Belt and braces: BEFORE INSERT/UPDATE trigger activity_log_strip_secrets runs every
--      row through audit_strip_secrets, so any other writer (now or later) is covered too.
--   3. Purge: existing rows are rewritten through audit_strip_secrets (count raised as a
--      NOTICE).
--
-- Staging: the deploy script rewrites auth.uid() → public.current_user_id() (R-161), so it
-- is written plainly. Idempotent: create or replace / drop if exists; the purge is a no-op
-- the second time.
-- Test: supabase/tests/r1002_activity_log.test.sql (rolled back).

begin;

-- ── 2. The denylist + the stripper ──────────────────────────────────────────────────

create or replace function public.audit_secret_key(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  /* R-1002: the ONE definition of "a column whose value must never be written to the audit
     log". Matches on whole name parts (split on _) so pin_code / pin_set / pan stay. */
  select p_key is not null and (
    lower(p_key) = 'pin_hash'
    or lower(p_key) ~ '(^|_)(secrets?|password|passwd|passphrase|tokens?|hash|salt|otp|cipher|ciphertext|nonce|vault|credentials?|encrypted)(_|$)'
    or lower(p_key) ~ '(private_key|api_key|key_enc|enc_key)'
  );
$function$;

comment on function public.audit_secret_key(text) is
  'R-1002: true for a column name whose value must never enter activity_log.changes '
  '(pin_hash, *_token, *_hash, secret, password, ciphertext, vault, api_key …).';

create or replace function public.audit_strip_secrets(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  /* R-1002: drop secret keys at the top level and inside an `old` / `new` row object. */
  select case
    when p is null or jsonb_typeof(p) <> 'object' then p
    else coalesce((
      select jsonb_object_agg(
               e.k,
               case when e.k in ('old', 'new') and jsonb_typeof(e.v) = 'object'
                    then coalesce((select jsonb_object_agg(i.k, i.v)
                                     from jsonb_each(e.v) as i(k, v)
                                    where not public.audit_secret_key(i.k)), '{}'::jsonb)
                    else e.v end)
        from jsonb_each(p) as e(k, v)
       where not public.audit_secret_key(e.k)
    ), '{}'::jsonb)
  end;
$function$;

comment on function public.audit_strip_secrets(jsonb) is
  'R-1002: removes audit_secret_key() keys from an activity_log.changes value (top level and '
  'the old/new row objects).';

revoke all on function public.audit_secret_key(text) from public, anon;
revoke all on function public.audit_strip_secrets(jsonb) from public, anon;
grant execute on function public.audit_secret_key(text) to authenticated, service_role;
grant execute on function public.audit_strip_secrets(jsonb) to authenticated, service_role;

-- ── 2. log_row_change: never copy a secret ──────────────────────────────────────────

create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_json    jsonb;
  v_old     jsonb;
  v_tenant  uuid;
  v_id      text;
  v_label   text;
  v_changes jsonb;
  v_key     text;
  v_uid     uuid := auth.uid();
  v_as      uuid;
  v_user    uuid;
  v_actor   text;
  v_redacted text[] := '{}';
begin
  if v_uid is null then
    v_as := public.audit_service_actor();     -- R-051: admin-client write for a signed-in user
    if v_as is null then return null; end if; -- cron / webhook / system: not logged (as before)
  end if;
  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name',
    v_json->>'category', v_json->>'kind', v_json->>'period', ''
  );

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_changes := '{}'::jsonb;
    for v_key in select jsonb_object_keys(v_json) loop
      if v_key in ('updated_at', 'created_at') then continue; end if;
      if v_json->v_key is distinct from v_old->v_key then
        /* R-1002: a secret column (pin_hash, public_token …) is named, never copied. */
        if public.audit_secret_key(v_key) then
          v_redacted := v_redacted || v_key;
          continue;
        end if;
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old->v_key, 'new', v_json->v_key));
      end if;
    end loop;
    if cardinality(v_redacted) > 0 then
      v_changes := v_changes || jsonb_build_object('_redacted', to_jsonb(v_redacted));
    end if;
    if v_changes = '{}'::jsonb then return null; end if;   -- a touch, not a change
  elsif tg_op = 'DELETE' then
    v_changes := jsonb_build_object('old', public.audit_strip_secrets(v_json));   -- R-1002
  end if;

  if v_uid is not null then
    -- Who is acting: a staff user, or a portal customer (not in public.users).
    select u.id into v_user from public.users u where u.id = v_uid;
    if v_user is null then
      select 'Customer ' || c.name into v_actor
        from public.customer_users cu
        join public.customers c on c.id = cu.customer_id
       where cu.auth_user_id = v_uid
       limit 1;
    end if;
  else
    -- R-051: the service role vouched for v_as. Name them only inside their own tenant.
    select u.id into v_user from public.users u where u.id = v_as and u.tenant_id = v_tenant;
    if v_user is null and exists (select 1 from public.users u where u.id = v_as) then
      v_actor := 'Platform support';
    end if;
  end if;

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
  values (v_tenant, v_user, left(v_actor, 120), lower(tg_op), tg_table_name, v_id, left(v_label, 120), v_changes);
  return null;
end $$;

-- ── 2b. Every writer: strip on the way in ───────────────────────────────────────────

create or replace function public.activity_log_strip_secrets()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  /* R-1002: whoever writes the row (log_row_change, log_attendance_change, an admin-client
     route, a future function), activity_log.changes never keeps a secret key. */
  new.changes := public.audit_strip_secrets(new.changes);
  return new;
end;
$function$;

revoke all on function public.activity_log_strip_secrets() from public, anon;

drop trigger if exists activity_log_strip_secrets on public.activity_log;
create trigger activity_log_strip_secrets
  before insert or update of changes on public.activity_log
  for each row execute function public.activity_log_strip_secrets();

-- ── 3. Purge what is already there ──────────────────────────────────────────────────

do $$
declare v_n bigint;
begin
  update public.activity_log
     set changes = public.audit_strip_secrets(changes)
   where changes is not null
     and changes is distinct from public.audit_strip_secrets(changes);
  get diagnostics v_n = row_count;
  raise notice 'R-1002: secret keys purged from % activity_log row(s)', v_n;
end $$;

-- ── 1. Read = owner, manager only ───────────────────────────────────────────────────

alter table public.activity_log enable row level security;

drop policy if exists activity_log_sel on public.activity_log;
drop policy if exists activity_log_sel_owner_manager on public.activity_log;
create policy activity_log_sel_owner_manager on public.activity_log
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager')));

comment on policy activity_log_sel_owner_manager on public.activity_log is
  'R-1002: audit log readable by owner and manager of the same company only. accountant, '
  'billing, sales, sales_senior, support, delivery, partner_agent: none. Writes only via '
  'SECURITY DEFINER functions / service role.';

-- Cloud SQL has no BYPASSRLS: service_role needs its own policy (as 01b-grants-and-policies).
drop policy if exists zzz_service_role_all on public.activity_log;
create policy zzz_service_role_all on public.activity_log
  as permissive for all to service_role using (true) with check (true);

commit;
