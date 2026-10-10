-- ============================================================================
-- 09 (5 Oct 2026): give `authenticated` / `anon` the table privileges their RLS policies
-- already describe — and nothing more.
--
-- WHY
--   Staging, /subscriptions: "403 Forbidden on GET /rest/v1/customer_contacts". The table has
--   select/insert/update/delete policies for signed-in users, but `authenticated` has no SELECT
--   privilege on it at all. 30 public tables were in that state. They were all created by
--   migrations written the hosted-Supabase way, where default privileges hand every new table to
--   authenticated/anon; on Cloud SQL those defaults were deferred (01b), so a migration without
--   an explicit GRANT leaves the table unreadable however correct its policies are.
--
-- WHAT IT DOES
--   For every public table with RLS on, for every policy that applies to `authenticated`, `anon`
--   or PUBLIC, grant exactly the command(s) that policy covers (SELECT / INSERT / UPDATE /
--   DELETE; ALL = the four). A table with only service_role policies gets nothing — those are
--   server-only on purpose (rate_limit_buckets, email_verifications, …). RLS still decides which
--   ROWS anyone sees; this only lets the policies be reached.
--
-- SECRET COLUMNS (R-833, 10 Oct 2026)
--   Some tables hold a column no browser may ever read: attendance_settings.presence_secret
--   (seed of the rotating office code — whoever reads it can compute the code), .ingest_key
--   (the biometric device's shared key), employees.pin_hash (kiosk PIN hash), ad_accounts.
--   access_token (Meta token), user_google_tokens.* tokens, email_verifications.token_hash.
--   Their migrations use COLUMN grants on purpose (a table-level SELECT overrides any column
--   revoke). Until R-833 this file checked has_table_privilege(), which ignores column grants,
--   so EVERY run handed `authenticated` table-level SELECT on attendance_settings, employees and
--   ad_accounts (secrets readable by every member) and table-level INSERT/UPDATE on
--   attendance_settings (owner/manager could overwrite the office-code seed and the RPC-only
--   geofence columns). Now, for a table in `secret_cols` below:
--     • SELECT is never granted at table level: a role whose policy covers SELECT gets column
--       SELECT on every column EXCEPT the secret ones; a table-level SELECT it already holds
--       is revoked first (also when RLS is off on that table).
--     • INSERT / UPDATE / REFERENCES are never granted at table level. A table-level one already
--       held on top of column grants (the column-granted design) is revoked and the role's own
--       column grants are put back, minus the secret columns. Where there are no column grants
--       (table-level is that table's design, e.g. employees UPDATE) it is left alone and named.
--     • Any direct grant on a secret column itself is revoked.
--     • DELETE has no columns — handled as before.
--   A new secret column: add it to `secret_cols` AND to SECRET_COLUMNS in
--   src/lib/security/secret-columns.test.ts (that test fails until you do).
--
--   Safe to re-run: GRANT/REVOKE are idempotent. Prints every grant it makes (NOTICE).
--   Run as the table owner (resellersos_migration):
--     gcloud sql import sql <instance> gs://…/09-grant-what-policies-allow.sql --database=resellersos --user=resellersos_migration
--   Test: supabase/tests/secret_columns_hidden.test.sql runs this same block (kept identical
--   by src/lib/security/secret-columns.test.ts).
-- ============================================================================
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
