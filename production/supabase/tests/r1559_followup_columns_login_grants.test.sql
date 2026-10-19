-- Regression test for 20261018220847_r1559_definer_grants.sql (R-1559)
--
-- WHAT IT PROVES (self-asserting; whole file rolls back)
--   1. A sales user can still edit the note on their own payment follow-up.
--   2. … but cannot rewrite who wrote it (created_by) or when (created_at)        ← was allowed
--      — not even an owner can. tenant_id / customer_id cannot be moved either.
--   3. An insert cannot choose its own id or created_at (back-dated history).
--   4. The normal insert (the app's column set, created_by from auth.uid()) still works.
--   5. public.login_profile_id_for_email (any email → user id, every company) is NOT
--      executable by anon, authenticated or service_role — only the login role app_auth.
--      The function comes from prisma/migrations/20261009200000_login_profile_lookup; where
--      that has not run (local Supabase) this file creates it the same way, as postgres,
--      so it also proves postgres' default privileges no longer hand new functions to
--      anon/authenticated.
--
-- Run it in one rollback with the migration (CLAUDE.md §17c):
--   begin; <migration without begin/commit> <this file without begin/rollback> rollback;

begin;

create temp table r1559_login_fn_created on commit drop as
  select to_regprocedure('public.login_profile_id_for_email(text)') is null as created;

do $$ begin
  if to_regprocedure('public.login_profile_id_for_email(text)') is null then
    -- same body + grants as prisma/migrations/20261009200000_login_profile_lookup
    execute $f$
      create function public.login_profile_id_for_email(p_email text) returns uuid
        language sql stable security definer set search_path = ''
      as $b$
        select u.id from public.users u
         where lower(u.email) = lower(btrim(p_email)) and u.is_active
         order by u.created_at, u.id limit 1;
      $b$ $f$;
    execute 'revoke all on function public.login_profile_id_for_email(text) from public';
  end if;
end $$;

insert into auth.users (id, email) values
  ('f1559000-0000-0000-0000-0000000000a1', 'r1559-owner@example.test'),
  ('f1559000-0000-0000-0000-0000000000a5', 'r1559-sales@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('f1559000-0000-0000-0000-00000000aaaa', 'R1559 A', 'r1559-a@example.test', '07', 'R59A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('f1559000-0000-0000-0000-0000000000a1', 'f1559000-0000-0000-0000-00000000aaaa', 'r1559-owner@example.test', 'R1559 Owner', 'owner', true),
  ('f1559000-0000-0000-0000-0000000000a5', 'f1559000-0000-0000-0000-00000000aaaa', 'r1559-sales@example.test', 'R1559 Sales', 'sales', true);

insert into public.customers (id, tenant_id, name, account_manager_id) values
  ('f1559000-0000-0000-0000-0000000000ca', 'f1559000-0000-0000-0000-00000000aaaa', 'R1559 Customer', 'f1559000-0000-0000-0000-0000000000a5'),
  ('f1559000-0000-0000-0000-0000000000cb', 'f1559000-0000-0000-0000-00000000aaaa', 'R1559 Customer 2', 'f1559000-0000-0000-0000-0000000000a5');

-- 5. login lookup: only app_auth (where it exists) may run it
do $$
declare
  r text;
  v_roles text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- Created just above (local Supabase): this proves the DEFAULT privileges — anon and
  -- authenticated get nothing by default any more. service_role keeps its default here;
  -- the explicit revoke from it is proven where the function already existed (staging/live).
  if (select created from r1559_login_fn_created) then
    v_roles := array['anon', 'authenticated'];
  end if;
  foreach r in array v_roles loop
    if has_function_privilege(r, 'public.login_profile_id_for_email(text)', 'EXECUTE') then
      raise exception 'FAIL 5: % can EXECUTE login_profile_id_for_email (any email → user id across companies)', r;
    end if;
  end loop;
end $$;

set local role authenticated;

do $$
declare
  v_a     uuid := 'f1559000-0000-0000-0000-00000000aaaa';
  v_owner uuid := 'f1559000-0000-0000-0000-0000000000a1';
  v_sales uuid := 'f1559000-0000-0000-0000-0000000000a5';
  v_cust  uuid := 'f1559000-0000-0000-0000-0000000000ca';
  v_cust2 uuid := 'f1559000-0000-0000-0000-0000000000cb';
  v_row   uuid;
  v_by    uuid;
  v_at    timestamptz;
  v_state text;
  v_n     int;
begin
  -- 4. the app's insert (followup-rules.ts buildFollowupInsert) still works
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  insert into public.payment_followups
    (tenant_id, customer_id, kind, note, promised_amount, promised_on, next_follow_up_on,
     assigned_to, invoice_id, quote_id, subscription_id)
  values (v_a, v_cust, 'call', 'sales logs a call', null, null, current_date + 2, v_sales, null, null, null)
  returning id, created_by, created_at into v_row, v_by, v_at;
  if v_by is distinct from v_sales then
    raise exception 'FAIL 4: created_by not stamped from the login (got %)', v_by;
  end if;

  -- 1. sales edits the note on its own row
  update public.payment_followups set note = 'sales edits the note', next_follow_up_on = current_date + 5
   where id = v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 1: sales could not edit its own follow-up (rows %)', v_n;
  end if;

  -- 2. created_by / created_at / tenant_id / customer_id are not editable — sales or owner
  foreach v_state in array array['sales', 'owner'] loop
    perform set_config('request.jwt.claims', json_build_object(
      'sub', case when v_state = 'sales' then v_sales else v_owner end, 'role', 'authenticated')::text, true);
    begin
      update public.payment_followups set created_by = v_owner where id = v_row;
      raise exception 'FAIL 2a: % rewrote created_by on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set created_at = now() - interval '30 days' where id = v_row;
      raise exception 'FAIL 2b: % back-dated created_at on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set customer_id = v_cust2 where id = v_row;
      raise exception 'FAIL 2c: % moved a follow-up to another customer', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set tenant_id = v_a where id = v_row;
      raise exception 'FAIL 2d: % could write tenant_id on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- 3. insert cannot pick id or created_at
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, created_at)
    values (v_a, v_cust, 'note', 'back-dated', now() - interval '90 days');
    raise exception 'FAIL 3a: insert chose its own created_at';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.payment_followups (id, tenant_id, customer_id, kind, note)
    values (gen_random_uuid(), v_a, v_cust, 'note', 'own id');
    raise exception 'FAIL 3b: insert chose its own id';
  exception when insufficient_privilege then null;
  end;

  raise notice 'R-1559: payment_followups columns + login lookup grants: all checks passed';
end $$;

reset role;

-- 6. R-1622: the staging deploy runs supabase/cloudsql/09-grant-what-policies-allow.sql AFTER
--    the migrations. Before R-1622 it handed authenticated table-level INSERT/UPDATE on
--    payment_followups back (its policies cover insert/update), undoing (a) — the deploy peek
--    r1559grants stayed false on staging. Simulate that leak, run 09's block (byte-identical
--    copy, kept in step by src/lib/security/secret-columns.test.ts), and prove the column
--    grants hold again.
grant insert, update on public.payment_followups to authenticated;

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
  -- R-1622: tables whose INSERT/UPDATE are COLUMN grants by design (no secret column — SELECT
  -- and DELETE stay table-level). A table-level INSERT/UPDATE here would undo the column list.
  -- payment_followups: R-1559 (created_by / created_at / tenant_id / customer_id not writable).
  colgrant_tables text[] := array[
    'payment_followups'
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

    -- R-1622: column-granted tables — table-level SELECT/DELETE as usual, never INSERT/UPDATE.
    if rec.relname = any(colgrant_tables) then
      foreach wpriv in array array['SELECT', 'DELETE'] loop
        continue when not (rec.polcmd = '*' or (rec.polcmd = 'r' and wpriv = 'SELECT') or (rec.polcmd = 'd' and wpriv = 'DELETE'));
        continue when has_table_privilege(rec.rolname, rec.oid, wpriv);
        begin
          execute format('grant %s on public.%I to %I', lower(wpriv), rec.relname, rec.rolname);
          raise notice 'granted % on % to %', lower(wpriv), rec.relname, rec.rolname;
          n := n + 1;
        exception when insufficient_privilege then
          raise notice 'SKIPPED % on % (not owner — run this file again as postgres for it)', lower(wpriv), rec.relname;
        end;
      end loop;
      if rec.polcmd in ('a', 'w', '*') then
        raise notice 'column grants: no table-level % on % for % (its migrations grant columns)', priv, rec.relname, rec.rolname;
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

  -- R-1622: column-granted tables — a table-level INSERT/UPDATE/REFERENCES on top of the
  -- column grants (what this file did on every run before R-1622) is revoked, columns kept.
  foreach t in array colgrant_tables loop
    select c.oid into v_oid
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relkind = 'r';
    continue when v_oid is null;
    begin
      foreach v_role in array array['authenticated', 'anon'] loop
        foreach wpriv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
          continue when not has_table_privilege(v_role, v_oid, wpriv);
          select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
            from pg_attribute a cross join lateral aclexplode(a.attacl) x
           where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped
             and x.grantee = (select oid from pg_roles where rolname = v_role)
             and x.privilege_type = wpriv;
          if v_cols is null then
            -- No column grants (its migration has not run here) — revoking would block every write.
            raise notice 'NOTE table-level % on % for % kept (no column grants — run its migration first)', lower(wpriv), t, v_role;
            continue;
          end if;
          execute format('revoke %s on table public.%I from %I', wpriv, t, v_role);  -- also drops its column grants
          execute format('grant %s (%s) on public.%I to %I', wpriv, v_cols, t, v_role);
          raise notice 'revoked table-level % on % from % (kept its column grants)', lower(wpriv), t, v_role;
          n := n + 1;
        end loop;
      end loop;
    exception when insufficient_privilege then
      raise notice 'SKIPPED column-grant check on % (not owner — run this file again as postgres for it)', t;
    end;
  end loop;

  raise notice 'done: % grant(s)', n;
end $$;
-- END 09 GRANT BLOCK

do $$
begin
  if has_table_privilege('authenticated', 'public.payment_followups', 'INSERT') then
    raise exception 'FAIL 6a: 09 left table-level INSERT on payment_followups for authenticated';
  end if;
  if has_table_privilege('authenticated', 'public.payment_followups', 'UPDATE') then
    raise exception 'FAIL 6b: 09 left table-level UPDATE on payment_followups for authenticated';
  end if;
  if has_column_privilege('authenticated', 'public.payment_followups', 'created_by', 'UPDATE') then
    raise exception 'FAIL 6c: after 09 authenticated can UPDATE created_by (peek r1559grants false)';
  end if;
  if has_column_privilege('authenticated', 'public.payment_followups', 'created_at', 'INSERT') then
    raise exception 'FAIL 6d: after 09 authenticated can INSERT created_at';
  end if;
  if not has_column_privilege('authenticated', 'public.payment_followups', 'note', 'UPDATE') then
    raise exception 'FAIL 6e: 09 dropped the column UPDATE on note';
  end if;
  if not has_column_privilege('authenticated', 'public.payment_followups', 'created_by', 'INSERT') then
    raise exception 'FAIL 6f: 09 dropped the column INSERT on created_by';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_followups', 'SELECT') then
    raise exception 'FAIL 6g: 09 dropped table-level SELECT on payment_followups';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_followups', 'DELETE') then
    raise exception 'FAIL 6h: 09 dropped table-level DELETE on payment_followups';
  end if;
end $$;

set local role authenticated;

do $$
declare
  v_a     uuid := 'f1559000-0000-0000-0000-00000000aaaa';
  v_owner uuid := 'f1559000-0000-0000-0000-0000000000a1';
  v_sales uuid := 'f1559000-0000-0000-0000-0000000000a5';
  v_cust  uuid := 'f1559000-0000-0000-0000-0000000000ca';
  v_row   uuid;
  v_n     int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  insert into public.payment_followups (tenant_id, customer_id, kind, note, assigned_to)
  values (v_a, v_cust, 'call', 'after 09', v_sales)
  returning id into v_row;

  update public.payment_followups set note = 'after 09 - edited' where id = v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 6i: after 09 sales could not edit its own follow-up note (rows %)', v_n;
  end if;

  begin
    update public.payment_followups set created_by = v_owner where id = v_row;
    raise exception 'FAIL 6j: after 09 sales rewrote created_by';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, created_at)
    values (v_a, v_cust, 'note', 'back-dated after 09', now() - interval '90 days');
    raise exception 'FAIL 6k: after 09 an insert chose its own created_at';
  exception when insufficient_privilege then null;
  end;

  raise notice 'R-1622: 09 keeps payment_followups INSERT/UPDATE as column grants: all checks passed';
end $$;

reset role;

rollback;
