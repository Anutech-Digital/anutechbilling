-- deploy-peek: not exists(select 1 from pg_roles where rolname = 'cloudsqlsuperuser') or (exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'role' and p.prosrc like '%R-2487%') and exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'uid' and p.prosrc like '%R-2487%'))
-- deploy-key: r2487authshims
-- deploy-user: postgres
-- 20261105021052_r2487_cloudsql_auth_shims_gateway_logins.sql
--
-- R-2487 (5 Nov 2026, security) — on Cloud SQL, the auth uid/role shims answer for the data
-- gateway logins, so every function body that calls them behaves as it does on staging.
--
-- ══ THE HOLE ══════════════════════════════════════════════════════════════════════════════
--   On Cloud SQL the auth schema helpers uid() and role() are our own shims
--   (supabase/cloudsql/01a-roles-and-auth.sql): they read ONLY the request.jwt.claim(s)
--   settings PostgREST sets. The data gateway (src/server/db/gateway.ts, staging today, live
--   after R-909) never sets them: it logs in as app_runtime (signed-in user, app.user_id),
--   app_anon (visitor) or app_service (server), and cron jobs as app_jobs (jobs.ts). For those
--   logins both shims return NULL.
--   Staging is safe only because its deploy script sed-rewrites every file to
--   public.current_user_id() / public.current_request_role() (R-161 helpers that DO know the
--   logins). The live deploy script does not rewrite, and the R-909 replay rewrites only files
--   that are not on live yet — every body already on live keeps the raw call. On such a DB:
--     · ~153 SECURITY DEFINER RPCs treat "role is NULL and session_user is not one of
--       authenticator/anon/authenticated/app_runtime" as the trusted server (R-454/R-714/R-717/
--       R-718… v_trusted, r2158_trusted) — app_anon and app_jobs pass that test;
--     · guard_privileged_user_columns returns early when the uid is NULL ("server path") — a
--       signed-in user could change their own users.role / tenant_id / is_active;
--     · tg_books_locked, tg_vendor_bill_delete_guard, tg_expense_delete_guards_salary,
--       tg_fixed_asset_expense_lock, quotes_refuse_mixed_billing_term enforce only for the
--       anon/authenticated request roles — skipped for every gateway login.
--   Measured on the repo (R-2487 card, `measure`): 768 latest function bodies, 621 uid mentions.
--
-- ══ THE FIX — one place, not 315 bodies ═══════════════════════════════════════════════════
--   Both shims first map the gateway logins by session_user, exactly like
--   public.current_user_id() / public.current_request_role() (20261025065946_r1901, same CASE),
--   and otherwise read the JWT claims exactly as before:
--     app_runtime → role 'authenticated', uid = app.user_id
--     app_jobs    → role 'app_jobs',      uid = app.user_id
--     app_service → role 'service_role',  uid NULL
--     app_anon    → role 'anon',          uid NULL
--     anyone else (authenticator/PostgREST, postgres, resellersos_*) → the claims, unchanged.
--   So a raw body on live now answers what its rewritten twin answers on staging — the path the
--   whole app was tested on. session_user (the LOGIN) is used, not current_user: it is unchanged
--   inside SECURITY DEFINER bodies and cannot be changed by `set role`.
--   Still plain `language sql stable`, no SET clause — the planner can inline them in RLS.
--
-- ══ WHERE IT RUNS ═══════════════════════════════════════════════════════════════════════════
--   Cloud SQL only (role cloudsqlsuperuser exists): staging and live, as postgres (member of
--   supabase_auth_admin, the shims' owner — 01a). `create or replace` keeps owner and grants.
--   On Supabase (local, CI) the auth schema is GoTrue's and is left alone: notice + no change.
--   On Cloud SQL it refuses (exception) if a shim is not the 01a claims shim it expects, so it
--   never overwrites something it does not know.
--   No literal uid()/role() call with the auth schema prefix appears in this file: staging's
--   deploy script sed-rewrites that text to the public helpers, which would turn this into
--   "create function public.current_user_id() … calling itself". The statements are built with
--   format('%I.%I', 'auth', …) instead (src/lib/security/cloudsql-auth-shim-scan.test.ts
--   checks both: no literal, and the CASE equals current_user_id/current_request_role).
--
-- Not here (board slices of R-2487): the public.is_trusted_server_path() helper and switching
-- the v_trusted bodies to it (R-2488/R-2489), online_fee_exception_guard's own list (R-2490),
-- gen-deploy-db's comment strip (R-2491), jobs vs the books lock (R-2492).

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
