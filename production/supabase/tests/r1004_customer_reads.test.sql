-- R-1004 attack test — support / delivery / sales / partner_agent must not read every
-- customer's phone, email and GSTIN. Migration: 20261012023458_r1004_customer_reads.sql.
--
-- Before the fix customers_select / contacts_select / invoices_select / payments_select were
-- tenant-only, so case 2 onward FAILS on the old policies and PASSES on the new ones.
--
--   1. owner, accountant, billing read all 7 customers + every contact/invoice/payment;
--      manager reads unclaimed + own team (hierarchy rule, unchanged).
--   2. sales A reads in full ONLY the customer A manages; unclaimed ones come by name
--      (customers_name_only) with no phone/email/GSTIN columns; rep B's customer not at all.
--      Contacts: A's customer's + the one with no customer. Invoices/payments: A's customer only.
--   3. support reads ONLY the customers on its assigned ticket and on the open unassigned
--      ticket — not the resolved one, not the project one. Contacts/invoices follow.
--   4. delivery reads ONLY the project customer (project_task for its employee) + the open
--      unassigned ticket's (delivery works the Support Desk too).
--   5. partner_agent reads nothing.
--   6. another company's owner reads none of these rows.
--   7. sales A claims the unclaimed customer → reads it in full; sales B cannot claim a
--      claimed one; support cannot claim; a customer sales B adds is B's (insert…returning works).
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1004000-0000-0000-0000-0000000000a1', 'r1004-owner@example.test'),
  ('c1004000-0000-0000-0000-0000000000a2', 'r1004-manager@example.test'),
  ('c1004000-0000-0000-0000-0000000000a3', 'r1004-acct@example.test'),
  ('c1004000-0000-0000-0000-0000000000a4', 'r1004-billing@example.test'),
  ('c1004000-0000-0000-0000-0000000000a5', 'r1004-salesa@example.test'),
  ('c1004000-0000-0000-0000-0000000000a6', 'r1004-salesb@example.test'),
  ('c1004000-0000-0000-0000-0000000000a7', 'r1004-support@example.test'),
  ('c1004000-0000-0000-0000-0000000000a8', 'r1004-delivery@example.test'),
  ('c1004000-0000-0000-0000-0000000000a9', 'r1004-partner@example.test'),
  ('c1004000-0000-0000-0000-0000000000b1', 'r1004-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1004000-0000-0000-0000-0000000000f0', 'R1004 T',  'r1004@example.test',  '07', 'R1004'),
  ('c1004000-0000-0000-0000-0000000000f1', 'R1004 T2', 'r1004b@example.test', '07', 'R1004B');

insert into public.employees (id, tenant_id, name)
  values ('c1004000-0000-0000-0000-0000000000e1', 'c1004000-0000-0000-0000-0000000000f0', 'R1004 Delivery Emp');

insert into public.users (id, tenant_id, email, full_name, role, is_active, manager_id, employee_id) values
  ('c1004000-0000-0000-0000-0000000000a1', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-owner@example.test',    'Owner',    'owner',         true, null, null),
  ('c1004000-0000-0000-0000-0000000000a2', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-manager@example.test',  'Manager',  'manager',       true, null, null),
  ('c1004000-0000-0000-0000-0000000000a3', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-acct@example.test',     'Acct',     'accountant',    true, null, null),
  ('c1004000-0000-0000-0000-0000000000a4', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-billing@example.test',  'Billing',  'billing',       true, null, null),
  ('c1004000-0000-0000-0000-0000000000a5', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-salesa@example.test',   'Sales A',  'sales',         true, 'c1004000-0000-0000-0000-0000000000a2', null),
  ('c1004000-0000-0000-0000-0000000000a6', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-salesb@example.test',   'Sales B',  'sales',         true, null, null),
  ('c1004000-0000-0000-0000-0000000000a7', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-support@example.test',  'Support',  'support',       true, null, null),
  ('c1004000-0000-0000-0000-0000000000a8', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-delivery@example.test', 'Delivery', 'delivery',      true, null, 'c1004000-0000-0000-0000-0000000000e1'),
  ('c1004000-0000-0000-0000-0000000000a9', 'c1004000-0000-0000-0000-0000000000f0', 'r1004-partner@example.test',  'Partner',  'partner_agent', true, null, null),
  ('c1004000-0000-0000-0000-0000000000b1', 'c1004000-0000-0000-0000-0000000000f1', 'r1004-other@example.test',    'Other',    'owner',         true, null, null);

-- Seven customers, each with phone / email / GSTIN.
--   c1 unclaimed · c2 sales A's · c3 sales B's · c4 support's assigned ticket
--   c5 open unassigned ticket · c6 resolved unassigned ticket · c7 delivery's project
insert into public.customers (id, tenant_id, name, contact_email, contact_phone, gstin, account_manager_id)
select ('c1004000-0000-0000-0000-0000000000c' || n)::uuid, 'c1004000-0000-0000-0000-0000000000f0',
       'R1004 Cust ' || n, 'cust' || n || '@example.test', '98100000' || n || n, '07AAAAA000' || n || 'A1Z5',
       case n when 2 then 'c1004000-0000-0000-0000-0000000000a5'::uuid
              when 3 then 'c1004000-0000-0000-0000-0000000000a6'::uuid end
  from generate_series(1, 7) n;
insert into public.customers (id, tenant_id, name, contact_email, contact_phone, gstin)
  values ('c1004000-0000-0000-0000-0000000000d1', 'c1004000-0000-0000-0000-0000000000f1',
          'R1004 Other Co Cust', 'other@example.test', '9999999999', '07BBBBB0000B1Z5');

insert into public.contacts (id, tenant_id, full_name, email, phone, customer_id)
select 'R1004-CT-' || n, 'c1004000-0000-0000-0000-0000000000f0', 'Person ' || n,
       'p' || n || '@example.test', '97000000' || n || n, ('c1004000-0000-0000-0000-0000000000c' || n)::uuid
  from generate_series(1, 7) n;
insert into public.contacts (id, tenant_id, full_name, email)
  values ('R1004-CT-0', 'c1004000-0000-0000-0000-0000000000f0', 'Lead person', 'lead@example.test');

insert into public.support_tickets (id, tenant_id, customer_id, customer_name, raised_by_email, category, subject, body, status, assigned_agent) values
  ('R1004-TK-4', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c4', 'R1004 Cust 4', 'x@example.test', 'other', 's', 'b', 'in_progress', 'c1004000-0000-0000-0000-0000000000a7'),
  ('R1004-TK-5', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c5', 'R1004 Cust 5', 'x@example.test', 'other', 's', 'b', 'open', null),
  ('R1004-TK-6', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c6', 'R1004 Cust 6', 'x@example.test', 'other', 's', 'b', 'resolved', null);

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount)
  values ('c1004000-0000-0000-0000-000000000071', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c7',
          'R1004 Cust 7', 'Rollout', 1000, 180, 1180);
insert into public.project_tasks (tenant_id, project_id, title, assignee_employee_id)
  values ('c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-000000000071', 'Set up', 'c1004000-0000-0000-0000-0000000000e1');

-- One invoice + one payment for the unclaimed customer (c1) and sales A's customer (c2).
insert into public.quotes (id, tenant_id, customer_id, customer_name) values
  ('R1004-Q1', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c1', 'R1004 Cust 1'),
  ('R1004-Q2', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c2', 'R1004 Cust 2');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount) values
  ('R1004-INV-1', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c1', 'R1004 Cust 1', 100),
  ('R1004-INV-2', 'c1004000-0000-0000-0000-0000000000f0', 'c1004000-0000-0000-0000-0000000000c2', 'R1004 Cust 2', 100);
insert into public.payments (tenant_id, quote_id, customer_id, amount, method) values
  ('c1004000-0000-0000-0000-0000000000f0', 'R1004-Q1', 'c1004000-0000-0000-0000-0000000000c1', 100, 'upi'),
  ('c1004000-0000-0000-0000-0000000000f0', 'R1004-Q2', 'c1004000-0000-0000-0000-0000000000c2', 100, 'upi');

-- Helper: counts of THIS tenant's fixture rows visible to the current caller.
create temp table r1004_seen (who text, cust int, cust_ids text, contacts int, contact_ids text, inv int, pay int, name_only int, name_only_ids text);
grant all on r1004_seen to authenticated;

create or replace function pg_temp.r1004_look(p_who text, p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  insert into r1004_seen
  select p_who,
    (select count(*) from public.customers where name like 'R1004 Cust %'),
    (select coalesce(string_agg(right(id::text, 1), '' order by id), '') from public.customers where name like 'R1004 Cust %'),
    (select count(*) from public.contacts where id like 'R1004-CT-%'),
    (select coalesce(string_agg(right(id, 1), '' order by id), '') from public.contacts where id like 'R1004-CT-%'),
    (select count(*) from public.invoices where id like 'R1004-INV-%'),
    (select count(*) from public.payments where quote_id like 'R1004-Q%'),
    (select count(*) from public.customers_name_only() n where n.name like 'R1004 Cust %'),
    (select coalesce(string_agg(right(n.id::text, 1), '' order by n.id), '') from public.customers_name_only() n where n.name like 'R1004 Cust %');
end $$;
grant execute on function pg_temp.r1004_look(text, uuid) to authenticated;

set local role authenticated;

select pg_temp.r1004_look('owner',    'c1004000-0000-0000-0000-0000000000a1');
select pg_temp.r1004_look('manager',  'c1004000-0000-0000-0000-0000000000a2');
select pg_temp.r1004_look('acct',     'c1004000-0000-0000-0000-0000000000a3');
select pg_temp.r1004_look('billing',  'c1004000-0000-0000-0000-0000000000a4');
select pg_temp.r1004_look('salesA',   'c1004000-0000-0000-0000-0000000000a5');
select pg_temp.r1004_look('support',  'c1004000-0000-0000-0000-0000000000a7');
select pg_temp.r1004_look('delivery', 'c1004000-0000-0000-0000-0000000000a8');
select pg_temp.r1004_look('partner',  'c1004000-0000-0000-0000-0000000000a9');
select pg_temp.r1004_look('other',    'c1004000-0000-0000-0000-0000000000b1');

do $$
declare r record;
begin
  -- 1. Full-read roles
  for r in select * from r1004_seen where who in ('owner', 'acct', 'billing') loop
    if r.cust <> 7 or r.contacts <> 8 or r.inv <> 2 or r.pay <> 2 or r.name_only <> 0 then
      raise exception 'FAIL 1: % sees cust=% contacts=% inv=% pay=% name_only=% (expected 7/8/2/2/0)',
        r.who, r.cust, r.contacts, r.inv, r.pay, r.name_only;
    end if;
  end loop;
  select * into r from r1004_seen where who = 'manager';
  -- unclaimed 1,4,5,6,7 + team member sales A's 2; not sales B's 3
  if r.cust_ids <> '124567' or r.inv <> 2 or r.pay <> 2 or r.name_only <> 0 then
    raise exception 'FAIL 1: manager sees customers % inv=% pay=% name_only=%', r.cust_ids, r.inv, r.pay, r.name_only;
  end if;
  raise notice 'PASS 1: owner/accountant/billing read all, manager reads unclaimed + own team';

  -- 2. Sales A
  select * into r from r1004_seen where who = 'salesA';
  if r.cust_ids <> '2' then
    raise exception 'FAIL 2: sales A reads full customer rows % (expected only 2 — the one A manages)', r.cust_ids;
  end if;
  if r.contact_ids <> '02' then
    raise exception 'FAIL 2: sales A reads contacts % (expected 0 = no customer, 2 = own customer)', r.contact_ids;
  end if;
  if r.inv <> 1 or r.pay <> 1 then
    raise exception 'FAIL 2: sales A reads % invoices / % payments (expected 1/1 — own customer only)', r.inv, r.pay;
  end if;
  if r.name_only_ids <> '14567' then
    raise exception 'FAIL 2: sales A name-only list % (expected unclaimed 1,4,5,6,7; not B''s 3)', r.name_only_ids;
  end if;
  raise notice 'PASS 2: sales A full row only for own customer; unclaimed by name only; B''s hidden';

  -- 3. Support
  select * into r from r1004_seen where who = 'support';
  if r.cust_ids <> '45' or r.contact_ids <> '45' or r.inv <> 0 or r.pay <> 0 then
    raise exception 'FAIL 3: support reads customers % contacts % inv=% pay=% (expected 45/45/0/0)',
      r.cust_ids, r.contact_ids, r.inv, r.pay;
  end if;
  if r.name_only_ids <> '12367' then
    raise exception 'FAIL 3: support name-only list % (expected 1,2,3,6,7)', r.name_only_ids;
  end if;
  raise notice 'PASS 3: support reads only ticket-linked customers (assigned + open queue)';

  -- 4. Delivery
  select * into r from r1004_seen where who = 'delivery';
  if r.cust_ids <> '57' or r.contact_ids <> '57' or r.inv <> 0 or r.pay <> 0 then
    raise exception 'FAIL 4: delivery reads customers % contacts % inv=% pay=% (expected 57/57/0/0)',
      r.cust_ids, r.contact_ids, r.inv, r.pay;
  end if;
  raise notice 'PASS 4: delivery reads only its project customer + the open ticket queue';

  -- 5. partner_agent, 6. other company
  for r in select * from r1004_seen where who in ('partner', 'other') loop
    if r.cust <> 0 or r.contacts <> 0 or r.inv <> 0 or r.pay <> 0 or r.name_only <> 0 then
      raise exception 'FAIL 5/6: % sees cust=% contacts=% inv=% pay=% name_only=%',
        r.who, r.cust, r.contacts, r.inv, r.pay, r.name_only;
    end if;
  end loop;
  raise notice 'PASS 5/6: partner_agent and another company read nothing';
end $$;

-- name-only rows carry no phone / email / GSTIN columns at all
do $$
declare v_cols text;
begin
  select string_agg(p, ',') into v_cols
    from unnest((select proargnames from pg_proc where oid = to_regprocedure('public.customers_name_only()'))) p;
  if v_cols ~ '(phone|email|address|contact_|(^|,)gstin(,|$))' then
    raise exception 'FAIL 2b: customers_name_only exposes %', v_cols;
  end if;
  raise notice 'PASS 2b: customers_name_only columns: %', v_cols;
end $$;

-- 7. Claiming
do $$
declare v_n int; v_refused boolean; v_new uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1004000-0000-0000-0000-0000000000a5', 'role', 'authenticated')::text, true);
  perform public.claim_customer('c1004000-0000-0000-0000-0000000000c1');
  select count(*) into v_n from public.customers
   where id = 'c1004000-0000-0000-0000-0000000000c1' and contact_phone is not null;
  if v_n <> 1 then raise exception 'FAIL 7: sales A cannot read the customer it just claimed'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1004000-0000-0000-0000-0000000000a6', 'role', 'authenticated')::text, true);
  v_refused := false;
  begin
    perform public.claim_customer('c1004000-0000-0000-0000-0000000000c1');
  exception when others then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 7: sales B claimed a customer sales A already has'; end if;
  v_refused := false;
  begin
    perform public.claim_customer('c1004000-0000-0000-0000-0000000000d1');
  exception when others then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 7: sales B claimed another company''s customer'; end if;

  -- sales B adds a customer and reads it back (insert … returning — the app's create path)
  insert into public.customers (tenant_id, name, contact_phone)
    values ('c1004000-0000-0000-0000-0000000000f0', 'R1004 New By B', '9000000000')
    returning id into v_new;
  select count(*) into v_n from public.customers where name = 'R1004 New By B'
     and account_manager_id = 'c1004000-0000-0000-0000-0000000000a6';
  if v_n <> 1 then raise exception 'FAIL 7: a customer sales B added is not B''s / not readable'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1004000-0000-0000-0000-0000000000a7', 'role', 'authenticated')::text, true);
  v_refused := false;
  begin
    perform public.claim_customer('c1004000-0000-0000-0000-0000000000c6');
  exception when others then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 7: support claimed a customer'; end if;

  -- delivery adds a customer (Project dialog) and reads it back
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1004000-0000-0000-0000-0000000000a8', 'role', 'authenticated')::text, true);
  v_new := null;
  insert into public.customers (tenant_id, name)
    values ('c1004000-0000-0000-0000-0000000000f0', 'R1004 New By Delivery')
    returning id into v_new;
  if v_new is null then raise exception 'FAIL 7: delivery could not read back the customer it added'; end if;
  raise notice 'PASS 7: claim works for sales on unclaimed rows only; creator manages new customer';
end $$;

rollback;
