-- Regression test: R-833 (20261011013300_secret_columns_hidden.sql + supabase/cloudsql/09).
-- Rolled back — safe anywhere.
--
--   BLOCKED  a member (sales) and the owner reading attendance_settings.presence_secret /
--            .ingest_key, employees.pin_hash, ad_accounts.access_token — permission denied
--   ALLOWED  the same logins reading the normal columns (office hours, grace, half day,
--            geofence, require_* switches; employees.name/pin_set; ad_accounts.name)
--   BLOCKED  the owner writing presence_secret / office_lat directly (server / RPC only);
--   ALLOWED  the owner writing require_selfie (settings column grant)
--   AGAIN    after an old-09-style leak (table-level SELECT/INSERT/UPDATE handed back to
--            `authenticated`, exactly what 09 did on every staging deploy-db run before R-833)
--            the CURRENT 09 block is run — and every check above holds again.
--
-- The block between "BEGIN 09 GRANT BLOCK" and "END 09 GRANT BLOCK" is a byte-for-byte copy of
-- supabase/cloudsql/09-grant-what-policies-allow.sql (CI does not apply cloudsql/ files);
-- src/lib/security/secret-columns.test.ts fails if the two drift apart.
-- With the old 09 (has_table_privilege → table-level grant) the round-b checks fail.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('48330000-0000-4000-8000-000000000001', 'R833 TEST', 'r833@example.in', '07', 'R833');
insert into auth.users (id, instance_id, aud, role, email) values
  ('48330000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r833-owner@example.in'),
  ('48330000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r833-sales@example.in');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('48330000-0000-4000-8000-00000000000a', '48330000-0000-4000-8000-000000000001', 'r833-owner@example.in', 'owner', true),
  ('48330000-0000-4000-8000-00000000000b', '48330000-0000-4000-8000-000000000001', 'r833-sales@example.in', 'sales', true);
insert into public.attendance_settings (tenant_id, presence_secret, ingest_key, require_presence, office_lat, office_lng, geofence_mode)
  values ('48330000-0000-4000-8000-000000000001', 'r833-test-seed-not-real', 'r833-test-ingest-not-real', true, 28.6, 77.2, 'flag');
insert into public.employees (id, tenant_id, name, is_active, pin_hash)
  values ('48330000-0000-4000-8000-0000000000e1', '48330000-0000-4000-8000-000000000001', 'R833 Emp', true, crypt('1357', gen_salt('bf')));
insert into public.ad_accounts (tenant_id, platform, account_id, name, access_token)
  values ('48330000-0000-4000-8000-000000000001', 'meta-ads', 'act_r833', 'R833 Ads', 'r833-test-token-not-real');

-- The checks, run before and after the 09 block. A temp function keeps them in one place.
create function pg_temp.r833_checks(p_round text) returns void language plpgsql as $f$
declare v_err boolean; v_t time; v_g int; v_h numeric; v_mode text; v_lat double precision;
        v_name text; v_set boolean; v_rp boolean; v_who text; v_n int;
begin
  foreach v_who in array array['48330000-0000-4000-8000-00000000000b', '48330000-0000-4000-8000-00000000000a'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    v_err := false;
    begin perform presence_secret from public.attendance_settings;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 1% (%): authenticated can read attendance_settings.presence_secret', p_round, v_who; end if;

    v_err := false;
    begin perform ingest_key from public.attendance_settings;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 2% (%): authenticated can read attendance_settings.ingest_key', p_round, v_who; end if;

    v_err := false;
    begin perform pin_hash from public.employees;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 3% (%): authenticated can read employees.pin_hash', p_round, v_who; end if;

    v_err := false;
    begin perform access_token from public.ad_accounts;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 4% (%): authenticated can read ad_accounts.access_token', p_round, v_who; end if;

    v_err := false;
    begin perform * from public.attendance_settings;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 5% (%): select * on attendance_settings works — a table-level SELECT is back', p_round, v_who; end if;

    -- normal columns: what /api/attendance/network, office-location and lib/attendance/shift read
    select shift_start, late_grace_minutes, half_day_under_hours, geofence_mode, office_lat, require_presence
      into v_t, v_g, v_h, v_mode, v_lat, v_rp
      from public.attendance_settings where tenant_id = '48330000-0000-4000-8000-000000000001';
    if v_mode is distinct from 'flag' or v_lat is distinct from 28.6::double precision or v_rp is not true
       or v_t is null or v_g is null or v_h is null then
      raise exception 'FAIL 6% (%): normal attendance_settings columns not readable (% % %)', p_round, v_who, v_mode, v_lat, v_rp;
    end if;
    perform allowed_ips, require_selfie, selfie_retention_days, require_face_match, require_device,
            shift_end, office_lng, office_radius_m, updated_at
      from public.attendance_settings;

    select name, pin_set into v_name, v_set from public.employees where id = '48330000-0000-4000-8000-0000000000e1';
    if v_name is distinct from 'R833 Emp' or v_set is not true then
      raise exception 'FAIL 7% (%): employees name/pin_set not readable (% %)', p_round, v_who, v_name, v_set;
    end if;

    select count(*) into v_n from public.ad_accounts where name = 'R833 Ads' and token_expires_at is null;
    if v_n <> 1 then raise exception 'FAIL 8% (%): ad_accounts normal columns not readable', p_round, v_who; end if;

    execute 'reset role';
  end loop;

  -- owner writes: the seed and the geofence are not his to write directly; the switches are
  perform set_config('request.jwt.claims', json_build_object('sub', '48330000-0000-4000-8000-00000000000a', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_err := false;
  begin update public.attendance_settings set presence_secret = 'r833-known' where tenant_id = '48330000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 9%: the owner can overwrite presence_secret directly', p_round; end if;

  v_err := false;
  begin update public.attendance_settings set office_lat = 1 where tenant_id = '48330000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10%: the owner can write office_lat directly (set_office_location only)', p_round; end if;

  update public.attendance_settings set require_selfie = false where tenant_id = '48330000-0000-4000-8000-000000000001';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 11%: the owner cannot save require_selfie (% rows)', p_round, v_n; end if;
  execute 'reset role';

  -- anon: nothing at all
  execute 'set local role anon';
  v_err := false;
  begin perform presence_secret from public.attendance_settings;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 12%: anon can read presence_secret', p_round; end if;
  execute 'reset role';
end $f$;

select pg_temp.r833_checks('a');

-- ── AGAIN: hand back what the old 09 granted on every run, then run the CURRENT 09 ──────────
grant select, insert, update on public.attendance_settings to authenticated;
grant select on public.employees to authenticated;
grant select on public.ad_accounts to authenticated;

-- BEGIN 09 GRANT BLOCK
do $$
declare
  rec record;
  priv text;
  n int := 0;
  -- R-833: "table.column" — columns no browser role may read or write. Keep in step with
  -- SECRET_COLUMNS in src/lib/security/secret-columns.test.ts.
  secret_cols text[] := array[
    'attendance_settings.presence_secret',
    'attendance_settings.ingest_key',
    'employees.pin_hash',
    'ad_accounts.access_token',
    'user_google_tokens.access_token',
    'user_google_tokens.refresh_token',
    'user_google_tokens.sync_token',
    'email_verifications.token_hash'
  ];
  secret_tables text[];
  sel_needed text[] := '{}';   -- "table|role" pairs whose policies cover SELECT
  t text;
  v_oid oid;
  v_role text;
  v_cols text;
  v_rls boolean;
  wpriv text;
  scol text;
begin
  select array_agg(distinct split_part(x, '.', 1)) into secret_tables from unnest(secret_cols) as x;

  for rec in
    select c.oid, c.relname, p.polcmd, r.rolname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      cross join lateral (
        select case when x = 0 then 'public' else (select rolname from pg_roles where oid = x) end as rolname
          from unnest(p.polroles) as x
      ) r
     where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and r.rolname in ('authenticated', 'anon', 'public')
  loop
    priv := case rec.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'select, insert, update, delete' end;
    -- PUBLIC policies are meant for signed-in users here; give them to authenticated only.
    if rec.rolname = 'public' then rec.rolname := 'authenticated'; end if;

    -- R-833: a table with secret columns never gets a table-level SELECT/INSERT/UPDATE here.
    if rec.relname = any(secret_tables) then
      if rec.polcmd in ('r', '*') then
        sel_needed := sel_needed || (rec.relname || '|' || rec.rolname);
      end if;
      if rec.polcmd in ('d', '*') and not has_table_privilege(rec.rolname, rec.oid, 'DELETE') then
        begin
          execute format('grant delete on public.%I to %I', rec.relname, rec.rolname);
          raise notice 'granted delete on % to %', rec.relname, rec.rolname;
          n := n + 1;
        exception when insufficient_privilege then
          raise notice 'SKIPPED delete on % (not owner — run this file again as postgres for it)', rec.relname;
        end;
      end if;
      if rec.polcmd in ('a', 'w', '*') then
        raise notice 'secret columns: no table-level % on % for % (its migrations grant columns)', priv, rec.relname, rec.rolname;
      end if;
      continue;
    end if;

    if priv = 'select, insert, update, delete' or not has_table_privilege(rec.rolname, rec.oid, upper(priv)) then
      begin
        execute format('grant %s on public.%I to %I', priv, rec.relname, rec.rolname);
        raise notice 'granted % on % to %', priv, rec.relname, rec.rolname;
        n := n + 1;
        -- An INSERT on a table with a serial/identity column also needs its sequence.
        if priv like '%insert%' then
          for priv in
            select format('grant usage, select on sequence %s to %I', s.oid::regclass, rec.rolname)
              from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
             where s.relkind = 'S' and d.refobjid = rec.oid
          loop
            execute priv;
          end loop;
        end if;
      exception when insufficient_privilege then
        -- Not the owner (e.g. the Academy tables belong to postgres) — say so, carry on.
        raise notice 'SKIPPED % on % (not owner — run this file again as postgres for it)', priv, rec.relname;
      end;
    end if;
  end loop;

  -- R-833: secret tables — column grants only, secret columns never.
  foreach t in array secret_tables loop
    select c.oid, c.relrowsecurity into v_oid, v_rls
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relkind = 'r';
    continue when v_oid is null;
    begin
      foreach v_role in array array['authenticated', 'anon'] loop
        -- SELECT: column grants on every non-secret column, only for a role a policy lets read.
        if has_table_privilege(v_role, v_oid, 'SELECT') and ((t || '|' || v_role) = any(sel_needed) or not v_rls) then
          execute format('revoke select on table public.%I from %I', t, v_role);  -- also drops its column SELECTs
          raise notice 'revoked table-level select on % from % (secret columns)', t, v_role;
          n := n + 1;
        end if;
        if (t || '|' || v_role) = any(sel_needed) then
          select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
            from pg_attribute a
           where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped
             and (t || '.' || a.attname) <> all(secret_cols);
          execute format('grant select (%s) on public.%I to %I', v_cols, t, v_role);
        end if;

        -- INSERT / UPDATE / REFERENCES: a table-level grant on top of column grants is a leak.
        foreach wpriv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
          if has_table_privilege(v_role, v_oid, wpriv) then
            select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
              from pg_attribute a cross join lateral aclexplode(a.attacl) x
             where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped
               and x.grantee = (select oid from pg_roles where rolname = v_role)
               and x.privilege_type = wpriv
               and (t || '.' || a.attname) <> all(secret_cols);
            if v_cols is not null then
              execute format('revoke %s on table public.%I from %I', wpriv, t, v_role);
              execute format('grant %s (%s) on public.%I to %I', wpriv, v_cols, t, v_role);
              raise notice 'revoked table-level % on % from % (kept its column grants)', lower(wpriv), t, v_role;
              n := n + 1;
            else
              raise notice 'NOTE table-level % on % for % kept (no column grants — that table''s design)', lower(wpriv), t, v_role;
            end if;
          end if;
        end loop;

        -- Any direct grant on a secret column itself goes.
        foreach scol in array secret_cols loop
          continue when split_part(scol, '.', 1) <> t;
          continue when not exists (select 1 from pg_attribute a where a.attrelid = v_oid
                                       and a.attname = split_part(scol, '.', 2) and not a.attisdropped);
          foreach wpriv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
            if has_column_privilege(v_role, v_oid, split_part(scol, '.', 2), wpriv)
               and not has_table_privilege(v_role, v_oid, wpriv) then
              execute format('revoke %s (%I) on public.%I from %I', wpriv, split_part(scol, '.', 2), t, v_role);
              raise notice 'revoked % on % from %', lower(wpriv), scol, v_role;
              n := n + 1;
            end if;
          end loop;
        end loop;
      end loop;
    exception when insufficient_privilege then
      raise notice 'SKIPPED secret-column check on % (not owner — run this file again as postgres for it)', t;
    end;
  end loop;

  raise notice 'done: % grant(s)', n;
end $$;
-- END 09 GRANT BLOCK

select pg_temp.r833_checks('b');

do $$ begin raise notice 'secret_columns_hidden: all checks passed (before and after 09)'; end $$;

rollback;
