-- R-1401 attack test — support / delivery / partner_agent must not read every lead in the
-- company (contact name, phone, email). Migration: 20261016102600_r1401_leads_reads.sql.
--
-- Before the fix hierarchy_sees_all() was TRUE for those three roles and leads_select is
-- tenant-only, so cases 3–5 FAIL on the old policies and PASS on the new ones.
--
--   Leads: L1 unowned · L2 sales A's · L3 sales B's · L4 support's own · L5 unowned on customer c4
--          (support's assigned ticket) · L6 unowned, on a task delivery owns · L7 partner's own
--          L8 created by partner, owned by sales B · L9 another company's
--   1. owner and accountant read L1–L8; manager reads unowned + own team (1,2,5,6 — unchanged).
--   2. sales A reads 1,2,5,6; sales B reads 1,3,5,6,8 (hierarchy rule, unchanged).
--   3. support reads ONLY L4 (own) + L5 (linked customer) — nothing else.
--   4. delivery reads ONLY L6 (its task).
--   5. partner_agent reads ONLY L7 + L8 (own / created).
--   6. another company's owner reads only its own L9, none of L1–L8.
--   7. support cannot UPDATE L1 by id (0 rows); a lead support adds with no created_by is
--      readable back (insert … returning — the app's create path).
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1401000-0000-0000-0000-0000000000a1', 'r1401-owner@example.test'),
  ('c1401000-0000-0000-0000-0000000000a2', 'r1401-manager@example.test'),
  ('c1401000-0000-0000-0000-0000000000a3', 'r1401-acct@example.test'),
  ('c1401000-0000-0000-0000-0000000000a5', 'r1401-salesa@example.test'),
  ('c1401000-0000-0000-0000-0000000000a6', 'r1401-salesb@example.test'),
  ('c1401000-0000-0000-0000-0000000000a7', 'r1401-support@example.test'),
  ('c1401000-0000-0000-0000-0000000000a8', 'r1401-delivery@example.test'),
  ('c1401000-0000-0000-0000-0000000000a9', 'r1401-partner@example.test'),
  ('c1401000-0000-0000-0000-0000000000b1', 'r1401-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1401000-0000-0000-0000-0000000000f0', 'R1401 T',  'r1401@example.test',  '07', 'R1401'),
  ('c1401000-0000-0000-0000-0000000000f1', 'R1401 T2', 'r1401b@example.test', '07', 'R1401B');

insert into public.users (id, tenant_id, email, full_name, role, is_active, manager_id) values
  ('c1401000-0000-0000-0000-0000000000a1', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-owner@example.test',    'Owner',    'owner',         true, null),
  ('c1401000-0000-0000-0000-0000000000a2', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-manager@example.test',  'Manager',  'manager',       true, null),
  ('c1401000-0000-0000-0000-0000000000a3', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-acct@example.test',     'Acct',     'accountant',    true, null),
  ('c1401000-0000-0000-0000-0000000000a5', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-salesa@example.test',   'Sales A',  'sales',         true, 'c1401000-0000-0000-0000-0000000000a2'),
  ('c1401000-0000-0000-0000-0000000000a6', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-salesb@example.test',   'Sales B',  'sales',         true, null),
  ('c1401000-0000-0000-0000-0000000000a7', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-support@example.test',  'Support',  'support',       true, null),
  ('c1401000-0000-0000-0000-0000000000a8', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-delivery@example.test', 'Delivery', 'delivery',      true, null),
  ('c1401000-0000-0000-0000-0000000000a9', 'c1401000-0000-0000-0000-0000000000f0', 'r1401-partner@example.test',  'Partner',  'partner_agent', true, null),
  ('c1401000-0000-0000-0000-0000000000b1', 'c1401000-0000-0000-0000-0000000000f1', 'r1401-other@example.test',    'Other',    'owner',         true, null);

-- c4: the customer on support's assigned ticket (LINKED for support — R-1004 my_customer_ids)
insert into public.customers (id, tenant_id, name, contact_email, contact_phone)
  values ('c1401000-0000-0000-0000-0000000000c4', 'c1401000-0000-0000-0000-0000000000f0',
          'R1401 Cust 4', 'cust4@example.test', '9810000044');
insert into public.support_tickets (id, tenant_id, customer_id, customer_name, raised_by_email, category, subject, body, status, assigned_agent)
  values ('R1401-TK-4', 'c1401000-0000-0000-0000-0000000000f0', 'c1401000-0000-0000-0000-0000000000c4',
          'R1401 Cust 4', 'x@example.test', 'other', 's', 'b', 'in_progress', 'c1401000-0000-0000-0000-0000000000a7');

insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, owner_id, created_by, customer_id) values
  ('R1401-L1', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 1', 'P1', 'p1@example.test', '9700000011', null, null, null),
  ('R1401-L2', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 2', 'P2', 'p2@example.test', '9700000022', 'c1401000-0000-0000-0000-0000000000a5', null, null),
  ('R1401-L3', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 3', 'P3', 'p3@example.test', '9700000033', 'c1401000-0000-0000-0000-0000000000a6', null, null),
  ('R1401-L4', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 4', 'P4', 'p4@example.test', '9700000044', 'c1401000-0000-0000-0000-0000000000a7', null, null),
  ('R1401-L5', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 5', 'P5', 'p5@example.test', '9700000055', null, null, 'c1401000-0000-0000-0000-0000000000c4'),
  ('R1401-L6', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 6', 'P6', 'p6@example.test', '9700000066', null, null, null),
  ('R1401-L7', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 7', 'P7', 'p7@example.test', '9700000077', 'c1401000-0000-0000-0000-0000000000a9', null, null),
  ('R1401-L8', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 Co 8', 'P8', 'p8@example.test', '9700000088', 'c1401000-0000-0000-0000-0000000000a6', 'c1401000-0000-0000-0000-0000000000a9', null),
  ('R1401-L9', 'c1401000-0000-0000-0000-0000000000f1', 'R1401 Co 9', 'P9', 'p9@example.test', '9700000099', null, null, null);

-- L6: a follow-up task delivery owns
insert into public.tasks (tenant_id, owner_id, title, due_at, lead_id)
  values ('c1401000-0000-0000-0000-0000000000f0', 'c1401000-0000-0000-0000-0000000000a8', 'Call back', now(), 'R1401-L6');

create temp table r1401_seen (who text, n int, ids text);
grant all on r1401_seen to authenticated;

create or replace function pg_temp.r1401_look(p_who text, p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  insert into r1401_seen
  select p_who,
    (select count(*) from public.leads where id like 'R1401-L%'),
    (select coalesce(string_agg(right(id, 1), '' order by id), '') from public.leads where id like 'R1401-L%');
end $$;
grant execute on function pg_temp.r1401_look(text, uuid) to authenticated;

set local role authenticated;

select pg_temp.r1401_look('owner',    'c1401000-0000-0000-0000-0000000000a1');
select pg_temp.r1401_look('manager',  'c1401000-0000-0000-0000-0000000000a2');
select pg_temp.r1401_look('acct',     'c1401000-0000-0000-0000-0000000000a3');
select pg_temp.r1401_look('salesA',   'c1401000-0000-0000-0000-0000000000a5');
select pg_temp.r1401_look('salesB',   'c1401000-0000-0000-0000-0000000000a6');
select pg_temp.r1401_look('support',  'c1401000-0000-0000-0000-0000000000a7');
select pg_temp.r1401_look('delivery', 'c1401000-0000-0000-0000-0000000000a8');
select pg_temp.r1401_look('partner',  'c1401000-0000-0000-0000-0000000000a9');
select pg_temp.r1401_look('other',    'c1401000-0000-0000-0000-0000000000b1');

do $$
declare r record;
begin
  -- 1. owner / accountant all; manager: unowned + own team
  for r in select * from r1401_seen where who in ('owner', 'acct') loop
    if r.ids <> '12345678' then
      raise exception 'FAIL 1: % sees leads % (expected 1-8)', r.who, r.ids;
    end if;
  end loop;
  select * into r from r1401_seen where who = 'manager';
  if r.ids <> '1256' then
    raise exception 'FAIL 1: manager sees leads % (expected 1,2,5,6 — unowned + sales A''s)', r.ids;
  end if;
  raise notice 'PASS 1: owner/accountant read all, manager reads unowned + own team';

  -- 2. sales (hierarchy rule unchanged)
  select * into r from r1401_seen where who = 'salesA';
  if r.ids <> '1256' then
    raise exception 'FAIL 2: sales A sees leads % (expected 1,2,5,6)', r.ids;
  end if;
  select * into r from r1401_seen where who = 'salesB';
  if r.ids <> '13568' then
    raise exception 'FAIL 2: sales B sees leads % (expected 1,3,5,6,8)', r.ids;
  end if;
  raise notice 'PASS 2: sales read unowned + own + reports'' leads only';

  -- 3. support
  select * into r from r1401_seen where who = 'support';
  if r.ids <> '45' then
    raise exception 'FAIL 3: support sees leads % (expected only 4 = own, 5 = linked customer)', r.ids;
  end if;
  raise notice 'PASS 3: support reads only its own lead + its linked customer''s lead';

  -- 4. delivery
  select * into r from r1401_seen where who = 'delivery';
  if r.ids <> '6' then
    raise exception 'FAIL 4: delivery sees leads % (expected only 6 = its task)', r.ids;
  end if;
  raise notice 'PASS 4: delivery reads only the lead on its task';

  -- 5. partner_agent, 6. other company
  select * into r from r1401_seen where who = 'partner';
  if r.ids <> '78' then
    raise exception 'FAIL 5: partner_agent sees leads % (expected only 7 = own, 8 = created)', r.ids;
  end if;
  select * into r from r1401_seen where who = 'other';
  if r.ids <> '9' then
    raise exception 'FAIL 6: another company sees leads % (expected only its own 9)', r.ids;
  end if;
  raise notice 'PASS 5/6: partner_agent reads own/created only; another company only its own lead';
end $$;

-- 7. No blind writes; the author reads back what it added
do $$
declare v_n int; v_id text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1401000-0000-0000-0000-0000000000a7', 'role', 'authenticated')::text, true);
  update public.leads set notes = 'blind' where id = 'R1401-L1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 7: support updated an unreadable lead by id'; end if;

  insert into public.leads (id, tenant_id, company)
    values ('R1401-L-NEW', 'c1401000-0000-0000-0000-0000000000f0', 'R1401 By Support')
    returning id into v_id;
  if v_id is null then raise exception 'FAIL 7: support could not read back the lead it added'; end if;
  select count(*) into v_n from public.leads where id = 'R1401-L-NEW';
  if v_n <> 1 then raise exception 'FAIL 7: lead added by support is not readable by support'; end if;
  raise notice 'PASS 7: no blind update; author reads back its own new lead';
end $$;

rollback;
