-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_users_insert_server_only()') and prosrc like '%R-2482%') and exists(select 1 from pg_trigger where tgname = 'trg_users_insert_server_only' and tgrelid = to_regclass('public.users') and tgenabled <> 'D')
-- deploy-key: r2482usersinsertgateway
--
-- R-2482 (5 Nov 2026, p1 security) — lead from the R-2471 independent review, proven on the local
-- DB in a rolled-back transaction before this file (supabase/tests/r2482_users_insert_gateway_roles,
-- red without it). The Cloud SQL data gateway (src/server/db/gateway.ts, staging today with
-- DATA_GATEWAY=1, live after R-909) runs a signed-in browser request as the LOGIN app_runtime
-- (member of authenticated) and a visitor as app_anon — it never does `set role authenticated`.
-- tg_users_insert_server_only (20260927100000) refused only current_user authenticated / anon, so
-- on the gateway a signed-in login with no users row could POST /api/sb/rest/v1/users with any
-- tenant_id and role 'owner': RLS users_signup_insert only checks id = current_user_id(). It then
-- became that company's owner (current_tenant_id() = the victim) and R-2471's sync trigger gave it
-- an owner membership too.
--
-- Fix: the same guard covers the Cloud SQL logins that never `set role` — app_runtime, app_anon and
-- app_jobs (also a member of authenticated whose current_user_id() is app.user_id; no job creates
-- users) — plus authenticator: the same list as R-1903's users_phone_verified guard. Users rows are
-- made only by the server paths — signup / onboarding / invite / join-request / personal workspace
-- / demo all use the admin client (service_role on Supabase, app_service on Cloud SQL) — and by
-- SECURITY DEFINER functions (they run as their owner). Neither is in the list, so nothing
-- legitimate changes. The trigger is re-created too, so a database built without
-- 20260927100000's trigger gets it (the deploy-peek checks both). R-2471's membership sync is an
-- AFTER trigger: a refused insert never reaches it; an allowed one is unchanged.

create or replace function public.tg_users_insert_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2482: app_runtime / app_anon / app_jobs are Cloud SQL logins that never `set role`. */
  if current_user in ('authenticated', 'anon', 'authenticator', 'app_runtime', 'app_anon', 'app_jobs') then
    raise exception 'Team members are added through an invite or an approved join request.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_users_insert_server_only on public.users;
create trigger trg_users_insert_server_only
  before insert on public.users
  for each row execute function public.tg_users_insert_server_only();

comment on function public.tg_users_insert_server_only() is
  'R-2482: refuses a users INSERT from any browser role — authenticated / anon / authenticator (Supabase) and the Cloud SQL logins app_runtime / app_anon / app_jobs. Only the server (admin client) and SECURITY DEFINER paths create users rows.';
