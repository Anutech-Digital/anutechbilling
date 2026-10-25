-- R-1893 — a customer's mobile has ONE home: the primary contact's phone
-- (migration 20261025015700_r1893_primary_contact_phone).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1893_primary_contact_phone.test.sql
--
-- The owner's case (25 Oct, staging): company "Anil Tayal" had a mobile typed in the customer
-- form (customers.contact_mobile), but the profile header and the Contacts card read the
-- primary contact's phone (contacts.phone), which was blank — so no phone showed anywhere.
--
-- What it proves:
--   1. Backfill: a primary contact with a BLANK phone gets the customer record's mobile.
--   2. Backfill never overwrites: a primary contact that already has a phone keeps it.
--   3. Saving a new mobile on the customer (as the signed-in owner) updates the primary
--      contact's phone — the form and the profile never show two different numbers.
--   4. A save that does not change the phone / mobile leaves the contact's phone alone;
--      a NON-primary contact is never touched.
--   5. Clearing the mobile does not wipe the contact's phone.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1893000-0000-0000-0000-0000000000a1'::uuid, 'T-R1893 A', 'r1893-a@example.in', '07', 'TRD');
insert into auth.users (id, email) values ('c1893000-0000-0000-0000-00000000a0a1', 'r1893-owner-a@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1893000-0000-0000-0000-00000000a0a1', 'c1893000-0000-0000-0000-0000000000a1', 'r1893-owner-a@example.in', 'owner', 'Owner A');

-- X: the owner's case — mobile on the record, primary contact without a phone.
-- Y: the primary contact already has its own phone; the record has a different one.
insert into public.customers (id, tenant_id, name, contact_name, contact_email, contact_mobile, contact_phone) values
  ('c1893000-0000-0000-0000-0000000c0001', 'c1893000-0000-0000-0000-0000000000a1', 'T-Anil Tayal Co', 'Anil Tayal', 'office2@example.in', '9876543210', null),
  ('c1893000-0000-0000-0000-0000000c0002', 'c1893000-0000-0000-0000-0000000000a1', 'T-Bharat Tiles', 'Ravi K', 'ravi@example.in', '9111111111', '01140000000');
insert into public.contacts (id, tenant_id, full_name, email, phone, source, status) values
  ('r1893-px', 'c1893000-0000-0000-0000-0000000000a1', 'Anil Tayal', 'office2@example.in', null, 'manual', 'engaged'),
  ('r1893-sx', 'c1893000-0000-0000-0000-0000000000a1', 'Second Person', 'second@example.in', '9333333333', 'manual', 'engaged'),
  ('r1893-py', 'c1893000-0000-0000-0000-0000000000a1', 'Ravi K', 'ravi@example.in', '9000000001', 'manual', 'engaged');
insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary) values
  ('c1893000-0000-0000-0000-0000000000a1', 'c1893000-0000-0000-0000-0000000c0001', 'r1893-px', 'poc', true),
  ('c1893000-0000-0000-0000-0000000000a1', 'c1893000-0000-0000-0000-0000000c0001', 'r1893-sx', 'accountant', false),
  ('c1893000-0000-0000-0000-0000000000a1', 'c1893000-0000-0000-0000-0000000c0002', 'r1893-py', 'poc', true);

-- ── 1 + 2. Backfill fills only the blank phone ───────────────────────────────────────────
do $$
declare n int; px text; py text; sx text;
begin
  n := public.r1893_backfill_primary_contact_phones();
  select phone into px from public.contacts where id = 'r1893-px';
  select phone into py from public.contacts where id = 'r1893-py';
  select phone into sx from public.contacts where id = 'r1893-sx';
  if px is distinct from '9876543210' then
    raise exception 'FAIL 1: blank primary-contact phone not filled from the record mobile (got %)', px;
  end if;
  if py is distinct from '9000000001' then
    raise exception 'FAIL 2: backfill overwrote an existing contact phone (got %)', py;
  end if;
  if sx is distinct from '9333333333' then
    raise exception 'FAIL 2: backfill touched a non-primary contact (got %)', sx;
  end if;
  raise notice 'PASS 1: blank primary-contact phone filled from the customer mobile (9876543210)';
  raise notice 'PASS 2: an existing contact phone (9000000001) is never overwritten';
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c1893000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

-- ── 3. Saving a new mobile updates the primary contact ───────────────────────────────────
update public.customers set contact_mobile = '9222222222'
 where id = 'c1893000-0000-0000-0000-0000000c0001';
do $$
declare px text; sx text;
begin
  select phone into px from public.contacts where id = 'r1893-px';
  select phone into sx from public.contacts where id = 'r1893-sx';
  if px is distinct from '9222222222' then
    raise exception 'FAIL 3: new customer mobile did not reach the primary contact (got %)', px;
  end if;
  if sx is distinct from '9333333333' then
    raise exception 'FAIL 4: a non-primary contact was changed (got %)', sx;
  end if;
  raise notice 'PASS 3: saving mobile 9222222222 on the customer updates the primary contact';
end $$;

-- ── 4. A save that does not change phone / mobile leaves the contact alone ──────────────
update public.customers set name = 'T-Bharat Tiles Pvt Ltd', contact_mobile = '9111111111'
 where id = 'c1893000-0000-0000-0000-0000000c0002';
do $$
declare py text;
begin
  select phone into py from public.contacts where id = 'r1893-py';
  if py is distinct from '9000000001' then
    raise exception 'FAIL 4: a save without a phone change rewrote the contact phone (got %)', py;
  end if;
  raise notice 'PASS 4: a save without a phone change keeps the contact phone; non-primary untouched';
end $$;

-- ── 5. Clearing the mobile does not wipe the contact's phone ─────────────────────────────
update public.customers set contact_mobile = null
 where id = 'c1893000-0000-0000-0000-0000000c0001';
do $$
declare px text;
begin
  select phone into px from public.contacts where id = 'r1893-px';
  if px is distinct from '9222222222' then
    raise exception 'FAIL 5: clearing the record mobile changed the contact phone (got %)', px;
  end if;
  raise notice 'PASS 5: clearing the record mobile keeps the contact phone';
end $$;

rollback;
