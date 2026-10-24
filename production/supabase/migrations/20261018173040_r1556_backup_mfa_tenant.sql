-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.get_tenant_backup(uuid)') and prosrc like '%R-1557%')
-- deploy-key: r1556backupmfa
-- 20261018173040_r1556_backup_mfa_tenant.sql
--
-- R-1556 (P1 security) + R-1557 (P2 security), audit 18 Oct 2026.
--
-- ══ THE HOLE (R-1556) ════════════════════════════════════════════════════════════
--   The seven backup RPCs found the caller's company with
--       select tenant_id from public.users where id = auth.uid()
--   instead of public.current_tenant_id(). current_tenant_id() is NULL for a deactivated
--   user (R-722) and for an MFA-enrolled user whose session has not passed the second step
--   (R-731). So a password-only (aal1) session of an MFA owner could download the whole
--   company (get_tenant_backup), wipe tables (reset_tenant_selected_tables) or restore an old
--   snapshot over today's books (restore_tenant_backup — replica mode, triggers/FKs off).
--   create/restore/reset checked role = 'owner' only, not is_active, so a DEACTIVATED owner
--   could do the same. get/list/delete went through current_user_has_role(), which checked
--   is_active but not the second sign-in step.
--
-- ══ THE FIX ═════════════════════════════════════════════════════════════════════
--   Every one of the seven: v_tenant := public.current_tenant_id(); NULL → refuse with
--   28000 (fail closed, CLAUDE.md §17c — there is no trusted caller for these: they act on
--   the CALLER's own company, so a service/cron session has nothing to act on; the nightly
--   job uses backup_tenant()); then guard_backup_owner_only() (active owner); then every
--   read/write filtered by v_tenant. auto_backup_if_stale() keeps its quiet
--   {created:false} answer (fire-and-forget on page load) but on the same rule.
--
--   current_user_has_role() also requires public.session_mfa_ok() now, so every role gate
--   (RLS policies AND definer guards that do not go through current_tenant_id()) refuses a
--   half-signed-in MFA user. Non-MFA users: session_mfa_ok() is true — unchanged. Every user
--   path sets the session level (gateway / withTenant: app.aal; GoTrue: the JWT aal claim);
--   background jobs set no user, so current_user_has_role() was already false for them.
--
-- ══ THE LEAK (R-1557) ═══════════════════════════════════════════════════════════
--   backup._take stores to_jsonb(t) of every tenant table, so a snapshot carries
--   employees.pin_hash, attendance_settings.presence_secret / ingest_key,
--   ad_accounts.access_token, user_google_tokens.* tokens and vault_passwords.*_ciphertext.
--   get_tenant_backup handed that payload to the browser — the columns R-833 / R-840 keep
--   away from every browser role. Now get_tenant_backup returns the payload WITHOUT those
--   columns. The stored snapshot stays complete, so restore_tenant_backup (server-side copy)
--   still brings them back. The list below is the `secret_cols` list of
--   supabase/cloudsql/09-grant-what-policies-allow.sql; src/lib/security/secret-columns.test.ts
--   fails if the two drift.
--
-- Cloud SQL: these functions were created by cloudsql/07 as resellersos_migration (the default
-- deploy user) — create or replace keeps owner, signature and return types. No auth.users, no
-- extensions schema; staging's apply() rewrites auth.uid() → public.current_user_id().
-- The backup schema may be missing (local Supabase): plpgsql bodies resolve tables at run time,
-- so this file applies either way.
-- Test: supabase/tests/r1556_backup_mfa_secrets.test.sql. Idempotent: create or replace.

begin;

-- ── 0. Role gate knows about the second sign-in step ────────────────────────────────
create or replace function public.current_user_has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  /* `is_active` matters as much as the role: a deactivated owner is how an ex-employee
     keeps their access. current_user_is_owner() already checks it; this matches.
     R-1556: and the session must have passed two-step sign-in if the user enrolled
     (session_mfa_ok(), R-731) — a password-only session holds no role. */
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.is_active
      and u.role::text = any (p_roles)
  ) and public.session_mfa_ok();
$function$;

comment on function public.current_user_has_role(text[]) is
  'True when the signed-in user is ACTIVE, holds one of the given roles, and (if MFA-enrolled) '
  'this session is aal2. The single definition of "who may touch this". S41, R-1556.';

-- ── 1. get_tenant_backup: caller's company only, secrets stripped (R-1557) ───────────
create or replace function public.get_tenant_backup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_payload jsonb;
  /* R-1557: same list as `secret_cols` in cloudsql/09-grant-what-policies-allow.sql
     (secret-columns.test.ts keeps them equal). The download never carries these. */
  v_secret constant text[] := array[
    'attendance_settings.presence_secret',
    'attendance_settings.ingest_key',
    'employees.pin_hash',
    'ad_accounts.access_token',
    'user_google_tokens.access_token',
    'user_google_tokens.refresh_token',
    'user_google_tokens.sync_token',
    'email_verifications.token_hash',
    'vault_passwords.username_ciphertext',
    'vault_passwords.password_ciphertext',
    'vault_passwords.notes_ciphertext'
  ];
begin
  -- R-1556: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session.
  if v_tenant is null then
    raise exception 'Backup download needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  perform public.guard_backup_owner_only();

  select s.payload into v_payload
    from backup.snapshots s
   where s.id = p_id and s.tenant_id = v_tenant;
  if v_payload is null then
    return null;
  end if;

  return (
    select coalesce(jsonb_object_agg(t.key,
             case
               when jsonb_typeof(t.value) = 'array' and c.cols is not null then
                 (select coalesce(jsonb_agg(e.row - c.cols order by e.n), '[]'::jsonb)
                    from jsonb_array_elements(t.value) with ordinality as e(row, n))
               else t.value
             end), '{}'::jsonb)
      from jsonb_each(v_payload) t
      left join lateral (
        select array_agg(split_part(x, '.', 2)) as cols
          from unnest(v_secret) x
         where split_part(x, '.', 1) = t.key
      ) c on true
  );
end $function$;

-- ── 2. list / delete ────────────────────────────────────────────────────────────────
create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamp with time zone, label text, kind text, table_count integer, bytes integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  -- R-823: every column qualified — a bare `id` collides with the RETURNS TABLE column (42702).
  -- R-1556: tenant from current_tenant_id() (inactive / half-signed-in MFA → refused).
  if v_tenant is null then
    raise exception 'Backups need an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  perform public.guard_backup_owner_only();
  return query
    select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
      from backup.snapshots s
     where s.tenant_id = v_tenant
     order by s.created_at desc;
end $function$;

create or replace function public.delete_tenant_backup(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  -- R-1556
  if v_tenant is null then
    raise exception 'Deleting a backup needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  perform public.guard_backup_owner_only();
  delete from backup.snapshots s
   where s.id = p_id and s.tenant_id = v_tenant;
end $function$;

-- ── 3. create / auto ────────────────────────────────────────────────────────────────
create or replace function public.create_tenant_backup(p_label text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  -- R-1556: was role = 'owner' from users by auth.uid() — no is_active, no MFA step.
  if v_tenant is null then
    raise exception 'Taking a backup needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  perform public.guard_backup_owner_only();
  return backup._take(v_tenant, coalesce(p_label, 'Manual backup'), 'manual');
end $function$;

create or replace function public.auto_backup_if_stale()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_last   timestamptz;
begin
  /* Fire-and-forget on the Backup page: a caller who may not back up gets the same quiet
     {created:false} as before. R-1556: "may" = current_tenant_id() + active owner. */
  if v_tenant is null or not public.current_user_has_role('owner') then
    return jsonb_build_object('created', false);
  end if;
  select max(s.created_at) into v_last from backup.snapshots s where s.tenant_id = v_tenant;
  if v_last is not null and v_last > now() - interval '20 hours' then
    return jsonb_build_object('created', false);
  end if;
  perform backup._take(v_tenant, 'Auto (daily)', 'auto');
  return jsonb_build_object('created', true);
end $function$;

-- ── 4. reset ────────────────────────────────────────────────────────────────────────
create or replace function public.reset_tenant_selected_tables(p_tables text[], p_label text, p_confirm_statutory boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_backup   jsonb;
  v_bad      text[];
  v_stat     text[];
  r          record;
  v_deleted  jsonb := '{}'::jsonb;
  n          bigint;
begin
  -- R-1556: was role = 'owner' from users by auth.uid() — no is_active, no MFA step.
  if v_tenant is null then
    raise exception 'Resetting data needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can reset data. Ask the account owner to do this.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_tables is null or cardinality(p_tables) = 0 then
    raise exception 'Nothing selected. Tick at least one section to reset.';
  end if;

  select array_agg(t) into v_bad
  from unnest(p_tables) t
  where t not in (select key from backup._resettable());

  if v_bad is not null then
    raise exception 'Not resettable: %. Allowed: %',
      array_to_string(v_bad, ', '),
      (select string_agg(distinct key, ', ' order by key) from backup._resettable());
  end if;

  select array_agg(distinct key) into v_stat
  from backup._resettable()
  where statutory and key = any(p_tables);

  if v_stat is not null and not p_confirm_statutory then
    raise exception
      'Refusing to reset % — these are statutory records (GST invoice series must have no gaps; attendance backs payroll). Re-run with the statutory confirmation if you are certain.',
      array_to_string(v_stat, ', ');
  end if;

  v_backup := backup._take(v_tenant, 'Pre-Reset Safeguard Snapshot - ' || coalesce(p_label, 'unlabelled'), 'pre_reset');

  if v_backup is null
     or coalesce((v_backup->>'bytes')::bigint, 0) = 0
     or coalesce((v_backup->>'table_count')::int, 0) = 0 then
    raise exception 'Pre-reset backup produced an empty snapshot — refusing to delete anything. Nothing has been changed.';
  end if;

  for r in
    select tbl from backup._resettable() where key = any(p_tables)
  loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      raise exception 'Reset allowlist is stale: table public.% does not exist. Nothing has been changed.', r.tbl;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'tenant_id'
    ) then
      raise exception 'Refusing to reset public.% — it has no tenant_id, so the delete could not be scoped to one tenant. Nothing has been changed.', r.tbl;
    end if;

    execute format('delete from public.%I where tenant_id = $1', r.tbl) using v_tenant;
    get diagnostics n = row_count;
    v_deleted := v_deleted || jsonb_build_object(r.tbl, n);
  end loop;

  return jsonb_build_object(
    'backup_id',  v_backup->>'id',
    'backup_bytes', (v_backup->>'bytes')::bigint,
    'deleted',    v_deleted,
    'label',      p_label
  );
end $function$;

-- ── 5. restore (uses the full server-side snapshot — secrets come back) ──────────────
create or replace function public.restore_tenant_backup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  -- R-1556: was role = 'owner' from users by auth.uid() — no is_active, no MFA step.
  if v_tenant is null then
    raise exception 'Restoring a backup needs an active owner who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can restore'
      using errcode = 'insufficient_privilege';
  end if;
  select s.payload into v_payload from backup.snapshots s where s.id = p_id and s.tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id' and c.table_name not in ('tenant_secrets','users')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';
    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list, case when has_identity then 'overriding system value' else '' end, col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $function$;

-- ── Grants, re-stated (R-013 / R-401): authenticated + service_role, never anon/PUBLIC ──
revoke all on function public.current_user_has_role(text[])                      from public, anon;
revoke all on function public.get_tenant_backup(uuid)                            from public, anon;
revoke all on function public.list_tenant_backups()                              from public, anon;
revoke all on function public.delete_tenant_backup(uuid)                         from public, anon;
revoke all on function public.create_tenant_backup(text)                         from public, anon;
revoke all on function public.auto_backup_if_stale()                             from public, anon;
revoke all on function public.reset_tenant_selected_tables(text[], text, boolean) from public, anon;
revoke all on function public.restore_tenant_backup(uuid)                        from public, anon;
grant execute on function public.current_user_has_role(text[])                      to authenticated, service_role;
grant execute on function public.get_tenant_backup(uuid)                            to authenticated, service_role;
grant execute on function public.list_tenant_backups()                              to authenticated, service_role;
grant execute on function public.delete_tenant_backup(uuid)                         to authenticated, service_role;
grant execute on function public.create_tenant_backup(text)                         to authenticated, service_role;
grant execute on function public.auto_backup_if_stale()                             to authenticated, service_role;
grant execute on function public.reset_tenant_selected_tables(text[], text, boolean) to authenticated, service_role;
grant execute on function public.restore_tenant_backup(uuid)                        to authenticated, service_role;

/* Cloud SQL: the R-161 gateway connects as app_runtime, which gets no PUBLIC default —
   grant it explicitly (skipped where the role does not exist, e.g. local Supabase). */
do $$
declare
  r text;
  f text;
begin
  foreach r in array array['app_runtime'] loop
    if to_regrole(r) is not null then
      foreach f in array array[
        'public.current_user_has_role(text[])',
        'public.get_tenant_backup(uuid)',
        'public.list_tenant_backups()',
        'public.delete_tenant_backup(uuid)',
        'public.create_tenant_backup(text)',
        'public.auto_backup_if_stale()',
        'public.reset_tenant_selected_tables(text[], text, boolean)',
        'public.restore_tenant_backup(uuid)'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
    end if;
  end loop;
end $$;

commit;
