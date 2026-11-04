\set ON_ERROR_STOP on
-- R-2110 (GP-01, goal G-PERSONAL): tenants.workspace_kind is platform-owned, and 'personal' is a
-- user_role value. Migrations 20261030004000_gp01_personal_role.sql +
-- 20261030004100_gp01_workspace_kind.sql. Rolled back — safe anywhere.
--
--   DEFAULT  an existing / new tenant reads workspace_kind 'business'
--   CHECK    workspace_kind outside personal|business is refused (even for service_role)
--   BLOCKED  an owner session PATCHes its own tenants.workspace_kind (R-720 guard message)
--   COVERED  the guard lists app_runtime (staging's request role) too
--   BLOCKED  an authenticated INSERT of a tenant with workspace_kind 'personal' (guard message)
--   ALLOWED  the owner still edits name (the guard only stops the platform columns)
--   ALLOWED  service_role sets workspace_kind, and creates a 'personal' user row

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('21100000-0000-4000-8000-000000000001', 'GP01 OWNER CO', 'gp01-a@example.in', '07', 'GP1A');

insert into auth.users (id, instance_id, aud, role, email) values
  ('21100000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gp01-owner@example.in'),
  ('21100000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gp01-personal@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('21100000-0000-4000-8000-00000000000a', '21100000-0000-4000-8000-000000000001', 'gp01-owner@example.in', 'owner', true);

do $$
declare
  v_err boolean; v_msg text; v_n int; v_kind text;
  c_me constant uuid := '21100000-0000-4000-8000-000000000001';
begin
  -- ── DEFAULT: every existing row and a new row read 'business' ───────────
  select workspace_kind into v_kind from public.tenants where id = c_me;
  if v_kind is distinct from 'business' then
    raise exception 'FAIL 1: a new tenant has workspace_kind % (expected business)', v_kind;
  end if;
  if exists (select 1 from public.tenants where workspace_kind is distinct from 'business' and id <> c_me) then
    raise exception 'FAIL 1b: an existing tenant does not read business';
  end if;

  -- ── CHECK: only personal | business ─────────────────────────────────────
  v_err := false;
  begin
    update public.tenants set workspace_kind = 'family' where id = c_me;
  exception when check_violation then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: workspace_kind accepted a value outside personal|business'; end if;

  -- ── BLOCKED: owner session PATCH ────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','21100000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_err := false; v_msg := null;
  begin
    update public.tenants set workspace_kind = 'personal' where id = c_me;
  exception when insufficient_privilege then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 3: an owner changed their own workspace_kind'; end if;
  if v_msg not like 'Workspace kind%' then
    raise exception 'FAIL 3b: workspace_kind refused by something else: %', v_msg;
  end if;

  -- ── ALLOWED: ordinary profile edit still works ──────────────────────────
  update public.tenants set name = 'GP01 RENAMED' where id = c_me;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: the owner could not edit their own company name'; end if;

  -- ── BLOCKED: authenticated INSERT with kind personal ────────────────────
  v_err := false; v_msg := null;
  begin
    insert into public.tenants (name, email, workspace_kind) values ('GP01 FORGED', 'gp01-f@example.in', 'personal');
  exception when insufficient_privilege then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 5: an authenticated login inserted a personal tenant'; end if;
  if v_msg not like 'Only the server can create a workspace%' then
    raise exception 'FAIL 5b: personal insert refused by something else: %', v_msg;
  end if;

  -- ── The guard lists app_runtime (staging's request role) beside authenticated/anon ─
  -- (postgres cannot SET ROLE app_runtime on the local/CI DB, so the list is checked instead).
  reset role;
  if (select prosrc from pg_proc where oid = 'public.r720_tenants_column_guard()'::regprocedure)
       not like '%''authenticated'', ''anon'', ''app_runtime''%' then
    raise exception 'FAIL 6: the guard no longer covers app_runtime';
  end if;
  if exists (select 1 from public.tenants where id = c_me and workspace_kind <> 'business') then
    raise exception 'FAIL 6b: workspace_kind changed by a request role';
  end if;

  -- ── ALLOWED: service_role sets it + a personal user row ─────────────────
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.tenants set workspace_kind = 'personal' where id = c_me;
  insert into public.users (id, tenant_id, email, role, is_active) values
    ('21100000-0000-4000-8000-00000000000b', c_me, 'gp01-personal@example.in', 'personal', true);
  insert into public.tenants (name, email, doc_code, workspace_kind) values ('GP01 SERVER', 'gp01-s@example.in', 'GP1S', 'personal');
  reset role;
  if not exists (select 1 from public.tenants where id = c_me and workspace_kind = 'personal') then
    raise exception 'FAIL 7: service_role could not set workspace_kind';
  end if;
  if not exists (select 1 from public.users where id = '21100000-0000-4000-8000-00000000000b' and role = 'personal') then
    raise exception 'FAIL 8: a personal user row did not land';
  end if;

  raise notice 'gp01_workspace_kind_guard: all checks passed';
end $$;

rollback;
