\set ON_ERROR_STOP on
-- R-2114 (GP-04, goal G-PERSONAL): a new company is seeded with Petty Cash (R-1834) and
-- Customer messages ON (R-1922) ONLY when it is a business workspace; both seeds live in one
-- idempotent seed_business_workspace(p_tenant) that the paid upgrade (GP-25) also calls.
-- Migration: 20261030051044_gp04_seed_business_workspace.sql. Rolled back — safe anywhere.
--
-- Run: docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 -q \
--        < supabase/tests/gp04_seed_business_workspace.test.sql
--
--   PERSONAL  a personal tenant insert gets 0 bank accounts and no customer_messages row (= OFF)
--   BUSINESS  a business tenant insert gets exactly 1 Petty Cash and customer_messages ON
--   ONCE      calling seed_business_workspace twice still leaves exactly 1 Petty Cash + 1 row
--   UPGRADE   personal → business (service_role) then seed = Petty Cash + messages ON
--   REFUSED   seeding a tenant that is still personal, or one that does not exist
--   WALL      authenticated / anon cannot EXECUTE it (privilege, not just a body check)
--   SCOPED    the two old triggers still exist (R-1834 / R-1922 deploy-peeks) and fire only for business

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, workspace_kind) values
  ('21140000-0000-4000-8000-000000000001', 'GP04 Personal', 'gp04-p@example.in', '07', 'personal'),
  ('21140000-0000-4000-8000-000000000002', 'GP04 Business', 'gp04-b@example.in', '07', 'business'),
  ('21140000-0000-4000-8000-000000000003', 'GP04 Upgrader', 'gp04-u@example.in', '07', 'personal');

insert into auth.users (id, instance_id, aud, role, email) values
  ('21140000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gp04-owner@example.in');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('21140000-0000-4000-8000-00000000000a', '21140000-0000-4000-8000-000000000002', 'gp04-owner@example.in', 'owner', true);

do $$
declare
  n int; v_on boolean; v_err boolean; v_msg text; v_res jsonb;
  c_personal constant uuid := '21140000-0000-4000-8000-000000000001';
  c_business constant uuid := '21140000-0000-4000-8000-000000000002';
  c_upgrade  constant uuid := '21140000-0000-4000-8000-000000000003';
begin
  -- ── PERSONAL ───────────────────────────────────────────────────────────
  select count(*) into n from public.bank_accounts where tenant_id = c_personal;
  if n <> 0 then raise exception 'FAIL 1a: a personal workspace got % bank account(s) (expected 0)', n; end if;
  if exists (select 1 from public.automation_jobs where tenant_id = c_personal) then
    raise exception 'FAIL 1b: a personal workspace got an automation_jobs row (customer messages must stay OFF)';
  end if;

  -- ── BUSINESS ───────────────────────────────────────────────────────────
  select count(*) into n from public.bank_accounts
   where tenant_id = c_business and is_default_petty_cash and name = 'Petty Cash' and account_type = 'cash' and opening_balance = 0;
  if n <> 1 then raise exception 'FAIL 2a: a business workspace should get exactly 1 Petty Cash, got %', n; end if;
  select enabled into v_on from public.automation_jobs where tenant_id = c_business and job = 'customer_messages';
  if v_on is distinct from true then raise exception 'FAIL 2b: a business workspace should start with customer messages ON, got %', v_on; end if;
  select count(*) into n from public.automation_jobs where tenant_id = c_business;
  if n <> 1 then raise exception 'FAIL 2c: only the customer_messages row is expected (crons stay OFF), got % rows', n; end if;

  -- ── ONCE: the function is idempotent ───────────────────────────────────
  v_res := public.seed_business_workspace(c_business);
  v_res := public.seed_business_workspace(c_business);
  select count(*) into n from public.bank_accounts where tenant_id = c_business and account_type = 'cash';
  if n <> 1 then raise exception 'FAIL 3a: calling seed twice left % cash accounts (expected 1)', n; end if;
  select count(*) into n from public.automation_jobs where tenant_id = c_business;
  if n <> 1 then raise exception 'FAIL 3b: calling seed twice left % automation rows (expected 1)', n; end if;
  if (v_res->>'petty_cash_added')::boolean or (v_res->>'customer_messages_added')::boolean then
    raise exception 'FAIL 3c: a repeat seed reported adding something: %', v_res;
  end if;

  -- An owner who switched messages OFF is never switched back ON by a repeat seed.
  update public.automation_jobs set enabled = false where tenant_id = c_business and job = 'customer_messages';
  perform public.seed_business_workspace(c_business);
  select enabled into v_on from public.automation_jobs where tenant_id = c_business and job = 'customer_messages';
  if v_on then raise exception 'FAIL 3d: a repeat seed turned an owner''s OFF switch back ON'; end if;

  -- ── REFUSED: a still-personal tenant / an unknown tenant ───────────────
  v_err := false; v_msg := null;
  begin
    perform public.seed_business_workspace(c_upgrade);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 4a: seed ran on a workspace that is still personal'; end if;
  if exists (select 1 from public.bank_accounts where tenant_id = c_upgrade) then
    raise exception 'FAIL 4b: a refused seed still added a bank account';
  end if;
  v_err := false;
  begin
    perform public.seed_business_workspace('21140000-0000-4000-8000-0000000000ff');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 4c: seed ran on a workspace that does not exist'; end if;

  -- ── UPGRADE: platform flips the kind (service_role), then seeds ────────
  update public.tenants set workspace_kind = 'business' where id = c_upgrade;
  v_res := public.seed_business_workspace(c_upgrade);
  select count(*) into n from public.bank_accounts where tenant_id = c_upgrade and is_default_petty_cash;
  if n <> 1 then raise exception 'FAIL 5a: upgrade seed gave % Petty Cash (expected 1)', n; end if;
  select enabled into v_on from public.automation_jobs where tenant_id = c_upgrade and job = 'customer_messages';
  if v_on is distinct from true then raise exception 'FAIL 5b: upgrade seed did not turn customer messages ON'; end if;
  if not (v_res->>'petty_cash_added')::boolean or not (v_res->>'customer_messages_added')::boolean then
    raise exception 'FAIL 5c: first upgrade seed should report both added: %', v_res;
  end if;

  -- ── SCOPED: both old triggers still exist, each with the business WHEN ─
  select count(*) into n from pg_trigger
   where tgrelid = 'public.tenants'::regclass
     and tgname in ('trg_tenants_default_petty_cash', 'trg_tenants_customer_messages_on')
     and pg_get_triggerdef(oid) like '%workspace_kind%business%';
  if n <> 2 then raise exception 'FAIL 6: expected both tenant seed triggers with WHEN workspace_kind = business, got %', n; end if;

  -- ── WALL: privileges ───────────────────────────────────────────────────
  if has_function_privilege('authenticated', 'public.seed_business_workspace(uuid,text[])', 'execute') then
    raise exception 'FAIL 7a: authenticated can EXECUTE seed_business_workspace';
  end if;
  if has_function_privilege('anon', 'public.seed_business_workspace(uuid,text[])', 'execute') then
    raise exception 'FAIL 7b: anon can EXECUTE seed_business_workspace';
  end if;
  if not has_function_privilege('service_role', 'public.seed_business_workspace(uuid,text[])', 'execute') then
    raise exception 'FAIL 7c: service_role cannot EXECUTE seed_business_workspace';
  end if;
  if exists (select 1 from pg_roles where rolname = 'app_runtime')
     and has_function_privilege('app_runtime', 'public.seed_business_workspace(uuid,text[])', 'execute') then
    raise exception 'FAIL 7d: app_runtime can EXECUTE seed_business_workspace';
  end if;

  -- An owner session calling it is refused (no EXECUTE).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub','21140000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.seed_business_workspace(c_business);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 7e: an owner session executed seed_business_workspace'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  raise notice 'gp04_seed_business_workspace: all checks passed';
end $$;

rollback;
