-- R-1529: Bill of Supply for a business that is not GST-registered / is under composition.
-- Migration 20261018022629_r1529_bill_of_supply. Asserts the LIVE functions.
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/bill_of_supply.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <migration> <this test> rollback;
-- Expect "PASS bill_of_supply".
--
-- Proves:
--   1. UNREGISTERED — a 0% quote → generate_invoice issues BOS-…, document_kind
--      bill_of_supply, no GST, supplier_gst_status 'unregistered'; the BOS counter moved and
--      the INV counter did not.
--   2. NO GST ON A BOS — an 18% quote of the same business is refused with the §24 message
--      and burns no number (neither BOS nor INV).
--   3. DIRECT INVOICE — create_direct_invoice for that business charges 0% and gives BOS.
--   4. REGISTERED — unchanged: INV-…, tax_invoice, CGST+SGST tax kept; its BOS counter untouched.
--   5. COMPOSITION — 0% quote → BOS, supplier_gst_status 'composition'.
--   6. TENANT GUARD — no-company login 28000, other company 42501 on next_document_number
--      ('bill_of_supply').
--   7. FROZEN — document_kind / supplier_gst_status cannot change; a BOS cannot gain GST.
--   8. SERIES MATCH — a BOS number on a registered business, or an INV number on an
--      unregistered one, is refused at insert.
--   9. EFFECTIVE DATE — registered from a future date → still a Bill of Supply today (q4).
--  10. q1 — an 'unregistered' business cannot hold a GSTIN.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1529000-0000-4000-8000-00000000000a', 'r1529-owner-a@example.test'),
  ('e1529000-0000-4000-8000-00000000000b', 'r1529-owner-b@example.test'),
  ('e1529000-0000-4000-8000-00000000000c', 'r1529-owner-c@example.test'),
  ('e1529000-0000-4000-8000-00000000000f', 'r1529-nocompany@example.test');

-- A unregistered (no GSTIN) · B registered · C composition · D registered from a future date
insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, gst_registered_from) values
  ('e1529000-0000-0000-0000-0000000000a1', 'R1529 A Unreg', 'r1529a@example.in', '07', 'Delhi', 'A street, Delhi', 'R29A', null, 'unregistered', null),
  ('e1529000-0000-0000-0000-0000000000b1', 'R1529 B Reg',   'r1529b@example.in', '07', 'Delhi', 'B street, Delhi', 'R29B', '07AAACR1529B1Z1', 'registered', null),
  ('e1529000-0000-0000-0000-0000000000c1', 'R1529 C Comp',  'r1529c@example.in', '07', 'Delhi', 'C street, Delhi', 'R29C', '07AAACR1529C1Z1', 'composition', null),
  ('e1529000-0000-0000-0000-0000000000d1', 'R1529 D Later', 'r1529d@example.in', '07', 'Delhi', 'D street, Delhi', 'R29D', '07AAACR1529D1Z1', 'registered', public.ist_today() + 10);

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1529000-0000-4000-8000-00000000000a', 'e1529000-0000-0000-0000-0000000000a1', 'r1529-owner-a@example.in', 'R1529 Owner A', 'owner', true),
  ('e1529000-0000-4000-8000-00000000000b', 'e1529000-0000-0000-0000-0000000000b1', 'r1529-owner-b@example.in', 'R1529 Owner B', 'owner', true),
  ('e1529000-0000-4000-8000-00000000000c', 'e1529000-0000-0000-0000-0000000000c1', 'r1529-owner-c@example.in', 'R1529 Owner C', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1529000-0000-4000-8000-0000000000ca', 'e1529000-0000-0000-0000-0000000000a1', 'R1529 Cust A', '07', 'India'),
  ('e1529000-0000-4000-8000-0000000000cb', 'e1529000-0000-0000-0000-0000000000b1', 'R1529 Cust B', '07', 'India'),
  ('e1529000-0000-4000-8000-0000000000cc', 'e1529000-0000-0000-0000-0000000000c1', 'R1529 Cust C', '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1529-A0',  'e1529000-0000-0000-0000-0000000000a1', 'e1529000-0000-4000-8000-0000000000ca', 'R1529 Cust A', 1000, 1000, 0,  'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1529-A18', 'e1529000-0000-0000-0000-0000000000a1', 'e1529000-0000-4000-8000-0000000000ca', 'R1529 Cust A', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1529-B18', 'e1529000-0000-0000-0000-0000000000b1', 'e1529000-0000-4000-8000-0000000000cb', 'R1529 Cust B', 1180, 1000, 18, 'accepted', 'awaiting', '[]'::jsonb),
  ('Q-R1529-C0',  'e1529000-0000-0000-0000-0000000000c1', 'e1529000-0000-4000-8000-0000000000cc', 'R1529 Cust C', 5000, 5000, 0,  'accepted', 'awaiting', '[]'::jsonb);

create function pg_temp.r1529_expect(label text, call text, want text, msg text default null) returns void
language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute call;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if want = 'ok' then
      raise exception 'FAIL %: expected success, got % (%)', label, v_state, v_msg;
    elsif (want = 'any' or v_state = want) and (msg is null or v_msg like '%' || msg || '%') then
      raise notice 'ok   %: refused % (%)', label, v_state, left(v_msg, 90);
      return;
    else
      raise exception 'FAIL %: expected % "%", got % (%)', label, want, coalesce(msg, ''), v_state, v_msg;
    end if;
  end;
  if want <> 'ok' then
    raise exception 'FAIL %: expected %, call succeeded', label, want;
  end if;
  raise notice 'ok   %: succeeded', label;
end $f$;
grant execute on function pg_temp.r1529_expect(text, text, text, text) to authenticated, service_role;

create temp table r1529_inv (who text, id text);
grant all on r1529_inv to authenticated;

-- ── 1–3. Unregistered A ──────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1529000-0000-4000-8000-00000000000a"}', true);
insert into r1529_inv select 'A0', gi.invoice_id from public.generate_invoice('Q-R1529-A0') gi;
select pg_temp.r1529_expect('A 18% quote', $$select * from public.generate_invoice('Q-R1529-A18')$$, '23514', 'Set the GST rate on the quote to 0%');
insert into r1529_inv select 'Adirect', d.invoice_id
  from public.create_direct_invoice('e1529000-0000-4000-8000-0000000000ca', '[{"description":"Setup","qty":1,"rate":2500}]'::jsonb) d;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record; v_bos int; v_inv int; v_d record;
begin
  select i.* into r from public.invoices i join r1529_inv x on x.id = i.id and x.who = 'A0';
  if r.id !~ '^BOS-R29A-[0-9]{2}-0001$' then raise exception 'FAIL 1: unregistered invoice id %', r.id; end if;
  if length(r.id) > 16 then raise exception 'FAIL 1: % longer than 16 (Rule 46(b)/49)', r.id; end if;
  if r.document_kind <> 'bill_of_supply' or r.supplier_gst_status <> 'unregistered' then
    raise exception 'FAIL 1: kind %, status %', r.document_kind, r.supplier_gst_status; end if;
  if r.tax_amount <> 0 or r.tax_rate <> 0 or r.taxable_value <> 1000 or r.amount <> 1000 then
    raise exception 'FAIL 1: money tax % rate % taxable % amount %', r.tax_amount, r.tax_rate, r.taxable_value, r.amount; end if;
  select last_number into v_bos from public.document_series where tenant_id = 'e1529000-0000-0000-0000-0000000000a1' and doc_type = 'bill_of_supply';
  select count(*) into v_inv from public.document_series where tenant_id = 'e1529000-0000-0000-0000-0000000000a1' and doc_type = 'invoice';
  -- 2 BOS: the 0% quote and the direct invoice. The refused 18% quote burnt none.
  if v_bos <> 2 then raise exception 'FAIL 2: BOS counter %, want 2 (refused call burnt a number?)', v_bos; end if;
  if v_inv <> 0 then raise exception 'FAIL 1: an INV series row exists for the unregistered business'; end if;
  if (select invoice_id from public.quotes where id = 'Q-R1529-A18') is not null then raise exception 'FAIL 2: 18%% quote got invoiced'; end if;
  select i.* into v_d from public.invoices i join r1529_inv x on x.id = i.id and x.who = 'Adirect';
  if v_d.id !~ '^BOS-R29A-[0-9]{2}-0002$' or v_d.tax_amount <> 0 or v_d.amount <> 2500 or v_d.document_kind <> 'bill_of_supply' then
    raise exception 'FAIL 3: direct invoice % tax % amount % kind %', v_d.id, v_d.tax_amount, v_d.amount, v_d.document_kind; end if;
  raise notice 'PASS 1-3 unregistered: BOS series, no GST, 18%% refused without burning a number, direct invoice 0%%';
end $$;

-- ── 4. Registered B (unchanged) ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1529000-0000-4000-8000-00000000000b"}', true);
insert into r1529_inv select 'B18', gi.invoice_id from public.generate_invoice('Q-R1529-B18') gi;
-- 6. other company on A's BOS series
select pg_temp.r1529_expect('other-company next_document_number(bill_of_supply)',
  $$select public.next_document_number('bill_of_supply', 'e1529000-0000-0000-0000-0000000000a1')$$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record;
begin
  select i.* into r from public.invoices i join r1529_inv x on x.id = i.id and x.who = 'B18';
  if r.id !~ '^INV-R29B-[0-9]{2}-0001$' or r.document_kind <> 'tax_invoice' or r.supplier_gst_status <> 'registered'
     or r.tax_amount <> 180 or r.tax_rate <> 18 then
    raise exception 'FAIL 4: registered invoice % kind % status % tax % rate %', r.id, r.document_kind, r.supplier_gst_status, r.tax_amount, r.tax_rate;
  end if;
  if exists(select 1 from public.document_series where tenant_id = 'e1529000-0000-0000-0000-0000000000b1' and doc_type = 'bill_of_supply') then
    raise exception 'FAIL 4: registered business got a BOS series row';
  end if;
  raise notice 'PASS 4 registered: INV series, tax invoice, GST kept';
end $$;

-- ── 5. Composition C ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1529000-0000-4000-8000-00000000000c"}', true);
insert into r1529_inv select 'C0', gi.invoice_id from public.generate_invoice('Q-R1529-C0') gi;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record;
begin
  select i.* into r from public.invoices i join r1529_inv x on x.id = i.id and x.who = 'C0';
  if r.id !~ '^BOS-R29C-' or r.document_kind <> 'bill_of_supply' or r.supplier_gst_status <> 'composition' or r.tax_amount <> 0 then
    raise exception 'FAIL 5: composition invoice % kind % status % tax %', r.id, r.document_kind, r.supplier_gst_status, r.tax_amount;
  end if;
  if (select gst_composition_rate from public.tenants where id = 'e1529000-0000-0000-0000-0000000000c1') <> 6 then
    raise exception 'FAIL 5: composition rate default is not 6';
  end if;
  raise notice 'PASS 5 composition: BOS, status composition, rate default 6';
end $$;

-- ── 6. No company ────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1529000-0000-4000-8000-00000000000f"}', true);
select pg_temp.r1529_expect('no-company next_document_number(bill_of_supply)',
  $$select public.next_document_number('bill_of_supply', 'e1529000-0000-0000-0000-0000000000a1')$$, '28000', 'cannot allocate a document number');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 7. Frozen after issue ────────────────────────────────────────────────────
select pg_temp.r1529_expect('BOS -> tax_invoice',
  $$update public.invoices set document_kind = 'tax_invoice' where id = (select id from r1529_inv where who = 'A0')$$, '23514', 'cannot change');
select pg_temp.r1529_expect('BOS gains GST',
  $$update public.invoices set tax_amount = 180 where id = (select id from r1529_inv where who = 'A0')$$, '23514', 'cannot carry GST');
select pg_temp.r1529_expect('tax invoice -> BOS',
  $$update public.invoices set document_kind = 'bill_of_supply' where id = (select id from r1529_inv where who = 'B18')$$, '23514', 'cannot change');
select pg_temp.r1529_expect('status rewritten',
  $$update public.invoices set supplier_gst_status = 'registered' where id = (select id from r1529_inv where who = 'A0')$$, '23514', 'cannot change');

-- ── 8. Series must match the supplier ────────────────────────────────────────
select pg_temp.r1529_expect('BOS number on registered business',
  $$insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate)
    values ('BOS-R29B-99-0001', 'e1529000-0000-0000-0000-0000000000b1', 'e1529000-0000-4000-8000-0000000000cb', 'R1529 Cust B', 1000, 'pending', public.ist_today(), 1000, 0, 0)$$,
  '23514', 'belongs to an unregistered');
select pg_temp.r1529_expect('INV number on unregistered business',
  $$insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate)
    values ('INV-R29A-99-0001', 'e1529000-0000-0000-0000-0000000000a1', 'e1529000-0000-4000-8000-0000000000ca', 'R1529 Cust A', 1000, 'pending', public.ist_today(), 1000, 0, 0)$$,
  '23514', 'not from the Bill of Supply');

-- ── 9. Effective date in the future → Bill of Supply today (q4) ──────────────
do $$
declare v text;
begin
  if public.supplier_gst_status('e1529000-0000-0000-0000-0000000000d1', public.ist_today()) <> 'unregistered' then
    raise exception 'FAIL 9: before the effective date the business is not registered';
  end if;
  if public.supplier_gst_status('e1529000-0000-0000-0000-0000000000d1', public.ist_today() + 10) <> 'registered' then
    raise exception 'FAIL 9: from the effective date it is registered';
  end if;
  v := public.next_document_number('invoice', 'e1529000-0000-0000-0000-0000000000d1', public.ist_today());
  if v !~ '^BOS-R29D-' then raise exception 'FAIL 9: number before effective date %', v; end if;
  v := public.next_document_number('invoice', 'e1529000-0000-0000-0000-0000000000d1', public.ist_today() + 10);
  if v !~ '^INV-R29D-' then raise exception 'FAIL 9: number on effective date %', v; end if;
  raise notice 'PASS 9 effective date: BOS before, INV from it';
end $$;

-- ── 10. q1: unregistered = no GSTIN ──────────────────────────────────────────
select pg_temp.r1529_expect('unregistered with GSTIN',
  $$update public.tenants set gstin = '07AAACR1529A1Z1' where id = 'e1529000-0000-0000-0000-0000000000a1'$$,
  '23514', 'tenants_unregistered_no_gstin_check');

do $$ begin raise notice 'PASS bill_of_supply'; end $$;

rollback;
