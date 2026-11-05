-- deploy-peek: to_regprocedure('public.is_direct_request_login()') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.attendance_direct_write_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.role_column_write_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r720_tenants_column_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r720_tenant_domains_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r2445_tenants_owner_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r1903_users_phone_verified_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_insert_approval_guard()') and prosrc like '%R-2485%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_users_insert_server_only()') and prosrc like '%R-2485%')
-- deploy-key: r2485directrequestlogin
--
-- R-2485 (5 Nov 2026, p1 security) — one answer to "is this a direct request login?" for every
-- DB guard. Found by the R-2482 worker: the Cloud SQL data gateway (src/server/db/gateway.ts,
-- staging today with DATA_GATEWAY=1, live after R-909) runs a signed-in browser request as the
-- LOGIN app_runtime, a visitor as app_anon and cron jobs as app_jobs — it never does
-- `set role authenticated`. Each trigger guard kept its own role list and the lists disagreed:
--   attendance_direct_write_guard   only 'authenticated'  → a gateway login could change its own
--                                   attendance times (proven locally, supabase/tests/
--                                   r2485_direct_request_login_guards case 2, red without this file)
--   r720_tenants_column_guard, r720_tenant_domains_guard, r2445_tenants_owner_guard
--                                   no app_anon / app_jobs / authenticator (cases 3–4 red)
--   role_column_write_guard (R-719) no anon / app_anon / app_jobs (case 5 red)
--   tg_quote_insert_approval_guard  no app_jobs (case 6 red)
--   tg_users_insert_server_only (R-2482), r1903_users_phone_verified_guard — already the full
--                                   list; switched so there is ONE list.
--
-- public.is_direct_request_login() = current_user is one of
--   authenticated, anon, authenticator          (Supabase / PostgREST request roles)
--   app_runtime, app_anon, app_jobs             (Cloud SQL logins that never `set role`)
-- It is false for the migration owner (a SECURITY DEFINER body runs as its owner, so RPCs such
-- as correct_attendance / verify_phone_otp / combine_quotes are unchanged), for service_role /
-- app_service (the server's admin client) and for psql / scripts. SECURITY INVOKER on purpose:
-- current_user inside a definer helper would always be its owner.
-- app_jobs is in the list: jobs (src/server/db/jobs.ts, today only cron/cold-calls) touch none of
-- these tables, and a job is not the platform — it runs per tenant under normal RLS.
--
-- Every guard below is its LATEST body (newest migration wins) with only the role line changed;
-- earlier R-markers kept: attendance 20261011003000, role_column 20261011083000 (R-719), tenants
-- 20261030004100 (R-720/R-2110), tenant_domains 20261011093000 (R-720), r2445 20261103215416,
-- r1903 20261025083015, quote insert 20261105000100 (R-2447/R-2470), users insert
-- 20261105001520 (R-2482). Signatures unchanged, so create or replace keeps grants and triggers.
-- New guards: call public.is_direct_request_login(), never a raw current_user role list —
-- src/lib/security/direct-login-role-scan.test.ts fails on one.
--
-- Not in this file (a different class, card R-2487): the ~315 RPC "v_trusted" checks
-- (auth.role() is null and session_user not in (...)) and r2158_trusted(). They ask "is this a
-- trusted server path", not "is this a request login"; on staging the deploy script rewrites
-- auth.role() to current_request_role(), which is non-null for every app_* login, so they hold
-- there today.

create or replace function public.is_direct_request_login()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  /* R-2485: the ONE list of logins that reach the database directly from a browser or job —
     Supabase request roles + the Cloud SQL logins that never `set role` (gateway.ts, jobs.ts).
     Not here, on purpose: service_role / app_service (server admin client), resellersos_* and
     postgres (owners / scripts). */
  select current_user::text in ('authenticated', 'anon', 'authenticator', 'app_runtime', 'app_anon', 'app_jobs')
$$;

comment on function public.is_direct_request_login() is
  'R-2485: true when current_user is a direct request login — authenticated / anon / authenticator (Supabase) or app_runtime / app_anon / app_jobs (Cloud SQL, no set role). Every trigger guard asks this instead of keeping its own role list. False inside SECURITY DEFINER bodies and for service_role / app_service.';

-- Invoker trigger guards call it AS the request's role (anon / app_anon included): without
-- EXECUTE a visitor's write would fail with "permission denied for function" instead of the
-- guard's own answer. It returns only whether the caller is a request login — no data.
-- Cloud SQL gives no PUBLIC EXECUTE (R-401), so each role is named.
revoke all on function public.is_direct_request_login() from public;
grant execute on function public.is_direct_request_login() to authenticated, anon, service_role;
-- Named too (the 20261007260000 precedent): a Cloud SQL login created without INHERIT must not fail
-- every guarded write with "permission denied for function" — the inline check needed no privilege.
do $$
declare r text;
begin
  foreach r in array array['app_runtime', 'app_jobs', 'app_anon', 'app_service', 'resellersos_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function public.is_direct_request_login() to %I', r);
    end if;
  end loop;
end $$;

create or replace function public.attendance_direct_write_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2485: every request login (incl. the Cloud SQL gateway's app_runtime / app_anon / app_jobs), one list. */
  if not public.is_direct_request_login() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op <> 'UPDATE'
     or (to_jsonb(new) - 'reviewed_at' - 'reviewed_by') is distinct from (to_jsonb(old) - 'reviewed_at' - 'reviewed_by') then
    raise exception 'Attendance times can only be changed by the owner, with a reason (Fix attendance).'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function public.role_column_write_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_full text[] := string_to_array(tg_argv[0], ',');
  v_cols text[] := coalesce(tg_argv[1:tg_nargs - 1], '{}'::text[]);
begin
  /* R-2485: one list of request logins (app_anon / app_jobs / anon were missing here). */
  if not public.is_direct_request_login() then
    return new;
  end if;
  if public.current_user_has_role(variadic v_full) then
    return new;
  end if;
  if (to_jsonb(new) - v_cols) is distinct from (to_jsonb(old) - v_cols) then
    raise exception 'Your role can change only % on %. Ask an owner or manager to change the rest.',
      array_to_string(v_cols, ', '), tg_table_name
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function public.r720_tenants_column_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2485: one list of request logins (app_anon / app_jobs / authenticator were missing here). */
  if not public.is_direct_request_login() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- No request-role insert policy exists any more; this is the second wall.
    if new.parent_tenant_id is not null
       or new.gstin_verified_at is not null
       or new.gstin_verification is not null
       or coalesce(new.tier, 'reseller') <> 'reseller'
       -- R-2110: a personal workspace is created only by the server (GP-05).
       or coalesce(new.workspace_kind, 'business') <> 'business' then
      raise exception 'Only the server can create a workspace with a tier, parent, GSTIN verification or workspace kind.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tier is distinct from old.tier
     or new.parent_tenant_id is distinct from old.parent_tenant_id then
    raise exception 'Workspace tier and parent distributor are set by the platform, not from the app.'
      using errcode = '42501';
  end if;

  -- R-2110: personal ↔ business is the platform's decision (signup / paid upgrade), never the app's.
  if new.workspace_kind is distinct from old.workspace_kind then
    raise exception 'Workspace kind (personal or business) is set by the platform, not from the app.'
      using errcode = '42501';
  end if;

  if (new.gstin_verified_at is distinct from old.gstin_verified_at and new.gstin_verified_at is not null)
     or (new.gstin_verification is distinct from old.gstin_verification and new.gstin_verification is not null) then
    raise exception 'GSTIN verification is recorded only by the Verify with GSTN check.'
      using errcode = '42501';
  end if;

  -- A new GSTIN is not the one that was verified.
  if upper(btrim(coalesce(new.gstin, ''))) is distinct from upper(btrim(coalesce(old.gstin, ''))) then
    new.gstin_verified_at  := null;
    new.gstin_verification := null;
  end if;

  if new.gmail_sender_user_id is distinct from old.gmail_sender_user_id
     and new.gmail_sender_user_id is not null
     and not exists (select 1 from public.users u
                      where u.id = new.gmail_sender_user_id and u.tenant_id = new.id) then
    raise exception 'The Gmail sender must be a member of this workspace.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create or replace function public.r720_tenant_domains_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2485: one list of request logins (app_anon / app_jobs / authenticator were missing here). */
  if not public.is_direct_request_login() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.verified_at is not null then
      raise exception 'A domain is marked verified only after the DNS check, by the server.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.verified_at is not null then
    raise exception 'A verified domain cannot be changed from the app.'
      using errcode = '42501';
  end if;
  if new.verified_at is not null then
    raise exception 'A domain is marked verified only after the DNS check, by the server.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function public.r2445_tenants_owner_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2445. Request roles (the browser) can never write the proof; service_role (the platform
     route), SECURITY DEFINER functions and scripts may — the R-720 rule. */
  /* R-2485: one list of request logins (app_anon / app_jobs / authenticator were missing here). */
  if public.is_direct_request_login() then
    if tg_op = 'INSERT' then
      if new.gstin_owner_verified_at is not null or new.gstin_owner_verified_gstin is not null
         or new.gstin_owner_verified_how is not null or new.gstin_owner_verified_by is not null then
        raise exception 'GSTIN ownership is recorded only by the ResellerOS check (Settings → Network → Prove you own this GSTIN).'
          using errcode = '42501';
      end if;
    elsif (new.gstin_owner_verified_at is not null and new.gstin_owner_verified_at is distinct from old.gstin_owner_verified_at)
       or (new.gstin_owner_verified_gstin is not null and new.gstin_owner_verified_gstin is distinct from old.gstin_owner_verified_gstin)
       or (new.gstin_owner_verified_how is not null and new.gstin_owner_verified_how is distinct from old.gstin_owner_verified_how)
       or (new.gstin_owner_verified_by is not null and new.gstin_owner_verified_by is distinct from old.gstin_owner_verified_by) then
      raise exception 'GSTIN ownership is recorded only by the ResellerOS check (Settings → Network → Prove you own this GSTIN).'
        using errcode = '42501';
    end if;
  end if;

  /* Any role: the proof is for one GSTIN. A different GSTIN (or none) drops it, which also
     frees the old GSTIN for its real owner. */
  if new.gstin_owner_verified_at is not null
     and upper(btrim(coalesce(new.gstin, ''))) is distinct from new.gstin_owner_verified_gstin then
    new.gstin_owner_verified_at    := null;
    new.gstin_owner_verified_gstin := null;
    new.gstin_owner_verified_how   := null;
    new.gstin_owner_verified_by    := null;
  end if;
  return new;
end;
$function$;

create or replace function public.r1903_users_phone_verified_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /* verify_phone_otp sets this flag for its own UPDATE, and runs as the function owner — a
     signed-in role (PostgREST, Prisma app_runtime) can never be the one that sets it. */
  if coalesce(current_setting('app.r1903_phone_verify', true), '') = 'on'
     and not public.is_direct_request_login() then  /* R-2485: the one list */
    return new;
  end if;
  if new.phone is distinct from old.phone then
    new.phone_verified_at := null;
  elsif new.phone_verified_at is not null and new.phone_verified_at is distinct from old.phone_verified_at then
    raise exception 'A mobile number is marked verified only by its OTP. Open Settings → Security → Mobile number and press Verify.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.tg_quote_insert_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  /* R-2447: only a login's DIRECT insert — PostgREST (authenticated / anon) or the Cloud SQL data
     gateway (app_runtime / app_anon, src/server/db/gateway.ts; same list as R-1903). Inside a SECURITY
     DEFINER function (combine_quotes, R-1527, copies its sources' approval) current_user is the
     function's owner; a service / cron path runs as service_role — both unchanged. */
  /* R-2485: one list of request logins (app_jobs was missing here). */
  if not public.is_direct_request_login() then return new; end if;
  if new.approval_status::text in ('approved', 'rejected') then
    raise exception 'A new quote cannot be saved already % — save it first, then ask for approval (Review & decide).', new.approval_status
      using errcode = '42501';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  new.approved_discount_bps := null;
  new.approved_margin_bps := null;
  /* R-2470 (F2): the below-cost mark the R-2213 payment guard reads is set from the lines themselves
     (linesBelowCost = marginBps(lineEconomics) < 0 = quote_lines_approval_bps); a mark the app already
     set is kept. */
  new.below_cost := coalesce(new.below_cost, false)
                    or coalesce((select b.margin_bps < 0 from public.quote_lines_approval_bps(new.line_items) b), false)
                    or public.quote_header_below_cost(new.amount, new.subtotal, new.discount_pct, new.tax_rate,
                                                      new.currency, new.line_items);
  return new;
end
$$;

create or replace function public.tg_users_insert_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2482: app_runtime / app_anon / app_jobs are Cloud SQL logins that never `set role`. */
  /* R-2485: the one list. */
  if public.is_direct_request_login() then
    raise exception 'Team members are added through an invite or an approved join request.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- R-2485: guards keep their own grants (create or replace); restate the trigger-function revokes.
revoke all on function public.attendance_direct_write_guard() from public, anon, authenticated;
revoke all on function public.role_column_write_guard() from public, anon, authenticated;
revoke all on function public.r720_tenants_column_guard() from public, anon, authenticated;
revoke all on function public.r720_tenant_domains_guard() from public, anon, authenticated;
revoke all on function public.r2445_tenants_owner_guard() from public, anon, authenticated;
revoke all on function public.tg_quote_insert_approval_guard() from public, anon, authenticated;
revoke all on function public.r1903_users_phone_verified_guard() from public, anon, authenticated;
revoke all on function public.tg_users_insert_server_only() from public, anon, authenticated;
