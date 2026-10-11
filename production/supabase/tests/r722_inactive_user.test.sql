-- R-722 attack test — a DEACTIVATED member must get nothing from the database.
-- Migration: 20261011131500_r722_inactive_user_tenant.sql (current_tenant_id() requires is_active).
--
-- Before the fix current_tenant_id() ignored users.is_active, so a member the owner had switched
-- off still read every lead/customer/teammate and could insert and update rows while their login
-- lived. This file FAILS on the old function (case 2 onward) and PASSES on the new one.
--
--   1. ACTIVE manager: current_tenant_id() = the tenant, sees the lead + customer, can write.  (no over-block)
--   2. The same manager DEACTIVATED: current_tenant_id() IS NULL.
--   3. … reads 0 leads, 0 customers, and of users only their own row (users_self_read).
--   4. … INSERT into leads is refused (RLS), UPDATE of customers changes 0 rows.
--   5. … SECURITY DEFINER get_subordinate_user_ids(owner) returns nothing (tenant check).
--   6. A deactivated OWNER is the same (no owner exception).
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c7220000-0000-0000-0000-0000000000a1', 'r722-owner@example.test'),
  ('c7220000-0000-0000-0000-0000000000a2', 'r722-member@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c7220000-0000-0000-0000-0000000000f0', 'R722 T', 'r722@example.test', '07', 'R722');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c7220000-0000-0000-0000-0000000000a1', 'c7220000-0000-0000-0000-0000000000f0', 'r722-owner@example.test',  'R722 Owner',  'owner',   true),
  ('c7220000-0000-0000-0000-0000000000a2', 'c7220000-0000-0000-0000-0000000000f0', 'r722-member@example.test', 'R722 Member', 'manager', true);

insert into public.leads (id, tenant_id, company)
  values ('R722-LEAD-1', 'c7220000-0000-0000-0000-0000000000f0', 'R722 Lead Co');
insert into public.customers (tenant_id, name)
  values ('c7220000-0000-0000-0000-0000000000f0', 'R722 Customer');

set local role authenticated;

-- ── 1. Active member: everything works ─────────────────────────────────────────────
do $$
declare
  v_t   uuid := 'c7220000-0000-0000-0000-0000000000f0';
  v_n   int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c7220000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from v_t then
    raise exception 'FAIL 1: active member current_tenant_id() = %, expected %', public.current_tenant_id(), v_t;
  end if;
  select count(*) into v_n from public.leads where tenant_id = v_t;
  if v_n <> 1 then raise exception 'FAIL 1: active member sees % leads, expected 1', v_n; end if;
  select count(*) into v_n from public.customers where tenant_id = v_t;
  if v_n <> 1 then raise exception 'FAIL 1: active member sees % customers, expected 1', v_n; end if;
  update public.customers set name = 'R722 Customer (edited)' where tenant_id = v_t;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 1: active member updated % customers, expected 1', v_n; end if;
  select count(*) into v_n from public.users where tenant_id = v_t;
  if v_n <> 2 then raise exception 'FAIL 1: active member sees % teammates, expected 2', v_n; end if;
  raise notice 'PASS 1: active member reads + writes as before';
end $$;

-- ── Owner switches the member off (as the server would; superuser for the setup) ──
reset role;
select set_config('request.jwt.claims', '', true);
update public.users set is_active = false where id = 'c7220000-0000-0000-0000-0000000000a2';
set local role authenticated;

-- ── 2–5. Deactivated member: nothing ───────────────────────────────────────────────
do $$
declare
  v_t       uuid := 'c7220000-0000-0000-0000-0000000000f0';
  v_n       int;
  v_refused boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c7220000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

  if public.current_tenant_id() is not null then
    raise exception 'FAIL 2: deactivated member still gets current_tenant_id() = %', public.current_tenant_id();
  end if;
  raise notice 'PASS 2: current_tenant_id() is NULL for a deactivated member';

  select count(*) into v_n from public.leads;
  if v_n <> 0 then raise exception 'FAIL 3: deactivated member reads % leads', v_n; end if;
  select count(*) into v_n from public.customers;
  if v_n <> 0 then raise exception 'FAIL 3: deactivated member reads % customers', v_n; end if;
  select count(*) into v_n from public.users;
  if v_n <> 1 then raise exception 'FAIL 3: deactivated member reads % users rows (expected only their own)', v_n; end if;
  raise notice 'PASS 3: deactivated member reads 0 leads, 0 customers, only their own users row';

  begin
    insert into public.leads (id, tenant_id, company) values ('R722-LEAD-2', v_t, 'Sneaky Lead');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 4: deactivated member could INSERT a lead'; end if;
  update public.customers set name = 'hijacked' where tenant_id = v_t;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: deactivated member updated % customers', v_n; end if;
  raise notice 'PASS 4: deactivated member insert refused, update changes 0 rows';

  select count(*) into v_n from public.get_subordinate_user_ids('c7220000-0000-0000-0000-0000000000a1');
  if v_n <> 0 then raise exception 'FAIL 5: get_subordinate_user_ids gave a deactivated member % ids', v_n; end if;
  raise notice 'PASS 5: SECURITY DEFINER get_subordinate_user_ids returns nothing';
end $$;

-- ── 6. A deactivated OWNER is no exception ───────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);
update public.users set is_active = false where id = 'c7220000-0000-0000-0000-0000000000a1';
set local role authenticated;

do $$
declare v_n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c7220000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is not null then
    raise exception 'FAIL 6: deactivated owner still gets current_tenant_id()';
  end if;
  select count(*) into v_n from public.customers;
  if v_n <> 0 then raise exception 'FAIL 6: deactivated owner reads % customers', v_n; end if;
  raise notice 'PASS 6: deactivated owner gets nothing either';
end $$;

rollback;
