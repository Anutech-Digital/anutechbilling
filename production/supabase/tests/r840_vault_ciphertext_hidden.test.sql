\set ON_ERROR_STOP on
-- Regression test: R-840 (20261011081000_r840_vault_ciphertext_columns.sql + cloudsql/09).
-- vault_passwords.*_ciphertext (customers' admin-console logins, encrypted) never reach a
-- browser role. Rolled back — safe anywhere. The ciphertexts here are dummy strings.
--
--   BLOCKED  our owner (authenticated) reading username/password/notes_ciphertext — permission denied
--   ALLOWED  the same owner listing the non-secret columns (id, title, category, url, fingerprint …)
--   BLOCKED  our owner writing a ciphertext directly (INSERT / UPDATE) — the API does that server-side
--   ALLOWED  our owner adding / renaming an entry's non-secret columns (RLS R-716 still applies)
--   BLOCKED  a sales login seeing the row at all (R-716 RLS, unchanged)
--   BLOCKED  anon touching the table
--   ALLOWED  service_role (the server, after vaultGate()) reading the ciphertext
--   AGAIN    after an old-09-style leak (table-level SELECT/INSERT/UPDATE handed back to
--            `authenticated`, what 09 did on every staging deploy-db run before R-840) the
--            CURRENT 09 block is run — and every check above holds again.
--
-- The block between "BEGIN 09 GRANT BLOCK" and "END 09 GRANT BLOCK" is a byte-for-byte copy of
-- supabase/cloudsql/09-grant-what-policies-allow.sql (CI does not apply cloudsql/ files);
-- src/lib/security/secret-columns.test.ts fails if the two drift apart.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('84000000-0000-4000-8000-000000000001', 'R840 SELLER', 'r840@example.in', '07', 'R840');
insert into auth.users (id, instance_id, aud, role, email) values
  ('84000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r840-owner@example.in'),
  ('84000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r840-sales@example.in');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('84000000-0000-4000-8000-00000000000a', '84000000-0000-4000-8000-000000000001', 'r840-owner@example.in', 'owner', true),
  ('84000000-0000-4000-8000-00000000000b', '84000000-0000-4000-8000-000000000001', 'r840-sales@example.in', 'sales', true);
insert into public.vault_passwords (id, tenant_id, title, category, username_ciphertext, password_ciphertext, notes_ciphertext, password_fingerprint)
  values ('84000000-0000-4000-8000-0000000000f1', '84000000-0000-4000-8000-000000000001', 'R840 Google Admin', 'google_admin',
          'r840-dummy-user-ct', 'r840-dummy-pass-ct', 'r840-dummy-notes-ct', 'r840print');

create function pg_temp.r840_checks(p_round text) returns void language plpgsql as $f$
declare
  v_err boolean; v_n int; v_t text; v_col text;
  c_seller constant uuid := '84000000-0000-4000-8000-000000000001';
  c_row    constant uuid := '84000000-0000-4000-8000-0000000000f1';
begin
  -- ── our owner ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','84000000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  execute 'set local role authenticated';

  foreach v_col in array array['username_ciphertext', 'password_ciphertext', 'notes_ciphertext'] loop
    v_err := false;
    begin execute format('select %I from public.vault_passwords where id = %L', v_col, c_row) into v_t;
    exception when insufficient_privilege then v_err := true; end;
    if not v_err then raise exception 'FAIL 1% : the owner (authenticated) can read vault_passwords.%', p_round, v_col; end if;
  end loop;

  v_err := false;
  begin perform * from public.vault_passwords where id = c_row;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2% : select * on vault_passwords works for authenticated (ciphertext included)', p_round; end if;

  select count(*) into v_n from (
    select id, tenant_id, customer_id, title, category, url, password_fingerprint,
           last_rotated_at, created_by, created_at, updated_at
      from public.vault_passwords where id = c_row) x;
  if v_n <> 1 then raise exception 'FAIL 3% : the owner cannot list the vault row''s normal columns (% rows)', p_round, v_n; end if;

  v_err := false;
  begin
    insert into public.vault_passwords (tenant_id, title, category, password_ciphertext)
      values (c_seller, 'R840 direct ct insert', 'other', 'r840-dummy');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 4% : the owner wrote a ciphertext with INSERT through REST', p_round; end if;

  v_err := false;
  begin
    update public.vault_passwords set password_ciphertext = 'r840-overwrite' where id = c_row;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 5% : the owner overwrote a ciphertext with UPDATE through REST', p_round; end if;

  insert into public.vault_passwords (tenant_id, title, category)
    values (c_seller, 'R840 owner insert ' || p_round, 'other');
  update public.vault_passwords set title = 'R840 Google Admin (' || p_round || ')' where id = c_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 6% : the owner could not rename the vault row (% rows)', p_round, v_n; end if;

  -- ── a sales login: RLS hides the row (R-716) ───────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','84000000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  select count(*) into v_n from public.vault_passwords where id = c_row;
  if v_n <> 0 then raise exception 'FAIL 7% : a sales login can see % vault row(s)', p_round, v_n; end if;
  execute 'reset role';

  -- ── anon ───────────────────────────────────────────────────────────────
  execute 'set local role anon';
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  v_err := false;
  begin perform id from public.vault_passwords limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8% : anon can read vault_passwords', p_round; end if;
  execute 'reset role';

  -- ── service_role (the server, after vaultGate()) still reads the ciphertext ─
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select password_ciphertext into v_t from public.vault_passwords where id = c_row and tenant_id = c_seller;
  if v_t is distinct from 'r840-dummy-pass-ct' then raise exception 'FAIL 9% : service_role cannot read the ciphertext', p_round; end if;
  execute 'reset role';
end $f$;

select pg_temp.r840_checks('a');

-- ── round b: the old 09 leak, then the CURRENT 09 block ─────────────────
grant select, insert, update on table public.vault_passwords to authenticated;

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
    'email_verifications.token_hash',
    'vault_passwords.username_ciphertext',
    'vault_passwords.password_ciphertext',
    'vault_passwords.notes_ciphertext'
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
select pg_temp.r840_checks('b');

do $$ begin raise notice 'r840_vault_ciphertext_hidden: all checks passed (rounds a + b)'; end $$;

rollback;
