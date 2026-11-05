\set ON_ERROR_STOP on
-- R-2487: on Cloud SQL the auth uid()/role() shims answer for the data gateway logins
-- (app_runtime / app_jobs / app_service / app_anon) like public.current_user_id() /
-- current_request_role(), so the ~153 raw "v_trusted" RPC checks, guard_privileged_user_columns
-- and the books-lock triggers behave on live as on staging.
-- Migration: 20261105021052_r2487_cloudsql_auth_shims_gateway_logins.sql. Rolled back — safe anywhere.
--
--   1  on Supabase (no cloudsqlsuperuser role) the migration left GoTrue's auth functions alone
--   2  (superuser only — `set session authorization` is the only way to become another LOGIN, and
--      session_user is what the shims and the v_trusted lists read; CI's postgres is not a
--      superuser, so there this case says SKIPPED; run it with
--      `docker exec -i supabase_db_<project> psql -U supabase_admin -d postgres < this file`)
--      a  BEFORE: with the claims-only shim, app_anon and app_jobs read role NULL and pass the
--         v_trusted test, app_runtime reads uid NULL — the hole (this half is the "red")
--      b  the migration's block (pasted between the r2487-shim markers; the vitest scan checks
--         it is byte-equal to the migration's) installs on a stand-in Cloud SQL
--      c  AFTER: app_anon → anon, app_jobs → app_jobs, app_runtime → authenticated + app.user_id,
--         app_service → service_role; none of app_anon / app_jobs / app_runtime is trusted;
--         app_service still is; a claims-only PostgREST session reads its claims as before
--      d  a second run is a no-op that still holds (re-runnable deploy)

begin;

-- ── 1: Supabase untouched ───────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cloudsqlsuperuser') then
    raise notice 'R-2487 case 1 SKIPPED: this is Cloud SQL';
    return;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'auth' and p.proname in ('uid', 'role') and p.prosrc like '%R-2487%') then
    raise exception 'FAIL 1: R-2487 changed the Supabase auth schema (must be Cloud SQL only)';
  end if;
end $$;

-- ── 2: Cloud SQL behaviour (superuser only) ─────────────────────────────────────────────
select (select rolsuper from pg_roles where rolname = current_user) as r2487_super \gset

\if :r2487_super

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'cloudsqlsuperuser') then create role cloudsqlsuperuser nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then create role app_runtime nologin in role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_anon')    then create role app_anon nologin in role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_jobs')    then create role app_jobs nologin in role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then create role app_service nologin in role service_role; end if;
end $$;

create temp table r2487_seen (phase text, login text, role text, uid uuid, trusted boolean);
grant all on r2487_seen to public;

-- One row per login: what the shims say, and the exact v_trusted test the 153 bodies use.
create or replace function pg_temp.r2487_probe(p_phase text) returns void language plpgsql as $p$
declare l text;
begin
  foreach l in array array['app_runtime', 'app_jobs', 'app_service', 'app_anon'] loop
    execute format('set session authorization %I', l);
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000002487', true);
    insert into r2487_seen
    select p_phase, session_user::text, auth.role(), auth.uid(),
           coalesce(auth.role(), '') = 'service_role'
           or (auth.role() is null
               and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
    reset session authorization;
    perform set_config('app.user_id', '', true);
  end loop;
end $p$;

-- 2a BEFORE
select pg_temp.r2487_probe('before');
do $$ begin
  if not exists (select 1 from r2487_seen where phase = 'before' and login = 'app_anon' and role is null and trusted) then
    raise exception 'FAIL 2a: expected the claims-only shim to trust app_anon (the R-2487 hole) — is the shim already patched?';
  end if;
  if not exists (select 1 from r2487_seen where phase = 'before' and login = 'app_runtime' and uid is null) then
    raise exception 'FAIL 2a: expected app_runtime to read uid NULL before R-2487';
  end if;
end $$;

-- 2b the migration's block (keep byte-equal to the migration — cloudsql-auth-shim-scan.test.ts)
-- r2487-shim-begin
do $r2487$
declare
  v_uid_src  text;
  v_role_src text;
begin
  if not exists (select 1 from pg_roles where rolname = 'cloudsqlsuperuser') then
    raise notice 'R-2487: not Cloud SQL (no cloudsqlsuperuser role) — the auth schema belongs to Supabase here, nothing changed';
    return;
  end if;

  select p.prosrc into v_uid_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'auth' and p.proname = 'uid' and p.pronargs = 0;
  select p.prosrc into v_role_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'auth' and p.proname = 'role' and p.pronargs = 0;
  if v_uid_src is null or v_role_src is null then
    raise exception 'R-2487: auth uid()/role() shims missing on this Cloud SQL DB — run supabase/cloudsql/01a first';
  end if;
  if v_uid_src not like '%request.jwt.claim%' or v_role_src not like '%request.jwt.claim%' then
    raise exception 'R-2487: auth uid()/role() are not the 01a claims shims — refusing to overwrite them';
  end if;

  execute format($f$
    create or replace function %I.%I() returns uuid language sql stable as $b$
      /* R-2487: gateway logins first (same CASE as public.current_user_id()), then the JWT claims (01a). */
      select case
        when session_user in ('app_runtime', 'app_jobs')
          then nullif(current_setting('app.user_id', true), '')::uuid
        when session_user in ('app_service', 'app_anon') then null
        else coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
      end
    $b$
  $f$, 'auth', 'uid');

  execute format($f$
    create or replace function %I.%I() returns text language sql stable as $b$
      /* R-2487: gateway logins first (same CASE as public.current_request_role()), then the JWT claims (01a). */
      select case session_user
        when 'app_runtime' then 'authenticated'
        when 'app_jobs'    then 'app_jobs'
        when 'app_service' then 'service_role'
        when 'app_anon'    then 'anon'
        else coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))
      end
    $b$
  $f$, 'auth', 'role');
end
$r2487$;
-- r2487-shim-end

-- 2c AFTER
select pg_temp.r2487_probe('after');
do $$
declare r record; v_role text; v_uid uuid;
begin
  for r in select * from r2487_seen where phase = 'after' loop
    if r.login = 'app_runtime' and (r.role is distinct from 'authenticated' or r.uid is distinct from '00000000-0000-4000-8000-000000002487'::uuid or r.trusted) then
      raise exception 'FAIL 2c: app_runtime → role %, uid %, trusted % (want authenticated, app.user_id, false)', r.role, r.uid, r.trusted;
    elsif r.login = 'app_jobs' and (r.role is distinct from 'app_jobs' or r.uid is distinct from '00000000-0000-4000-8000-000000002487'::uuid or r.trusted) then
      raise exception 'FAIL 2c: app_jobs → role %, uid %, trusted % (want app_jobs, app.user_id, false)', r.role, r.uid, r.trusted;
    elsif r.login = 'app_anon' and (r.role is distinct from 'anon' or r.uid is not null or r.trusted) then
      raise exception 'FAIL 2c: app_anon → role %, uid %, trusted % (want anon, null, false)', r.role, r.uid, r.trusted;
    elsif r.login = 'app_service' and (r.role is distinct from 'service_role' or r.uid is not null or not r.trusted) then
      raise exception 'FAIL 2c: app_service → role %, uid %, trusted % (want service_role, null, true)', r.role, r.uid, r.trusted;
    end if;
  end loop;
  if (select count(*) from r2487_seen where phase = 'after') <> 4 then
    raise exception 'FAIL 2c: expected 4 logins probed';
  end if;
  -- same answers as the R-161 helpers the staging rewrite uses
  if exists (select 1 from r2487_seen a where a.phase = 'after' and a.role is distinct from
             (case a.login when 'app_runtime' then 'authenticated' when 'app_jobs' then 'app_jobs'
                           when 'app_service' then 'service_role' when 'app_anon' then 'anon' end)) then
    raise exception 'FAIL 2c: shim role differs from current_request_role()';
  end if;
  -- a PostgREST session (claims, no gateway login) is read exactly as before
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000024aa', 'role', 'authenticated')::text, true);
  v_role := auth.role(); v_uid := auth.uid();
  perform set_config('request.jwt.claims', '', true);
  if v_role is distinct from 'authenticated' or v_uid is distinct from '00000000-0000-4000-8000-0000000024aa'::uuid then
    raise exception 'FAIL 2c: claims path changed: role %, uid %', v_role, v_uid;
  end if;
  -- the owner / scripts (no claims, not a gateway login) still read NULL → still the trusted server path
  if auth.role() is not null or auth.uid() is not null then
    raise exception 'FAIL 2c: a script session should read role/uid NULL';
  end if;
  if (select prosrc from pg_proc where oid = 'auth.role()'::regprocedure) not like '%R-2487%' then
    raise exception 'FAIL 2c: auth role() was not replaced';
  end if;
end $$;

-- 2d re-runnable: the block's own check accepts the patched shim (it still reads the claims)
do $$ begin
  if (select prosrc from pg_proc where oid = 'auth.uid()'::regprocedure) not like '%request.jwt.claim%' then
    raise exception 'FAIL 2d: patched uid() no longer carries the claims fallback — a second deploy run would refuse';
  end if;
end $$;

\else
select 'R-2487 case 2 SKIPPED: needs a superuser (set session authorization) — run with -U supabase_admin locally' as note;
\endif

rollback;
