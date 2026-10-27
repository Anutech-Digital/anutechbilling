-- R-1894 — "Add contact" on a company profile must link the person to the company
-- (migration 20261025044600_r1894_add_customer_contact).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1894_add_contact_link.test.sql
--
-- The owner's case (25 Oct, localhost, R-1893 check): company profile → Contacts → Add contact
-- → "R1893 Test Person" → Save contact. A contacts row was written (customer_id = the company)
-- but no customer_contacts link, so the profile still said "No contact person yet".
--
-- What it proves:
--   1. add_customer_contact (as the signed-in owner) creates the person AND the link; the
--      customer's first person is the primary.
--   2. A second person is linked, not primary; the primary stays.
--   3. The same person (same email, or same phone in another format) is linked, not duplicated,
--      and their saved details are not overwritten.
--   4. Adding someone already linked writes nothing new.
--   5. Another company's customer is refused; a signed-in user with no company is refused.
--   6. Backfill: an orphan contact (customer_id set, no link) gets its link; the first orphan of
--      a customer with no primary becomes primary; an existing primary and an existing link are
--      never changed.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1894000-0000-0000-0000-0000000000a1'::uuid, 'T-R1894 A', 'r1894-a@example.in', '07', 'TRE'),
  ('c1894000-0000-0000-0000-0000000000b1'::uuid, 'T-R1894 B', 'r1894-b@example.in', '07', 'TRF');
insert into auth.users (id, email) values
  ('c1894000-0000-0000-0000-00000000a0a1', 'r1894-owner-a@example.test'),
  ('c1894000-0000-0000-0000-00000000f0f1', 'r1894-nobody@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1894000-0000-0000-0000-00000000a0a1', 'c1894000-0000-0000-0000-0000000000a1', 'r1894-owner-a@example.in', 'owner', 'Owner A');

insert into public.customers (id, tenant_id, name, contact_name, contact_mobile) values
  -- X: the owner's case — no contact person yet.
  ('c1894000-0000-0000-0000-0000000c0001', 'c1894000-0000-0000-0000-0000000000a1', 'T-R1762 Test Deal', 'T-R1762 Test Deal', '98765 18930'),
  -- Y: another customer of A, already served by "Sunita".
  ('c1894000-0000-0000-0000-0000000c0002', 'c1894000-0000-0000-0000-0000000000a1', 'T-Bharat Tiles', null, null),
  -- Z: company B's customer.
  ('c1894000-0000-0000-0000-0000000c0003', 'c1894000-0000-0000-0000-0000000000b1', 'T-Other Co', null, null),
  -- O1/O2/O3: backfill cases.
  ('c1894000-0000-0000-0000-0000000c0011', 'c1894000-0000-0000-0000-0000000000a1', 'T-Orphan One', null, null),
  ('c1894000-0000-0000-0000-0000000c0012', 'c1894000-0000-0000-0000-0000000000a1', 'T-Orphan Two', null, null);

insert into public.contacts (id, tenant_id, full_name, email, phone, title, source, status) values
  ('r1894-sunita', 'c1894000-0000-0000-0000-0000000000a1', 'Sunita M', 'sunita@example.in', '+91 91111 22222', 'Accounts', 'manual', 'engaged');
insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary) values
  ('c1894000-0000-0000-0000-0000000000a1', 'c1894000-0000-0000-0000-0000000c0002', 'r1894-sunita', 'accountant', true);

-- ── 1–5 as the signed-in owner of company A ─────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1894000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

do $$
declare r jsonb; r2 jsonb; r3 jsonb; r4 jsonb; n int; p boolean; ph text; ttl text;
begin
  -- 1. The owner's path: first person on X → created, linked, primary.
  r := public.add_customer_contact('c1894000-0000-0000-0000-0000000c0001', 'R1893 Test Person', null, '98765 18930', null, 'poc');
  if (r->>'existing')::boolean then raise exception 'FAIL 1: a new person was reported as existing: %', r; end if;
  select cc.is_primary into p from public.customer_contacts cc
   where cc.customer_id = 'c1894000-0000-0000-0000-0000000c0001' and cc.contact_id = r->>'contact_id';
  if p is null then raise exception 'FAIL 1: Add contact saved the person without linking them to the company'; end if;
  if not p then raise exception 'FAIL 1: the company''s first contact is not primary'; end if;

  -- 2. A second person on X → linked, not primary; the first stays primary.
  r2 := public.add_customer_contact('c1894000-0000-0000-0000-0000000c0001', 'Second Person', 'second@example.in', null, 'IT', 'it_head');
  select cc.is_primary into p from public.customer_contacts cc
   where cc.customer_id = 'c1894000-0000-0000-0000-0000000c0001' and cc.contact_id = r2->>'contact_id';
  if p is distinct from false then raise exception 'FAIL 2: the second contact took the primary (%)', p; end if;
  select count(*) into n from public.customer_contacts
   where customer_id = 'c1894000-0000-0000-0000-0000000c0001' and is_primary and contact_id = r->>'contact_id';
  if n <> 1 then raise exception 'FAIL 2: the first contact lost the primary'; end if;

  -- 3. Sunita (on Y) added to X by email, typed with different case → linked, not duplicated,
  --    her title not overwritten.
  r3 := public.add_customer_contact('c1894000-0000-0000-0000-0000000c0001', 'Sunita Mehra', 'SUNITA@example.in', null, 'Owner', 'owner');
  if r3->>'contact_id' <> 'r1894-sunita' or not (r3->>'existing')::boolean then
    raise exception 'FAIL 3: the same email made a new person: %', r3;
  end if;
  select title, full_name into ttl, ph from public.contacts where id = 'r1894-sunita';
  if ttl is distinct from 'Accounts' or ph is distinct from 'Sunita M' then
    raise exception 'FAIL 3: an existing person''s details were overwritten (%, %)', ph, ttl;
  end if;
  select count(*) into n from public.contacts where tenant_id = 'c1894000-0000-0000-0000-0000000000a1' and lower(full_name) like 'sunita%';
  if n <> 1 then raise exception 'FAIL 3: Sunita duplicated (% rows)', n; end if;
  -- … and by phone in another format.
  r4 := public.add_customer_contact('c1894000-0000-0000-0000-0000000c0002', 'Test Person again', null, '9876518930', null, 'poc');
  if r4->>'contact_id' <> r->>'contact_id' then
    raise exception 'FAIL 3: the same phone made a new person: %', r4;
  end if;
  select is_primary into p from public.customer_contacts
   where customer_id = 'c1894000-0000-0000-0000-0000000c0002' and contact_id = r->>'contact_id';
  if p is distinct from false then raise exception 'FAIL 3: a phone match took Y''s primary from Sunita'; end if;

  -- 4. Already linked → nothing new.
  r4 := public.add_customer_contact('c1894000-0000-0000-0000-0000000c0001', 'Sunita', 'sunita@example.in', null, null, 'poc');
  if not (r4->>'already_linked')::boolean then raise exception 'FAIL 4: re-adding a linked person not reported: %', r4; end if;
  select count(*) into n from public.customer_contacts where customer_id = 'c1894000-0000-0000-0000-0000000c0001';
  if n <> 3 then raise exception 'FAIL 4: expected 3 links on X, got %', n; end if;

  -- 5a. Company B's customer is refused.
  begin
    perform public.add_customer_contact('c1894000-0000-0000-0000-0000000c0003', 'Intruder', null, null, null, 'poc');
    raise exception 'FAIL 5a: added a contact to another company''s customer';
  exception when others then
    if sqlerrm not like '%customer not found%' then raise; end if;
  end;
end $$;

-- 5b. A signed-in user with no company is refused (fail closed).
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1894000-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform public.add_customer_contact('c1894000-0000-0000-0000-0000000c0001', 'Nobody', null, null, null, 'poc');
    raise exception 'FAIL 5b: a user with no company added a contact';
  exception when others then
    if sqlerrm not like '%sign in to a company%' then raise; end if;
  end;
end $$;

reset role;

-- ── 6. Backfill of orphan contacts ──────────────────────────────────────────────────────
-- O1: two orphans, no link at all → the older becomes primary, the other linked non-primary.
-- O2: already has a primary (Sunita) → orphan linked, NOT primary; Sunita stays primary.
insert into public.contacts (id, tenant_id, full_name, customer_id, role, is_primary, source, status, created_at) values
  ('r1894-o1a', 'c1894000-0000-0000-0000-0000000000a1', 'Orphan One A', 'c1894000-0000-0000-0000-0000000c0011', 'poc', true,  'manual', 'engaged', now() - interval '2 days'),
  ('r1894-o1b', 'c1894000-0000-0000-0000-0000000000a1', 'Orphan One B', 'c1894000-0000-0000-0000-0000000c0011', 'accountant', false, 'manual', 'engaged', now() - interval '1 day'),
  ('r1894-o2',  'c1894000-0000-0000-0000-0000000000a1', 'Orphan Two',   'c1894000-0000-0000-0000-0000000c0012', null, false, 'manual', 'engaged', now());
insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary) values
  ('c1894000-0000-0000-0000-0000000000a1', 'c1894000-0000-0000-0000-0000000c0012', 'r1894-sunita', 'accountant', true);

do $$
declare n int; p1 boolean; p2 boolean; p3 boolean; ps boolean; rl text;
begin
  n := public.r1894_link_orphan_contacts();
  select is_primary into p1 from public.customer_contacts where customer_id = 'c1894000-0000-0000-0000-0000000c0011' and contact_id = 'r1894-o1a';
  select is_primary, role into p2, rl from public.customer_contacts where customer_id = 'c1894000-0000-0000-0000-0000000c0011' and contact_id = 'r1894-o1b';
  select is_primary into p3 from public.customer_contacts where customer_id = 'c1894000-0000-0000-0000-0000000c0012' and contact_id = 'r1894-o2';
  select is_primary into ps from public.customer_contacts where customer_id = 'c1894000-0000-0000-0000-0000000c0012' and contact_id = 'r1894-sunita';
  if p1 is distinct from true  then raise exception 'FAIL 6: the first orphan was not linked as primary (%)', p1; end if;
  if p2 is distinct from false then raise exception 'FAIL 6: the second orphan was not linked as non-primary (%)', p2; end if;
  if rl is distinct from 'accountant' then raise exception 'FAIL 6: the orphan''s role was lost (%)', rl; end if;
  if p3 is distinct from false then raise exception 'FAIL 6: an orphan took an existing primary (%)', p3; end if;
  if ps is distinct from true  then raise exception 'FAIL 6: the existing primary was changed'; end if;
  -- Running it again changes nothing.
  n := public.r1894_link_orphan_contacts();
  if exists (select 1 from public.contacts p
              where p.tenant_id = 'c1894000-0000-0000-0000-0000000000a1' and p.customer_id is not null
                and not exists (select 1 from public.customer_contacts cc where cc.customer_id = p.customer_id and cc.contact_id = p.id)) then
    raise exception 'FAIL 6: an orphan contact is still unlinked';
  end if;
  raise notice 'R-1894 add_customer_contact + orphan backfill: all checks passed';
end $$;

rollback;
