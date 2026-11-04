-- Regression test: the buyer's GSTIN / address / place of supply are frozen on the invoice
-- at issue (migration 20261001170000, R-043).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/invoice_party_snapshot.test.sql
--
-- What it proves:
--   1. A new invoice takes the customer's GSTIN, address, country and state (place of
--      supply) and the company's own GSTIN + state, with no help from the creating path.
--   2. Editing the customer afterwards (new GSTIN, moved state) does NOT change it —
--      which is what the dialog, PDF and GSTR-1 now read.
--   3. Changing the frozen GSTIN on the issued invoice is refused (credit note instead).
--   4. A customer outside India gets place of supply 96 (Other Countries).

begin;

insert into public.tenants (id, name, email, state_code, gstin) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'SNAP TEST', 'snap@example.in', '07', '07AAAAA1111A1Z5');

-- R-2444: a 0% export invoice needs the company's LUT for its FY (trg_invoices_zz_export_lut) — this
-- fixture's exports are made under one, for every FY from 2024-25 up to today's.
insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
select t.id, g.fy::date, 'AD07TESTLUT' || to_char(g.fy, 'YY'), g.fy::date, (g.fy + interval '1 year' - interval '1 day')::date
  from (values ('aaaaaaaa-0000-0000-0000-0000000000f1'::uuid)) as t(id),
       generate_series('2024-04-01'::date, public.lut_fy_start(public.ist_today()), interval '1 year') as g(fy)
on conflict (tenant_id, fy_start) do nothing;

insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country) values
  ('aaaaaaaa-0000-0000-0000-0000000cf001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'AITEST Buyer', '29AAGCB1286Q1Z0',
   '12 MG Road', 'Bengaluru', 'Karnataka', '29', '560001', 'India'),
  ('aaaaaaaa-0000-0000-0000-0000000cf002', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'AITEST Export', null,
   '1 Main St', 'Austin', 'Texas', null, '73301', 'United States');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, inter_state) values
  ('INV-SNAP-27-0001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000cf001', 'AITEST Buyer', 1180, 'pending', '2026-10-01', true),
  ('INV-SNAP-27-0002', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000cf002', 'AITEST Export', 1000, 'pending', '2026-10-01', false);

-- 1. Filled at insert
do $$
declare r public.invoices;
begin
  select * into r from public.invoices where id = 'INV-SNAP-27-0001';
  if r.customer_gstin is distinct from '29AAGCB1286Q1Z0' then raise exception 'FAIL 1: gstin %', r.customer_gstin; end if;
  if r.pos_state_code is distinct from '29' then raise exception 'FAIL 1: pos %', r.pos_state_code; end if;
  if r.seller_gstin is distinct from '07AAAAA1111A1Z5' or r.seller_state_code is distinct from '07' then
    raise exception 'FAIL 1: seller % / %', r.seller_gstin, r.seller_state_code; end if;
  if r.billing_address is distinct from '12 MG Road, Bengaluru, Karnataka 560001' then
    raise exception 'FAIL 1: address %', r.billing_address; end if;
end $$;

-- 2. Customer edited afterwards — the invoice keeps the day-of-issue facts
update public.customers set gstin = '27AAGCB1286Q1Z9', state = 'Maharashtra', state_code = '27', address = 'New office'
 where id = 'aaaaaaaa-0000-0000-0000-0000000cf001';
do $$
declare r public.invoices;
begin
  select * into r from public.invoices where id = 'INV-SNAP-27-0001';
  if r.customer_gstin <> '29AAGCB1286Q1Z0' or r.pos_state_code <> '29' or r.billing_address not like '12 MG Road%' then
    raise exception 'FAIL 2: invoice followed the customer edit (% / % / %)', r.customer_gstin, r.pos_state_code, r.billing_address;
  end if;
end $$;

-- 3. The frozen GSTIN cannot be rewritten on the issued invoice
do $$
begin
  begin
    update public.invoices set customer_gstin = '27AAGCB1286Q1Z9' where id = 'INV-SNAP-27-0001';
    raise exception 'FAIL 3: frozen GSTIN was rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAIL 3%' then raise; end if;
  end;
end $$;

-- 4. Export → 96
do $$
declare v text;
begin
  select pos_state_code into v from public.invoices where id = 'INV-SNAP-27-0002';
  if v is distinct from '96' then raise exception 'FAIL 4: export pos %', v; end if;
end $$;

rollback;
\echo 'invoice_party_snapshot: all checks passed'
