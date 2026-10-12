-- R-1400 attack test — sales / support / delivery / partner_agent must not read quotes (customer
-- name, domain, amounts, payment refs) of customers R-1004 hides from them.
-- Migration: 20261012032851_r1400_quotes_reads.sql.
--
-- Before the fix every low role read every quote in the company (quotes_select is tenant-only and
-- the restrictive hierarchy rule lets unowned rows and support/delivery/partner through), so
-- cases 2–5 FAIL on the old policies and PASS on the new ones.
--
--   Quotes: Q1 unowned on unclaimed c1 · Q2 unowned on sales A's c2 · Q3 sales B's on c3
--           Q4 prospect quote (no customer) on unowned lead · Q5 sales A's own on c1
--           Q6 unowned on c4 (support's assigned ticket)
--   1. owner reads all 6.
--   2. sales A reads Q2 Q4 Q5 — not Q1 (unclaimed customer's), not Q3; no phone/email/GSTIN of c1
--      reachable through any visible quote.
--   3. support reads Q6 only. 4. partner_agent reads none.
--   5. sales A saves a quote with no owner → it is theirs and `insert … returning` works.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1400000-0000-0000-0000-0000000000a1', 'r1400-owner@example.test'),
  ('c1400000-0000-0000-0000-0000000000a5', 'r1400-salesa@example.test'),
  ('c1400000-0000-0000-0000-0000000000a6', 'r1400-salesb@example.test'),
  ('c1400000-0000-0000-0000-0000000000a7', 'r1400-support@example.test'),
  ('c1400000-0000-0000-0000-0000000000a9', 'r1400-partner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1400000-0000-0000-0000-0000000000f0', 'R1400 T', 'r1400@example.test', '07', 'R1400');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1400000-0000-0000-0000-0000000000a1', 'c1400000-0000-0000-0000-0000000000f0', 'r1400-owner@example.test',   'Owner',   'owner',         true),
  ('c1400000-0000-0000-0000-0000000000a5', 'c1400000-0000-0000-0000-0000000000f0', 'r1400-salesa@example.test',  'Sales A', 'sales',         true),
  ('c1400000-0000-0000-0000-0000000000a6', 'c1400000-0000-0000-0000-0000000000f0', 'r1400-salesb@example.test',  'Sales B', 'sales',         true),
  ('c1400000-0000-0000-0000-0000000000a7', 'c1400000-0000-0000-0000-0000000000f0', 'r1400-support@example.test', 'Support', 'support',       true),
  ('c1400000-0000-0000-0000-0000000000a9', 'c1400000-0000-0000-0000-0000000000f0', 'r1400-partner@example.test', 'Partner', 'partner_agent', true);

insert into public.customers (id, tenant_id, name, contact_email, contact_phone, gstin, account_manager_id)
select ('c1400000-0000-0000-0000-0000000000c' || n)::uuid, 'c1400000-0000-0000-0000-0000000000f0',
       'R1400 Cust ' || n, 'cust' || n || '@example.test', '98100000' || n || n, '07AAAAA000' || n || 'A1Z5',
       case n when 2 then 'c1400000-0000-0000-0000-0000000000a5'::uuid
              when 3 then 'c1400000-0000-0000-0000-0000000000a6'::uuid end
  from generate_series(1, 4) n;

insert into public.support_tickets (id, tenant_id, customer_id, customer_name, raised_by_email, category, subject, body, status, assigned_agent) values
  ('R1400-TK-4', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c4', 'R1400 Cust 4', 'x@example.test', 'other', 's', 'b', 'in_progress', 'c1400000-0000-0000-0000-0000000000a7');

insert into public.leads (id, tenant_id, company)
  values ('R1400-L1', 'c1400000-0000-0000-0000-0000000000f0', 'R1400 Prospect');

insert into public.quotes (id, tenant_id, customer_id, customer_name, lead_id, owner_id, domain) values
  ('R1400-Q1', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c1', 'R1400 Cust 1', null, null, 'cust1.example.test'),
  ('R1400-Q2', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c2', 'R1400 Cust 2', null, null, null),
  ('R1400-Q3', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c3', 'R1400 Cust 3', null, 'c1400000-0000-0000-0000-0000000000a6', null),
  ('R1400-Q4', 'c1400000-0000-0000-0000-0000000000f0', null,                                    'R1400 Prospect', 'R1400-L1', null, null),
  ('R1400-Q5', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c1', 'R1400 Cust 1', null, 'c1400000-0000-0000-0000-0000000000a5', null),
  ('R1400-Q6', 'c1400000-0000-0000-0000-0000000000f0', 'c1400000-0000-0000-0000-0000000000c4', 'R1400 Cust 4', null, null, null);

create temp table r1400_seen (who text, quote_ids text, contact_leak int);
grant all on r1400_seen to authenticated;

create or replace function pg_temp.r1400_look(p_who text, p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  insert into r1400_seen
  select p_who,
    (select coalesce(string_agg(right(id, 1), '' order by id), '') from public.quotes where id like 'R1400-Q%'),
    -- the unclaimed customer's phone / email / GSTIN, reached through a visible quote
    (select count(*) from public.quotes q join public.customers c on c.id = q.customer_id
      where q.id like 'R1400-Q%' and c.id = 'c1400000-0000-0000-0000-0000000000c1'
        and (c.contact_phone is not null or c.contact_email is not null or c.gstin is not null));
end $$;
grant execute on function pg_temp.r1400_look(text, uuid) to authenticated;

set local role authenticated;

select pg_temp.r1400_look('owner',   'c1400000-0000-0000-0000-0000000000a1');
select pg_temp.r1400_look('salesA',  'c1400000-0000-0000-0000-0000000000a5');
select pg_temp.r1400_look('support', 'c1400000-0000-0000-0000-0000000000a7');
select pg_temp.r1400_look('partner', 'c1400000-0000-0000-0000-0000000000a9');

do $$
declare r record; v_owner uuid;
begin
  select * into r from r1400_seen where who = 'owner';
  if r.quote_ids <> '123456' then raise exception 'FAIL 1: owner sees quotes % (expected 123456)', r.quote_ids; end if;
  raise notice 'PASS 1: owner reads every quote';

  select * into r from r1400_seen where who = 'salesA';
  if r.quote_ids <> '245' then
    raise exception 'FAIL 2: sales A sees quotes % (expected 245 — not the unclaimed customer''s Q1, not B''s Q3, not Q6)', r.quote_ids;
  end if;
  if r.contact_leak <> 0 then raise exception 'FAIL 2: sales A reads the unclaimed customer''s contact details via quotes'; end if;
  raise notice 'PASS 2: sales A reads own/team/prospect quotes only; no contact details of the unclaimed customer';

  select * into r from r1400_seen where who = 'support';
  if r.quote_ids <> '6' then raise exception 'FAIL 3: support sees quotes % (expected 6)', r.quote_ids; end if;
  raise notice 'PASS 3: support reads linked customers'' quotes only';

  select * into r from r1400_seen where who = 'partner';
  if r.quote_ids <> '' then raise exception 'FAIL 4: partner_agent sees quotes %', r.quote_ids; end if;
  raise notice 'PASS 4: partner_agent reads none';

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1400000-0000-0000-0000-0000000000a5', 'role', 'authenticated')::text, true);
  insert into public.quotes (id, tenant_id, customer_name, lead_id)
    values ('R1400-Q7', 'c1400000-0000-0000-0000-0000000000f0', 'R1400 Prospect', 'R1400-L1')
    returning owner_id into v_owner;
  if v_owner is distinct from 'c1400000-0000-0000-0000-0000000000a5'::uuid then
    raise exception 'FAIL 5: a quote sales A saved is owned by %', v_owner;
  end if;
  raise notice 'PASS 5: a quote a low role saves is theirs (insert … returning works)';
end $$;

rollback;
