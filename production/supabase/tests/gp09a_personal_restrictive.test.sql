-- R-2122 (GP-09a, goal G-PERSONAL) — the DB wall, part 1.
-- Migration: 20261030071753_gp09a_personal_restrictive_money.sql
--
-- A personal session (users.role = 'personal', OR any login of a tenant whose
-- workspace_kind = 'personal') must not read or write the business money / GST tables,
-- whatever the page or API layer does. public.is_personal_session() + one RESTRICTIVE
-- gp09_personal_wall policy per table does that.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   0. is_personal_session() exists, is SECURITY DEFINER, has search_path pinned, no PUBLIC/anon EXECUTE.
--   1. Coverage: every table on the wall list has a gp09_* RESTRICTIVE policy for ALL.
--   2. Kind branch: an OWNER of a personal-kind tenant (owner passes every permissive policy)
--      cannot insert customers / quotes, cannot insert invoices, and reads 0 invoices /
--      customers / quotes / bank_accounts of their own tenant.                     <- red on old code
--   3. Role branch: a role-'personal' login inside a BUSINESS tenant reads 0 rows of that
--      tenant and cannot insert a quote (quotes_insert only checks the tenant).    <- red on old code
--   4. A personal user can still write their own personal_transactions.
--   5. A business owner is unchanged: inserts a customer and a quote, reads the invoice.
--   6. EXPLAIN: the wall is an InitPlan, and over 5 rows the helper runs once per query.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/gp09a_personal_restrictive.test.sql

begin;

-- ── 0. the helper exists and is hardened ─────────────────────────────────────────────
do $$
declare v_oid oid := to_regprocedure('public.is_personal_session()');
begin
  if v_oid is null then
    raise exception 'FAIL 0: public.is_personal_session() does not exist — migration gp09a not applied';
  end if;
  if not (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'FAIL 0: is_personal_session() is not SECURITY DEFINER';
  end if;
  if (select provolatile from pg_proc where oid = v_oid) <> 's' then
    raise exception 'FAIL 0: is_personal_session() is not STABLE (the InitPlan hoist needs it)';
  end if;
  if not exists (select 1 from pg_proc p, unnest(coalesce(p.proconfig, '{}'::text[])) c
                  where p.oid = v_oid and c like 'search\_path=%') then
    raise exception 'FAIL 0: is_personal_session() has no pinned search_path';
  end if;
  if has_function_privilege('anon', v_oid, 'execute') then
    raise exception 'FAIL 0: anon can EXECUTE is_personal_session() (R-013)';
  end if;
  if not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'FAIL 0: authenticated cannot EXECUTE is_personal_session() — every policy would error';
  end if;
end $$;

-- ── 1. coverage: the wall list, one gp09_ RESTRICTIVE FOR ALL policy each ─────────────
do $$
declare
  v_list text[] := array[
    'customers', 'quotes', 'invoices', 'credit_notes', 'debit_notes', 'payments',
    'subscriptions', 'subscription_billings', 'customer_credits', 'project_sales',
    'bank_accounts', 'bank_transactions', 'txn_category_rules',
    'opening_balances', 'cancelled_vouchers', 'tax_payments', 'tds_receivable'];
  v_missing text;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(v_list) t
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t
        and p.policyname like 'gp09\_%' and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
        and p.qual ilike '%is_personal_session%' and p.with_check ilike '%is_personal_session%'
        -- initplan wrap (20260928100000): pg_get_expr prints a wrapped call as "( SELECT ..."
        and p.qual ilike '%( SELECT is_personal_session()%');
  if v_missing is not null then
    raise exception 'FAIL 1: no wrapped gp09_ RESTRICTIVE FOR ALL policy on: %', v_missing;
  end if;
end $$;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2122000-0000-0000-0000-0000000000a1', 'gp09a-owner@example.test'),
  ('c2122000-0000-0000-0000-0000000000a2', 'gp09a-personal@example.test'),
  ('c2122000-0000-0000-0000-0000000000a3', 'gp09a-kind-owner@example.test'),
  ('c2122000-0000-0000-0000-0000000000a4', 'gp09a-role-personal@example.test');

-- superuser here, so the R-720 guard lets the fixture set workspace_kind.
insert into public.tenants (id, name, email, state_code, doc_code, workspace_kind) values
  ('c2122000-0000-0000-0000-0000000000f1', 'GP09A BIZ', 'gp09a-biz@example.test', '07', 'G9AB', 'business'),
  ('c2122000-0000-0000-0000-0000000000f2', 'GP09A ME',  'gp09a-me@example.test',  '07', 'G9AP', 'personal');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2122000-0000-0000-0000-0000000000a1', 'c2122000-0000-0000-0000-0000000000f1', 'gp09a-owner@example.test',         'Biz Owner',       'owner',    true),
  ('c2122000-0000-0000-0000-0000000000a2', 'c2122000-0000-0000-0000-0000000000f2', 'gp09a-personal@example.test',      'Personal User',   'personal', true),
  -- kind branch: role owner, but the tenant is personal
  ('c2122000-0000-0000-0000-0000000000a3', 'c2122000-0000-0000-0000-0000000000f2', 'gp09a-kind-owner@example.test',    'Kind Owner',      'owner',    true),
  -- role branch: role personal, but the tenant is business
  ('c2122000-0000-0000-0000-0000000000a4', 'c2122000-0000-0000-0000-0000000000f1', 'gp09a-role-personal@example.test','Role Personal',   'personal', true);

-- business rows: 5 customers (for the once-per-query count), 1 invoice, 1 bank account
insert into public.customers (tenant_id, name)
  select 'c2122000-0000-0000-0000-0000000000f1', 'GP09A Cust ' || g from generate_series(1, 5) g;
insert into public.invoices (id, tenant_id, customer_name, amount)
  values ('GP09A-INV-B1', 'c2122000-0000-0000-0000-0000000000f1', 'GP09A Cust 1', 11800);
-- the same in the personal-kind tenant (what an owner of it would see on old code)
insert into public.customers (tenant_id, name)
  values ('c2122000-0000-0000-0000-0000000000f2', 'GP09A Personal Cust');
insert into public.invoices (id, tenant_id, customer_name, amount)
  values ('GP09A-INV-P1', 'c2122000-0000-0000-0000-0000000000f2', 'GP09A Personal Cust', 5900);
insert into public.quotes (id, tenant_id, customer_name)
  values ('GP09A-Q-P1', 'c2122000-0000-0000-0000-0000000000f2', 'GP09A Personal Cust');

set local track_functions = 'all';
set local role authenticated;

do $$
declare
  v_owner  uuid := 'c2122000-0000-0000-0000-0000000000a1';
  v_pers   uuid := 'c2122000-0000-0000-0000-0000000000a2';
  v_kindow uuid := 'c2122000-0000-0000-0000-0000000000a3';
  v_rolep  uuid := 'c2122000-0000-0000-0000-0000000000a4';
  v_biz    uuid := 'c2122000-0000-0000-0000-0000000000f1';
  v_me     uuid := 'c2122000-0000-0000-0000-0000000000f2';
  n        integer;
  v_who    uuid;
  v_ten    uuid;
  v_label  text;
  v_blocked boolean;
begin
  ------------------------------------------------- 2 + 3. personal sessions: nothing
  foreach v_who in array array[v_kindow, v_pers, v_rolep] loop
    v_ten := case when v_who = v_rolep then v_biz else v_me end;
    v_label := case v_who when v_kindow then 'owner of a PERSONAL tenant'
                          when v_pers   then 'personal user'
                          else 'role-personal login in a BUSINESS tenant' end;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_who::text, 'role', 'authenticated')::text, true);
    if auth.uid() <> v_who then
      raise exception 'SETUP FAIL: impersonation of % did not take', v_label;
    end if;
    if not public.is_personal_session() then
      raise exception 'FAIL 2: is_personal_session() is false for the %', v_label;
    end if;

    select count(*) into n from public.invoices where tenant_id = v_ten;
    if n <> 0 then raise exception 'FAIL 2: the % reads % invoice(s) of its tenant', v_label, n; end if;
    select count(*) into n from public.customers where tenant_id = v_ten;
    if n <> 0 then raise exception 'FAIL 2: the % reads % customer(s)', v_label, n; end if;
    select count(*) into n from public.quotes where tenant_id = v_ten;
    if n <> 0 then raise exception 'FAIL 2: the % reads % quote(s)', v_label, n; end if;
    select count(*) into n from public.bank_accounts where tenant_id = v_ten;
    if n <> 0 then raise exception 'FAIL 2: the % reads % bank account(s)', v_label, n; end if;

    begin
      insert into public.customers (tenant_id, name) values (v_ten, 'GP09A planted');
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted a customer', v_label; end if;

    begin
      insert into public.quotes (id, tenant_id, customer_name) values ('GP09A-Q-X-' || left(v_who::text, 8) || right(v_who::text, 2), v_ten, 'x');
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted a quote', v_label; end if;

    begin
      insert into public.invoices (id, tenant_id, customer_name, amount) values ('GP09A-INV-X-' || right(v_who::text, 2), v_ten, 'x', 100);
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted an invoice', v_label; end if;

    -- an UPDATE of the tenant's invoice is a silent no-op
    update public.invoices set amount = 1 where id in ('GP09A-INV-P1', 'GP09A-INV-B1');
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL 2: the % updated % invoice(s)', v_label, n; end if;
  end loop;

  --------------------------------------- 4. the personal user's own money still works
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_pers::text, 'role', 'authenticated')::text, true);
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on)
    values (v_me, v_pers, 'expense', 45000, current_date);
  select count(*) into n from public.personal_transactions where owner_user_id = v_pers;
  if n <> 1 then raise exception 'FAIL 4: the personal user reads % of their own transactions, expected 1', n; end if;

  ---------------------------------------------------- 5. a business owner is unchanged
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  if public.is_personal_session() then
    raise exception 'FAIL 5: is_personal_session() is true for a business owner';
  end if;
  select count(*) into n from public.invoices where tenant_id = v_biz;
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % invoice(s), expected 1', n; end if;
  select count(*) into n from public.customers where tenant_id = v_biz;
  if n <> 5 then raise exception 'FAIL 5: the business owner reads % customer(s), expected 5', n; end if;
  insert into public.customers (tenant_id, name) values (v_biz, 'GP09A owner-made');
  insert into public.quotes (id, tenant_id, customer_name) values ('GP09A-Q-OWNER', v_biz, 'GP09A Cust 1');
  update public.customers set name = name || ' (edited)' where tenant_id = v_biz and name = 'GP09A Cust 1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 5: the business owner updated % customer(s), expected 1', n; end if;
end $$;

-- ── 6. InitPlan: hoisted, and evaluated once per query (not once per row) ─────────────
do $$
declare
  v_plan  text := '';
  v_line  text;
  v_before bigint;
  v_after  bigint;
  n integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2122000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  for v_line in execute 'explain (verbose, costs off) select id from public.customers' loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  if v_plan !~ 'InitPlan' or v_plan !~ 'is_personal_session\(\)' then
    raise exception 'FAIL 6: is_personal_session() is not in an InitPlan:%', E'\n' || v_plan;
  end if;
  if v_plan ~ 'Filter:[^\n]*is_personal_session\(\)' then
    raise exception 'FAIL 6: is_personal_session() is a per-row Filter:%', E'\n' || v_plan;
  end if;

  select coalesce(sum(calls), 0) into v_before from pg_stat_xact_user_functions
   where schemaname = 'public' and funcname = 'is_personal_session';
  select count(*) into n from public.customers where tenant_id = 'c2122000-0000-0000-0000-0000000000f1';
  if n < 5 then raise exception 'SETUP FAIL 6: owner sees only % customers', n; end if;
  select coalesce(sum(calls), 0) into v_after from pg_stat_xact_user_functions
   where schemaname = 'public' and funcname = 'is_personal_session';
  if v_after - v_before > 1 then
    raise exception 'FAIL 6: is_personal_session() ran % times for one query over % rows — not hoisted', v_after - v_before, n;
  end if;
end $$;

do $$ begin raise notice 'gp09a_personal_restrictive: all checks passed'; end $$;

rollback;
