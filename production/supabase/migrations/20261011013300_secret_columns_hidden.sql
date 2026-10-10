-- deploy-key: secretcols
-- deploy-peek: (not exists(select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and (c.relname, a.attname) in (('attendance_settings', 'presence_secret'), ('attendance_settings', 'ingest_key'), ('employees', 'pin_hash'), ('ad_accounts', 'access_token'), ('user_google_tokens', 'refresh_token')) and (has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') or has_column_privilege('anon', c.oid, a.attnum, 'SELECT'))) and not exists(select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname = 'attendance_settings' and (has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE'))))
-- 20261011013300_secret_columns_hidden.sql
--
-- R-833 (10 Oct 2026, security p1). Close what supabase/cloudsql/09-grant-what-policies-allow.sql
-- re-opened on every staging deploy-db run (step 3b).
--
-- ══ WHAT WAS OPEN ═══════════════════════════════════════════════════════════════
--   09 asked has_table_privilege(role, table, 'SELECT'), which ignores COLUMN grants. On the
--   three column-granted tables it therefore found "no SELECT" and granted TABLE-level SELECT
--   every run — and a table-level SELECT overrides every column the migrations left out:
--     attendance_settings.presence_secret  seed of the rotating office code (R-605/R-438) —
--                                          any member could compute today's code
--     attendance_settings.ingest_key       biometric device key (R-607)
--     employees.pin_hash                   kiosk PIN hash (R-607 part 2)
--     ad_accounts.access_token             Meta long-lived token
--   and on attendance_settings TABLE-level INSERT/UPDATE (its policies allow owner/manager),
--   so a manager could overwrite the office-code seed or switch the geofence off with a REST
--   call instead of set_office_location() (R-438).
--   09 is fixed in the same commit (secret_cols denylist, column grants only).
--
-- ══ WHAT THIS DOES ══════════════════════════════════════════════════════════════
--   Puts the three tables back to the column grants their migrations wrote. REVOKE on a table
--   also drops that role's column grants, so every column grant is given back explicitly:
--     attendance_settings  SELECT  every column except presence_secret, ingest_key
--                          INSERT/UPDATE  the R-601 + shift + device columns (as before;
--                          geofence columns stay RPC-only, secrets stay server-only)
--     employees            SELECT  every column except pin_hash (INSERT/UPDATE untouched)
--     ad_accounts          SELECT  every column except access_token
--     user_google_tokens   no browser SELECT at all (server-only; RLS already hid every row)
--   anon gets nothing on any of them. service_role keeps ALL. The app reads these tables
--   with named columns (attendance: network/office-location/mark routes; employees: pin_set),
--   and every read of a secret column is a server route on the admin client or a SECURITY
--   DEFINER function (validate_presence_code, mark_attendance, mark_self_attendance).
--   Re-runnable.
--
-- Test: supabase/tests/secret_columns_hidden.test.sql
-- Guard: src/lib/security/secret-columns.test.ts

begin;

-- ── attendance_settings ──────────────────────────────────────────────────────────
revoke select, insert, update, references on table public.attendance_settings from authenticated, anon;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attendance_settings'
     and column_name not in ('presence_secret', 'ingest_key');
  execute format('grant select (%s) on public.attendance_settings to authenticated', cols);
end $$;

grant insert (tenant_id, allowed_ips, updated_at, require_selfie, require_presence,
              selfie_retention_days, require_face_match,
              shift_start, shift_end, late_grace_minutes, half_day_under_hours,
              require_device)
  on public.attendance_settings to authenticated;
grant update (tenant_id, allowed_ips, updated_at, require_selfie, require_presence,
              selfie_retention_days, require_face_match,
              shift_start, shift_end, late_grace_minutes, half_day_under_hours,
              require_device)
  on public.attendance_settings to authenticated;

grant all on table public.attendance_settings to service_role;

-- ── employees ────────────────────────────────────────────────────────────────────
revoke select on table public.employees from authenticated, anon;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'employees' and column_name <> 'pin_hash';
  execute format('grant select (%s) on public.employees to authenticated', cols);
end $$;

grant all on table public.employees to service_role;

-- ── ad_accounts ──────────────────────────────────────────────────────────────────
revoke select on table public.ad_accounts from authenticated, anon;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ad_accounts' and column_name <> 'access_token';
  execute format('grant select (%s) on public.ad_accounts to authenticated', cols);
end $$;

grant all on table public.ad_accounts to service_role;

-- ── user_google_tokens ───────────────────────────────────────────────────────────
-- Google refresh/access tokens. No browser policy (RLS hides every row) and every reader is a
-- server route on the admin client — but baseline still hands authenticated/anon a table-level
-- SELECT. Take it away so a future policy cannot expose the tokens by accident.
revoke select on table public.user_google_tokens from authenticated, anon;
grant all on table public.user_google_tokens to service_role;

commit;
