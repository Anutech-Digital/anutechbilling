-- R-1617 (19 Oct 2026): a document number past 9999 must never be cut back to 4 digits.
-- Migration 20261019001426_r1617_document_number_no_truncate. Self-asserting; rolled back.
--   psql "$DATABASE_URL" -f r1617_document_number_past_9999.test.sql
--
-- The bug: format_document_number padded with lpad(n, 4, '0'), and Postgres lpad also
-- TRUNCATES — so number 10000 printed as "…-1000", the same string as the real #1000 of
-- that series. invoices.id / receipt ids / PO ids are primary keys, so the 10,000th
-- document of a year was a duplicate-key error inside record_payment / generate_invoice.
--
-- The rule now: at least 4 digits, never cut. The 16-character CGST Rule 46(b) limit stays:
-- a number that would be longer raises a clear error naming the series (never a silent cut).
--
-- Fixture owns its data (L11): its own tenants, its own literal ids.

-- ── 1. The formatter alone ──────────────────────────────────────────────────
begin;
do $$
declare v text; v_msg text; v_raised boolean := false;
begin
  if public.format_document_number('RV-ABCD', 'FY2627', 1) <> 'RV-ABCD-27-0001' then
    raise exception 'FAIL 1a: 1 should still pad to 0001, got %', public.format_document_number('RV-ABCD', 'FY2627', 1);
  end if;
  if public.format_document_number('RV-ABCD', 'FY2627', 9999) <> 'RV-ABCD-27-9999' then
    raise exception 'FAIL 1b: 9999 changed, got %', public.format_document_number('RV-ABCD', 'FY2627', 9999);
  end if;

  v := public.format_document_number('RV-ABCD', 'FY2627', 10000);
  if v = 'RV-ABCD-27-1000' then
    raise exception 'FAIL 1c: 10000 was cut to 1000 — it collides with the real #1000';
  end if;
  if v <> 'RV-ABCD-27-10000' then
    raise exception 'FAIL 1c: 10000 should print RV-ABCD-27-10000, got %', v;
  end if;

  if public.format_document_number('INV-ABC', 'FY2627', 10000) <> 'INV-ABC-27-10000' then
    raise exception 'FAIL 1d: a 3-letter code has room for 5 digits, got %', public.format_document_number('INV-ABC', 'FY2627', 10000);
  end if;

  -- 16 characters is the ceiling: INV-ADPL-27-10000 is 17 → a clear error, not a cut.
  begin
    v := public.format_document_number('INV-ADPL', 'FY2627', 10000);
  exception when others then
    v_raised := true;
    v_msg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 1e: INV-ADPL #10000 is 17 characters and should have been refused, got %', v;
  end if;
  if v_msg not like '%INV-ADPL%' or v_msg not like '%16%' or v_msg not ilike '%invoice code%' then
    raise exception 'FAIL 1e: the error must name the series, the 16 limit and the fix (invoice code), got: %', v_msg;
  end if;
  raise notice 'PASS 1: 0001 / 9999 / 10000 / >16 refused (%).', v_msg;
end $$;
rollback;

-- ── 2. The allocator: #10000 is a different string from #1000 ───────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e1617000-0000-4000-8000-000000000001', 'R1617 A', 'r1617a@example.in', '07', 'NA17');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e1617000-0000-4000-8000-000000000001', 'receipt_voucher', public.indian_fiscal_year(public.ist_today()), 'RV', 999);
do $$
declare v_1000 text; v_10000 text;
begin
  v_1000 := public.next_document_number('receipt_voucher', 'e1617000-0000-4000-8000-000000000001');
  update public.document_series set last_number = 9999
   where tenant_id = 'e1617000-0000-4000-8000-000000000001' and doc_type = 'receipt_voucher';
  v_10000 := public.next_document_number('receipt_voucher', 'e1617000-0000-4000-8000-000000000001');
  if v_1000 not like '%-1000' then raise exception 'FAIL 2: setup — expected #1000, got %', v_1000; end if;
  if v_10000 = v_1000 then raise exception 'FAIL 2: #10000 came out as % — same as #1000', v_10000; end if;
  if v_10000 not like '%-10000' then raise exception 'FAIL 2: expected …-10000, got %', v_10000; end if;
  raise notice 'PASS 2: % then %', v_1000, v_10000;
end $$;
rollback;

-- ── 3. record_payment past 9999: no duplicate receipt / PO key ──────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e1617000-0000-4000-8000-000000000002', 'R1617 B', 'r1617b@example.in', '07', 'NB17');
insert into public.customers (id, tenant_id, name, state_code)
  values ('c1617000-0000-4000-8000-000000000002', 'e1617000-0000-4000-8000-000000000002', 'Cust R1617 B', '07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e1617000-0000-4000-8000-000000000002', 'receipt_voucher', public.indian_fiscal_year(public.ist_today()), 'RV', 999),
         ('e1617000-0000-4000-8000-000000000002', 'purchase_order',  public.indian_fiscal_year(public.ist_today()), 'PO', 999);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R1617-B1', 'e1617000-0000-4000-8000-000000000002', 'c1617000-0000-4000-8000-000000000002', 'Cust R1617 B',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb),
         ('Q-R1617-B2', 'e1617000-0000-4000-8000-000000000002', 'c1617000-0000-4000-8000-000000000002', 'Cust R1617 B',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_po_10000 int;
begin
  perform public.record_payment('Q-R1617-B1', 122342, 'upi', 'r1617_b1_ref');   -- takes #1000s
  update public.document_series set last_number = 9999
   where tenant_id = 'e1617000-0000-4000-8000-000000000002';
  perform public.record_payment('Q-R1617-B2', 122342, 'upi', 'r1617_b2_ref');   -- takes #10000s
  select count(*) into v_po_10000 from public.purchase_orders
   where tenant_id = 'e1617000-0000-4000-8000-000000000002' and id like '%-10000';
  if v_po_10000 <> 1 then raise exception 'FAIL 3: expected one PO numbered …-10000, got %', v_po_10000; end if;
  raise notice 'PASS 3: record_payment past 9999 — no duplicate key, PO …-10000 issued';
end $$;
rollback;

-- ── 4. generate_invoice past 9999 ───────────────────────────────────────────
-- 4a. A 3-letter code: INV-GC7-27-10000 is 16 characters — issued, no duplicate key.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e1617000-0000-4000-8000-000000000003', 'R1617 C', 'r1617c@example.in', '07', 'GC7');
insert into public.customers (id, tenant_id, name, state_code)
  values ('c1617000-0000-4000-8000-000000000003', 'e1617000-0000-4000-8000-000000000003', 'Cust R1617 C', '07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e1617000-0000-4000-8000-000000000003', 'invoice',        public.indian_fiscal_year(public.ist_today()), 'INV', 999),
         ('e1617000-0000-4000-8000-000000000003', 'purchase_order', public.indian_fiscal_year(public.ist_today()), 'PO', 9000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R1617-C1', 'e1617000-0000-4000-8000-000000000003', 'c1617000-0000-4000-8000-000000000003', 'Cust R1617 C',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb),
         ('Q-R1617-C2', 'e1617000-0000-4000-8000-000000000003', 'c1617000-0000-4000-8000-000000000003', 'Cust R1617 C',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare v_first text; v_second text;
begin
  perform public.record_payment('Q-R1617-C1', 122342, 'upi', 'r1617_c1_ref');
  select invoice_id into v_first from public.generate_invoice('Q-R1617-C1');
  update public.document_series set last_number = 9999
   where tenant_id = 'e1617000-0000-4000-8000-000000000003' and doc_type = 'invoice';
  perform public.record_payment('Q-R1617-C2', 122342, 'upi', 'r1617_c2_ref');
  select invoice_id into v_second from public.generate_invoice('Q-R1617-C2');
  if v_first <> 'INV-GC7-' || substring(public.indian_fiscal_year(public.ist_today()) from 5 for 2) || '-1000' then
    raise exception 'FAIL 4a: setup — expected the #1000 invoice, got %', v_first;
  end if;
  if v_second not like 'INV-GC7-%-10000' or length(v_second) > 16 then
    raise exception 'FAIL 4a: expected INV-GC7-YY-10000 (16 chars), got %', v_second;
  end if;
  raise notice 'PASS 4a: generate_invoice % then %', v_first, v_second;
end $$;
rollback;

-- 4b. A 4-letter code: INV-GD17-27-10000 would be 17 — refused with the clear error, not a
--     duplicate key and not a cut number.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e1617000-0000-4000-8000-000000000004', 'R1617 D', 'r1617d@example.in', '07', 'GD17');
insert into public.customers (id, tenant_id, name, state_code)
  values ('c1617000-0000-4000-8000-000000000004', 'e1617000-0000-4000-8000-000000000004', 'Cust R1617 D', '07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('e1617000-0000-4000-8000-000000000004', 'invoice',        public.indian_fiscal_year(public.ist_today()), 'INV', 9999),
         ('e1617000-0000-4000-8000-000000000004', 'purchase_order', public.indian_fiscal_year(public.ist_today()), 'PO', 9000);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R1617-D1', 'e1617000-0000-4000-8000-000000000004', 'c1617000-0000-4000-8000-000000000004', 'Cust R1617 D',
          122342, 103680, 18, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
/* A real #1000 already in the books — what the cut number used to collide with. */
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
  values ('INV-GD17-' || substring(public.indian_fiscal_year(public.ist_today()) from 5 for 2) || '-1000',
          'e1617000-0000-4000-8000-000000000004', 'c1617000-0000-4000-8000-000000000004', 'Cust R1617 D', 100, 'paid', public.ist_today());
do $$
declare v_msg text; v_state text; v_raised boolean := false;
begin
  perform public.record_payment('Q-R1617-D1', 122342, 'upi', 'r1617_d1_ref');
  begin
    perform public.generate_invoice('Q-R1617-D1');
  exception when others then
    v_raised := true; v_msg := sqlerrm; v_state := sqlstate;
  end;
  if not v_raised then raise exception 'FAIL 4b: a 17-character invoice number was issued'; end if;
  if v_state = '23505' then raise exception 'FAIL 4b: duplicate key (the old cut-to-1000 bug): %', v_msg; end if;
  if v_msg not like '%INV-GD17%' or v_msg not ilike '%invoice code%' then
    raise exception 'FAIL 4b: expected the series-full error, got [%] %', v_state, v_msg;
  end if;
  raise notice 'PASS 4b: refused clearly — %', v_msg;
end $$;
rollback;
