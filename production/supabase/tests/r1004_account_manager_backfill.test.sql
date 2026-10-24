-- R-1004 follow-up (Pardeep decided HAAN, 16 Oct 2026): fill the account manager of OLD
-- customers from the sales person who made their lead / quote, so Sales sees its own
-- customers in full instead of every customer by name only.
-- Migration: 20261019002055_r1004_account_manager_backfill.sql
--
--   k1 lead created by sales A (lead owner sales B)        → A  (the maker comes first)
--   k2 lead created by the owner, lead owner sales B       → B  (maker is not sales → lead owner)
--   k3 quote owned by sales A only                         → A
--   k4 lead by sales B (older) + quote by sales A (newer)  → B  (the oldest record wins)
--   k5 lead by an INACTIVE sales C + quote by the manager  → stays unclaimed
--   k6 quote "owned" by a sales user of ANOTHER company    → stays unclaimed
--   k7 already managed by sales B, lead by sales A         → stays B (never overwritten)
--   k8 no lead, no quote                                   → stays unclaimed
-- Then, as authenticated: sales A reads k1+k3 in full, sales B reads k2+k4+k7; the owner,
-- accountant and billing still read all 8; support reads none of them (no ticket link).
-- A running it a second time changes nothing; authenticated cannot run it.
--
-- Fails before the migration (function missing), passes after.
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1004b00-0000-0000-0000-0000000000a1', 'r1004b-owner@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a2', 'r1004b-manager@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a3', 'r1004b-acct@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a4', 'r1004b-billing@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a5', 'r1004b-salesa@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a6', 'r1004b-salesb@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a7', 'r1004b-salesc@example.test'),
  ('c1004b00-0000-0000-0000-0000000000a8', 'r1004b-support@example.test'),
  ('c1004b00-0000-0000-0000-0000000000b1', 'r1004b-otherx@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1004b00-0000-0000-0000-0000000000f0', 'R1004B T',  'r1004b@example.test',  '07', 'R104B'),
  ('c1004b00-0000-0000-0000-0000000000f1', 'R1004B T2', 'r1004b2@example.test', '07', 'R104C');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1004b00-0000-0000-0000-0000000000a1', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-owner@example.test',   'Owner',   'owner',      true),
  ('c1004b00-0000-0000-0000-0000000000a2', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-manager@example.test', 'Manager', 'manager',    true),
  ('c1004b00-0000-0000-0000-0000000000a3', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-acct@example.test',    'Acct',    'accountant', true),
  ('c1004b00-0000-0000-0000-0000000000a4', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-billing@example.test', 'Billing', 'billing',    true),
  ('c1004b00-0000-0000-0000-0000000000a5', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-salesa@example.test',  'Sales A', 'sales',      true),
  ('c1004b00-0000-0000-0000-0000000000a6', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-salesb@example.test',  'Sales B', 'sales_senior', true),
  ('c1004b00-0000-0000-0000-0000000000a7', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-salesc@example.test',  'Sales C', 'sales',      false),
  ('c1004b00-0000-0000-0000-0000000000a8', 'c1004b00-0000-0000-0000-0000000000f0', 'r1004b-support@example.test', 'Support', 'support',    true),
  ('c1004b00-0000-0000-0000-0000000000b1', 'c1004b00-0000-0000-0000-0000000000f1', 'r1004b-otherx@example.test',  'Other X', 'sales',      true);

insert into public.customers (id, tenant_id, name, contact_email, contact_phone, gstin, account_manager_id)
select ('c1004b00-0000-0000-0000-0000000000c' || n)::uuid, 'c1004b00-0000-0000-0000-0000000000f0',
       'R1004B Cust ' || n, 'k' || n || '@example.test', '98200000' || n || n, '07CCCCC000' || n || 'A1Z5',
       case n when 7 then 'c1004b00-0000-0000-0000-0000000000a6'::uuid end
  from generate_series(1, 8) n;

insert into public.leads (id, tenant_id, company, customer_id, created_by, owner_id, created_at) values
  ('R1004B-L1', 'c1004b00-0000-0000-0000-0000000000f0', 'K1', 'c1004b00-0000-0000-0000-0000000000c1',
   'c1004b00-0000-0000-0000-0000000000a5', 'c1004b00-0000-0000-0000-0000000000a6', '2026-01-01'),
  ('R1004B-L2', 'c1004b00-0000-0000-0000-0000000000f0', 'K2', 'c1004b00-0000-0000-0000-0000000000c2',
   'c1004b00-0000-0000-0000-0000000000a1', 'c1004b00-0000-0000-0000-0000000000a6', '2026-01-01'),
  ('R1004B-L4', 'c1004b00-0000-0000-0000-0000000000f0', 'K4', 'c1004b00-0000-0000-0000-0000000000c4',
   'c1004b00-0000-0000-0000-0000000000a6', 'c1004b00-0000-0000-0000-0000000000a6', '2026-01-01'),
  ('R1004B-L5', 'c1004b00-0000-0000-0000-0000000000f0', 'K5', 'c1004b00-0000-0000-0000-0000000000c5',
   'c1004b00-0000-0000-0000-0000000000a7', 'c1004b00-0000-0000-0000-0000000000a7', '2026-01-01'),
  ('R1004B-L7', 'c1004b00-0000-0000-0000-0000000000f0', 'K7', 'c1004b00-0000-0000-0000-0000000000c7',
   'c1004b00-0000-0000-0000-0000000000a5', 'c1004b00-0000-0000-0000-0000000000a5', '2026-01-01');

insert into public.quotes (id, tenant_id, customer_id, customer_name, owner_id, created_at) values
  ('R1004B-Q3', 'c1004b00-0000-0000-0000-0000000000f0', 'c1004b00-0000-0000-0000-0000000000c3', 'K3',
   'c1004b00-0000-0000-0000-0000000000a5', '2026-02-01'),
  ('R1004B-Q4', 'c1004b00-0000-0000-0000-0000000000f0', 'c1004b00-0000-0000-0000-0000000000c4', 'K4',
   'c1004b00-0000-0000-0000-0000000000a5', '2026-02-01'),
  ('R1004B-Q5', 'c1004b00-0000-0000-0000-0000000000f0', 'c1004b00-0000-0000-0000-0000000000c5', 'K5',
   'c1004b00-0000-0000-0000-0000000000a2', '2026-02-01'),
  ('R1004B-Q6', 'c1004b00-0000-0000-0000-0000000000f0', 'c1004b00-0000-0000-0000-0000000000c6', 'K6',
   'c1004b00-0000-0000-0000-0000000000b1', '2026-02-01');

-- Insert triggers may stamp the maker from the session; pin the fixture values.
update public.leads set created_by = v.cb, owner_id = v.ow, created_at = '2026-01-01'
  from (values
    ('R1004B-L1', 'c1004b00-0000-0000-0000-0000000000a5'::uuid, 'c1004b00-0000-0000-0000-0000000000a6'::uuid),
    ('R1004B-L2', 'c1004b00-0000-0000-0000-0000000000a1'::uuid, 'c1004b00-0000-0000-0000-0000000000a6'::uuid),
    ('R1004B-L4', 'c1004b00-0000-0000-0000-0000000000a6'::uuid, 'c1004b00-0000-0000-0000-0000000000a6'::uuid),
    ('R1004B-L5', 'c1004b00-0000-0000-0000-0000000000a7'::uuid, 'c1004b00-0000-0000-0000-0000000000a7'::uuid),
    ('R1004B-L7', 'c1004b00-0000-0000-0000-0000000000a5'::uuid, 'c1004b00-0000-0000-0000-0000000000a5'::uuid)
  ) v(id, cb, ow)
 where leads.id = v.id;
update public.quotes set owner_id = v.ow, created_at = '2026-02-01'
  from (values
    ('R1004B-Q3', 'c1004b00-0000-0000-0000-0000000000a5'::uuid),
    ('R1004B-Q4', 'c1004b00-0000-0000-0000-0000000000a5'::uuid),
    ('R1004B-Q5', 'c1004b00-0000-0000-0000-0000000000a2'::uuid),
    ('R1004B-Q6', 'c1004b00-0000-0000-0000-0000000000b1'::uuid)
  ) v(id, ow)
 where quotes.id = v.id;

-- ── the backfill ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_n int;
  v_got text;
begin
  select public.r1004_backfill_account_managers() into v_n;
  select string_agg(right(c.id::text, 1) || '=' || coalesce(u.full_name, '-'), ' ' order by c.id)
    into v_got
    from public.customers c left join public.users u on u.id = c.account_manager_id
   where c.name like 'R1004B Cust %';
  if v_got is distinct from '1=Sales A 2=Sales B 3=Sales A 4=Sales B 5=- 6=- 7=Sales B 8=-' then
    raise exception 'FAIL 1: backfill gave %', v_got;
  end if;
  if v_n < 4 then
    raise exception 'FAIL 1: backfill reported % rows, expected at least the 4 fixture rows', v_n;
  end if;
  raise notice 'PASS 1: backfill — %', v_got;

  select public.r1004_backfill_account_managers() into v_n;
  if v_n <> 0 then
    raise exception 'FAIL 2: second run changed % rows', v_n;
  end if;
  raise notice 'PASS 2: second run changes nothing';
end $$;

-- ── what each role reads afterwards ─────────────────────────────────────────────────
create temp table r1004b_seen (who text, ids text, name_only text);
grant all on r1004b_seen to authenticated;

create or replace function pg_temp.r1004b_look(p_who text, p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  insert into r1004b_seen
  select p_who,
    (select coalesce(string_agg(right(id::text, 1), '' order by id), '')
       from public.customers where name like 'R1004B Cust %'),
    (select coalesce(string_agg(right(n.id::text, 1), '' order by n.id), '')
       from public.customers_name_only() n where n.name like 'R1004B Cust %');
end $$;
grant execute on function pg_temp.r1004b_look(text, uuid) to authenticated;

set local role authenticated;
select pg_temp.r1004b_look('owner',   'c1004b00-0000-0000-0000-0000000000a1');
select pg_temp.r1004b_look('acct',    'c1004b00-0000-0000-0000-0000000000a3');
select pg_temp.r1004b_look('billing', 'c1004b00-0000-0000-0000-0000000000a4');
select pg_temp.r1004b_look('salesA',  'c1004b00-0000-0000-0000-0000000000a5');
select pg_temp.r1004b_look('salesB',  'c1004b00-0000-0000-0000-0000000000a6');
select pg_temp.r1004b_look('support', 'c1004b00-0000-0000-0000-0000000000a8');

-- authenticated may not run the backfill
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1004b00-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
do $$
begin
  perform public.r1004_backfill_account_managers();
  raise exception 'FAIL 4: authenticated (owner) could run the backfill';
exception when insufficient_privilege then
  raise notice 'PASS 4: authenticated cannot run the backfill';
end $$;
reset role;

do $$
declare r record;
begin
  for r in select * from r1004b_seen loop
    if (r.who in ('owner', 'acct', 'billing') and (r.ids, r.name_only) is distinct from ('12345678', ''))
       or (r.who = 'salesA'  and (r.ids, r.name_only) is distinct from ('13', '568'))
       or (r.who = 'salesB'  and (r.ids, r.name_only) is distinct from ('247', '568'))
       or (r.who = 'support' and (r.ids, r.name_only) is distinct from ('', '12345678')) then
      raise exception 'FAIL 3: % reads full=% name-only=%', r.who, r.ids, r.name_only;
    end if;
  end loop;
  if (select count(*) from r1004b_seen) <> 6 then
    raise exception 'FAIL 3: expected 6 looks, got %', (select count(*) from r1004b_seen);
  end if;
  raise notice 'PASS 3: owner/accountant/billing read all 8; sales A 1,3; sales B 2,4,7; unclaimed by name; support none';
end $$;

rollback;
