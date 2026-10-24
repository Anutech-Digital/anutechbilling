-- R-1643: a company with no GSTIN / address of its own cannot issue a GST Tax Invoice.
-- Migration 20261023192418_r1643_tax_invoice_needs_supplier_gstin. Asserts the LIVE functions.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1643_tax_invoice_needs_gstin.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <migration> <this test> rollback;
-- Expect "PASS r1643". Without the migration the same test FAILs at step 1 (mutation check).
--
-- Proves:
--   1. NEW COMPANY (no GSTIN, no address, registration never chosen) — generate_invoice is
--      refused with the Settings → Company message (23514), the quote stays un-invoiced and
--      NO invoice number is spent; create_direct_invoice is refused too, and spends no quote
--      number either.
--   2. GSTIN BUT NO ADDRESS — refused, the message names the address.
--   3. COMPOSITION without an address — refused (Bill of Supply of a registered dealer).
--   4. NOT REGISTERED with an address — a 0% quote still gives a Bill of Supply (R-1529).
--   5. NOT REGISTERED without an address — refused, the address message.
--   6. REGISTERED with GSTIN + address — unchanged: INV-…, tax_invoice.
--   7. The new company adds its GSTIN + address → its FIRST invoice is INV-…-0001 (the refused
--      calls burnt nothing).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1643000-0000-4000-8000-00000000000a', 'r1643-owner-n@example.test'),
  ('e1643000-0000-4000-8000-00000000000b', 'r1643-owner-g@example.test'),
  ('e1643000-0000-4000-8000-00000000000c', 'r1643-owner-c@example.test'),
  ('e1643000-0000-4000-8000-00000000000d', 'r1643-owner-u@example.test'),
  ('e1643000-0000-4000-8000-00000000000e', 'r1643-owner-v@example.test'),
  ('e1643000-0000-4000-8000-00000000000f', 'r1643-owner-r@example.test');

-- N new (nothing) · G GSTIN no address · C composition no address · U unregistered + address
-- V unregistered no address · R registered, complete
insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration) values
  ('e1643000-0000-0000-0000-0000000000a1', 'R1643 N New',    'r1643n@example.in', '07', 'Delhi', null,              'R43N', null,              null),
  ('e1643000-0000-0000-0000-0000000000b1', 'R1643 G NoAddr', 'r1643g@example.in', '07', 'Delhi', '   ',             'R43G', '07AAACR1643G1Z1', 'registered'),
  ('e1643000-0000-0000-0000-0000000000c1', 'R1643 C Comp',   'r1643c@example.in', '07', 'Delhi', null,              'R43C', '07AAACR1643C1Z1', 'composition'),
  ('e1643000-0000-0000-0000-0000000000d1', 'R1643 U Unreg',  'r1643u@example.in', '07', 'Delhi', 'U street, Delhi', 'R43U', null,              'unregistered'),
  ('e1643000-0000-0000-0000-0000000000e1', 'R1643 V Unreg',  'r1643v@example.in', '07', 'Delhi', '',                'R43V', null,              'unregistered'),
  ('e1643000-0000-0000-0000-0000000000f1', 'R1643 R Reg',    'r1643r@example.in', '07', 'Delhi', 'R street, Delhi', 'R43R', '07AAACR1643R1Z1', 'registered');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1643000-0000-4000-8000-00000000000a', 'e1643000-0000-0000-0000-0000000000a1', 'r1643-owner-n@example.in', 'R1643 Owner N', 'owner', true),
  ('e1643000-0000-4000-8000-00000000000b', 'e1643000-0000-0000-0000-0000000000b1', 'r1643-owner-g@example.in', 'R1643 Owner G', 'owner', true),
  ('e1643000-0000-4000-8000-00000000000c', 'e1643000-0000-0000-0000-0000000000c1', 'r1643-owner-c@example.in', 'R1643 Owner C', 'owner', true),
  ('e1643000-0000-4000-8000-00000000000d', 'e1643000-0000-0000-0000-0000000000d1', 'r1643-owner-u@example.in', 'R1643 Owner U', 'owner', true),
  ('e1643000-0000-4000-8000-00000000000e', 'e1643000-0000-0000-0000-0000000000e1', 'r1643-owner-v@example.in', 'R1643 Owner V', 'owner', true),
  ('e1643000-0000-4000-8000-00000000000f', 'e1643000-0000-0000-0000-0000000000f1', 'r1643-owner-r@example.in', 'R1643 Owner R', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1643000-0000-4000-8000-0000000000ca', 'e1643000-0000-0000-0000-0000000000a1', 'R1643 Cust N', '07', 'India'),
  ('e1643000-0000-4000-8000-0000000000cb', 'e1643000-0000-0000-0000-0000000000b1', 'R1643 Cust G', '07', 'India'),
  ('e1643000-0000-4000-8000-0000000000cc', 'e1643000-0000-0000-0000-0000000000c1', 'R1643 Cust C', '07', 'India'),
  ('e1643000-0000-4000-8000-0000000000cd', 'e1643000-0000-0000-0000-0000000000d1', 'R1643 Cust U', '07', 'India'),
  ('e1643000-0000-4000-8000-0000000000ce', 'e1643000-0000-0000-0000-0000000000e1', 'R1643 Cust V', '07', 'India'),
  ('e1643000-0000-4000-8000-0000000000cf', 'e1643000-0000-0000-0000-0000000000f1', 'R1643 Cust R', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1643-N', 'e1643000-0000-0000-0000-0000000000a1', 'e1643000-0000-4000-8000-0000000000ca', 'R1643 Cust N', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1643-G', 'e1643000-0000-0000-0000-0000000000b1', 'e1643000-0000-4000-8000-0000000000cb', 'R1643 Cust G', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1643-C', 'e1643000-0000-0000-0000-0000000000c1', 'e1643000-0000-4000-8000-0000000000cc', 'R1643 Cust C', 5000, 5000, 0,  'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1643-U', 'e1643000-0000-0000-0000-0000000000d1', 'e1643000-0000-4000-8000-0000000000cd', 'R1643 Cust U', 1000, 1000, 0,  'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1643-V', 'e1643000-0000-0000-0000-0000000000e1', 'e1643000-0000-4000-8000-0000000000ce', 'R1643 Cust V', 1000, 1000, 0,  'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1643-R', 'e1643000-0000-0000-0000-0000000000f1', 'e1643000-0000-4000-8000-0000000000cf', 'R1643 Cust R', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb);

create function pg_temp.r1643_as(p_user text) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_user)::text, true);
$f$;
grant execute on function pg_temp.r1643_as(text) to authenticated;

create function pg_temp.r1643_expect(label text, call text, msg text) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = '23514' and v_msg like '%' || msg || '%' then
      raise notice 'ok   %: refused (%)', label, left(v_msg, 110);
      return;
    end if;
    raise exception 'FAIL %: expected 23514 "%", got % (%)', label, msg, v_state, v_msg;
  end;
  raise exception 'FAIL %: expected a refusal, the call succeeded', label;
end $f$;
grant execute on function pg_temp.r1643_expect(text, text, text) to authenticated;

create temp table r1643_inv (who text, id text);
grant all on r1643_inv to authenticated;

set local role authenticated;

-- ── 1. New company ──────────────────────────────────────────────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000a');
select pg_temp.r1643_expect('1 new company generate_invoice',
  $$select * from public.generate_invoice('Q-R1643-N')$$,
  'Add your company''s GSTIN and address in Settings → Company first');
select pg_temp.r1643_expect('1 message names both',
  $$select * from public.generate_invoice('Q-R1643-N')$$, 'GSTIN and address are not on record');
select pg_temp.r1643_expect('1 new company create_direct_invoice',
  $$select * from public.create_direct_invoice('e1643000-0000-4000-8000-0000000000ca', '[{"name":"Setup","qty":1,"rate":2500}]'::jsonb)$$,
  'Add your company''s GSTIN and address in Settings → Company first');

-- ── 2. GSTIN, no address ────────────────────────────────────────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000b');
select pg_temp.r1643_expect('2 GSTIN no address',
  $$select * from public.generate_invoice('Q-R1643-G')$$, 'your company''s address is not on record');

-- ── 3. Composition, no address ──────────────────────────────────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000c');
select pg_temp.r1643_expect('3 composition no address',
  $$select * from public.generate_invoice('Q-R1643-C')$$, 'Cannot issue a Bill of Supply: your company''s address is not on record. A composition dealer');

-- ── 4. Not registered, address on record → Bill of Supply ───────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000d');
insert into r1643_inv select 'U', gi.invoice_id from public.generate_invoice('Q-R1643-U') gi;

-- ── 5. Not registered, no address ───────────────────────────────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000e');
select pg_temp.r1643_expect('5 unregistered no address',
  $$select * from public.generate_invoice('Q-R1643-V')$$, 'Add your company''s address in Settings → Company first');

-- ── 6. Registered, complete ─────────────────────────────────────────────────────────
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000f');
insert into r1643_inv select 'R', gi.invoice_id from public.generate_invoice('Q-R1643-R') gi;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record;
begin
  -- 1: nothing saved, no number spent (no INV / quote counter moved for N)
  if (select invoice_id from public.quotes where id = 'Q-R1643-N') is not null then
    raise exception 'FAIL 1: the quote got invoiced'; end if;
  if exists (select 1 from public.invoices where tenant_id = 'e1643000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 1: an invoice row exists for the new company'; end if;
  if exists (select 1 from public.document_series where tenant_id = 'e1643000-0000-0000-0000-0000000000a1' and last_number > 0) then
    raise exception 'FAIL 1: a number was spent for the new company'; end if;
  if (select count(*) from public.quotes where tenant_id = 'e1643000-0000-0000-0000-0000000000a1') <> 1 then
    raise exception 'FAIL 1: create_direct_invoice left a quote behind'; end if;
  -- 2/3/5: nothing issued
  if exists (select 1 from public.invoices where tenant_id in ('e1643000-0000-0000-0000-0000000000b1',
             'e1643000-0000-0000-0000-0000000000c1', 'e1643000-0000-0000-0000-0000000000e1')) then
    raise exception 'FAIL 2/3/5: an invoice was issued'; end if;
  -- 4
  select i.* into r from public.invoices i join r1643_inv x on x.id = i.id and x.who = 'U';
  if r.id !~ '^BOS-R43U-' or r.document_kind <> 'bill_of_supply' then
    raise exception 'FAIL 4: unregistered gave % (%)', r.id, r.document_kind; end if;
  -- 6
  select i.* into r from public.invoices i join r1643_inv x on x.id = i.id and x.who = 'R';
  if r.id !~ '^INV-R43R-[0-9]{2}-0001$' or r.document_kind <> 'tax_invoice' or r.tax_amount <> 180 then
    raise exception 'FAIL 6: registered gave % (%) tax %', r.id, r.document_kind, r.tax_amount; end if;
  raise notice 'PASS 1-6: refused without GSTIN/address, nothing saved, no number spent; BOS + INV unchanged';
end $$;

-- ── 7. The new company fills Settings → Company, then issues its first invoice ─────────
update public.tenants set gstin = '07AAACR1643N1Z1', address = 'N street, Delhi'
 where id = 'e1643000-0000-0000-0000-0000000000a1';

set local role authenticated;
select pg_temp.r1643_as('e1643000-0000-4000-8000-00000000000a');
insert into r1643_inv select 'N', gi.invoice_id from public.generate_invoice('Q-R1643-N') gi;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_id text;
begin
  select id into v_id from r1643_inv where who = 'N';
  if v_id !~ '^INV-R43N-[0-9]{2}-0001$' then
    raise exception 'FAIL 7: first invoice after the fix is % (a refused call burnt a number?)', v_id; end if;
  raise notice 'PASS 7: first invoice after Settings → Company is %', v_id;
  raise notice 'PASS r1643';
end $$;

rollback;
