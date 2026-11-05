\set ON_ERROR_STOP on
-- R-2482: no browser login may insert its own public.users row — through Supabase/PostgREST
-- (role authenticated / anon) OR through the Cloud SQL data gateway, whose logins are
-- app_runtime (signed-in user) and app_anon (visitor) with NO `set role` (src/server/db/gateway.ts).
-- tg_users_insert_server_only (20260927100000) only refused current_user authenticated/anon, so
-- on the gateway a signed-in login with no users row could POST /rest/v1/users with ANY tenant_id
-- and role owner (RLS users_signup_insert only checks id = current_user_id()); current_tenant_id()
-- then became that company and R-2471's sync trigger gave it an owner membership. Proven locally
-- before the fix (session_user app_runtime, app.user_id set): INSERTED, tenant_after = victim.
-- Migration: 20261105001520_r2482_users_insert_gateway_roles.sql. Rolled back — safe anywhere.
--
--   1  as app_runtime (current_user, the way the gateway runs) → refused, nothing written,
--      no membership
--   2  as app_anon, and as app_jobs (also a member of authenticated) → refused
--   3  as authenticated (old Supabase path) → still refused
--   4  server paths still insert: the migration owner (what a SECURITY DEFINER runs as) → row +
--      R-2471 membership; app_service (the Cloud SQL admin-client login) is not refused by the guard
--   6  the trigger exists and is enabled on public.users
--   5  the real gateway login (session_user app_runtime, app.user_id) → refused — only where the
--      login exists and the runner is a superuser (locally: psql -U supabase_admin)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- CI's plain Supabase has no gateway logins: stand-ins with the memberships db/ops/10-runtime-roles.sql
-- gives the real LOGIN roles (app_runtime/app_jobs in authenticated, app_anon in anon, app_service in
-- service_role), only for this transaction. Case 5 uses the real login where it exists.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime nologin in role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_anon') then
    create role app_anon nologin in role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_jobs') then
    create role app_jobs nologin in role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then
    create role app_service nologin in role service_role;
  end if;
end $$;
grant app_jobs to current_user;
grant app_service to current_user;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_users_insert_server_only'
                   and tgrelid = 'public.users'::regclass and tgenabled <> 'D') then
    raise exception 'FAIL 6: trg_users_insert_server_only is missing or disabled on public.users';
  end if;
end $$;
grant app_runtime to current_user;
grant app_anon to current_user;

insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('24820000-0000-4000-8000-0000000000a1', 'ZZ R2482 Victim Co', 'r2482-victim@example.invalid', '07', 'R82V', 'reseller');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) values
  ('24820000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r2482-attacker@example.invalid', now(), '{}'::jsonb),
  ('24820000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r2482-server@example.invalid', now(), '{}'::jsonb),
  ('24820000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r2482-svc@example.invalid', now(), '{}'::jsonb);
-- A signed-in login with no users row (an auth trigger may not create one; make sure).
delete from public.users where id in ('24820000-0000-4000-8000-0000000000e1', '24820000-0000-4000-8000-0000000000e2',
                                   '24820000-0000-4000-8000-0000000000e3');

create temp table r2482_result (step text, msg text);
grant all on r2482_result to public;

-- ── 1–3: each browser role tries to make itself owner of the victim company ──────────────
do $$
declare r text; m text;
begin
  foreach r in array array['app_runtime', 'app_anon', 'app_jobs', 'authenticated'] loop
    execute format('set local role %I', r);
    perform set_config('request.jwt.claims',
      json_build_object('sub', '24820000-0000-4000-8000-0000000000e1', 'role',
                        case when r = 'app_anon' then 'anon' else 'authenticated' end)::text, true);
    perform set_config('app.user_id', '24820000-0000-4000-8000-0000000000e1', true);
    begin
      insert into public.users (id, tenant_id, email, role)
      values ('24820000-0000-4000-8000-0000000000e1', '24820000-0000-4000-8000-0000000000a1',
              'r2482-attacker@example.invalid', 'owner');
      m := 'INSERTED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    insert into r2482_result values (r, m);
  end loop;
end $$;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare v record;
begin
  for v in select * from r2482_result loop
    if v.msg = 'INSERTED' then
      raise exception 'FAIL %: % inserted its own users row into another company (R-2482)', v.step, v.step;
    end if;
    if v.msg not like 'Team members are added through an invite or an approved join request.%' then
      raise exception 'FAIL %: refused by the wrong thing (want the server-only guard): "%"', v.step, v.msg;
    end if;
  end loop;
  if (select count(*) from r2482_result) <> 4 then raise exception 'FAIL: % role cases ran, want 4', (select count(*) from r2482_result); end if;
  if exists (select 1 from public.users where id = '24820000-0000-4000-8000-0000000000e1') then
    raise exception 'FAIL 1: an attacker users row exists';
  end if;
end $$;
do $$
declare n int;
begin
  if to_regclass('public.tenant_memberships') is null then return; end if;
  execute 'select count(*) from public.tenant_memberships where user_id = $1' into n
    using '24820000-0000-4000-8000-0000000000e1'::uuid;
  if n <> 0 then raise exception 'FAIL 1: attacker got % membership row(s)', n; end if;
end $$;

-- ── 4: the server path (admin/service login, or a SECURITY DEFINER as its owner) still works ─
insert into public.users (id, tenant_id, email, role)
values ('24820000-0000-4000-8000-0000000000e2', '24820000-0000-4000-8000-0000000000a1',
        'r2482-server@example.invalid', 'owner');
do $$
declare n int;
begin
  if not exists (select 1 from public.users where id = '24820000-0000-4000-8000-0000000000e2'
                   and tenant_id = '24820000-0000-4000-8000-0000000000a1') then
    raise exception 'FAIL 4: the server insert did not land';
  end if;
  if to_regclass('public.tenant_memberships') is null then return; end if;
  execute 'select count(*) from public.tenant_memberships where user_id = $1 and tenant_id = $2' into n
    using '24820000-0000-4000-8000-0000000000e2'::uuid, '24820000-0000-4000-8000-0000000000a1'::uuid;
  if n <> 1 then raise exception 'FAIL 4: R-2471 membership rows for the server insert: % (want 1)', n; end if;
end $$;

-- app_service (admin client on Cloud SQL) must not be stopped by THIS guard (RLS may still answer).
do $$
declare m text;
begin
  set local role app_service;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    insert into public.users (id, tenant_id, email, role)
    values ('24820000-0000-4000-8000-0000000000e3', '24820000-0000-4000-8000-0000000000a1',
            'r2482-svc@example.invalid', 'sales');
    m := 'INSERTED';
  exception when others then m := sqlerrm;
  end;
  reset role;
  if m like 'Team members are added through an invite%' then
    raise exception 'FAIL 4b: the guard refused app_service (the server path): "%"', m;
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 5: the real gateway login — session_user app_runtime, the user in app.user_id, no JWT ──
do $g$
declare m text;
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime' and rolcanlogin)
     or not (select rolsuper from pg_roles where rolname = current_user) then
    raise notice 'r2482: no app_runtime login (or not a superuser to become it) - gateway case 5 skipped';
    return;
  end if;
  execute 'set session authorization app_runtime';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.user_id', '24820000-0000-4000-8000-0000000000e1', true);
  perform set_config('app.tenant_id', '', true);
  begin
    insert into public.users (id, tenant_id, email, role)
    values ('24820000-0000-4000-8000-0000000000e1', '24820000-0000-4000-8000-0000000000a1',
            'r2482-attacker@example.invalid', 'owner');
    m := 'INSERTED';
  exception when others then m := sqlerrm;
  end;
  execute 'reset session authorization';
  if m not like 'Team members are added through an invite or an approved join request.%' then
    raise exception 'FAIL 5: gateway login app_runtime: "%"', m;
  end if;
end $g$;

rollback;
