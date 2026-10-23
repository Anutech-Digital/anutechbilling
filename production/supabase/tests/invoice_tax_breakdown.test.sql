-- Regression test: invoice GST breakdown persisted at issue time (migration 0116).
-- Self-asserting; rolled back. Run on a dev/test DB:
--   psql "$DATABASE_URL" -f invoice_tax_breakdown.test.sql
--
-- Proves generate_invoice + raise_project_milestone_invoice populate
-- taxable_value / tax_amount / tax_rate / inter_state so the GST report and P&L
-- read real numbers (fixes MONEY-1 profit-overstated, MONEY-2 18%-hardcoded,
-- MONEY-5 project PDF ₹0 GST). Identity held everywhere: taxable + tax = amount.

-- ── 1) generate_invoice — INTRA-state (customer & seller both 07 → CGST+SGST) ──
begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaa1111-0000-0000-0000-000000000001','TAX INTRA','ti@example.in','07','TAXI');
insert into public.customers (id, tenant_id, name, state_code)
  values ('bbbb1111-0000-0000-0000-000000000001','aaaa1111-0000-0000-0000-000000000001','Cust Intra','07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaa1111-0000-0000-0000-000000000001','invoice', public.indian_fiscal_year(current_date), 'INV', 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-TAX-INTRA','aaaa1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000001','Cust Intra',
          118000, 100000, 18, 'sent', 'awaiting', '[]'::jsonb);
do $$
declare v record;
begin
  perform public.generate_invoice('Q-TAX-INTRA');
  select taxable_value, tax_amount, tax_rate, inter_state, amount
    into v from public.invoices where quote_id='Q-TAX-INTRA';
  if v.taxable_value <> 100000 then raise exception 'FAIL intra: taxable expected 100000, got %', v.taxable_value; end if;
  if v.tax_amount    <> 18000  then raise exception 'FAIL intra: tax expected 18000, got %', v.tax_amount; end if;
  if v.tax_rate      <> 18     then raise exception 'FAIL intra: rate expected 18, got %', v.tax_rate; end if;
  if v.inter_state             then raise exception 'FAIL intra: inter_state expected false'; end if;
  if v.taxable_value + v.tax_amount <> v.amount then raise exception 'FAIL intra: identity broken'; end if;
  raise notice 'PASS intra: taxable=% tax=% rate=% inter=false', v.taxable_value, v.tax_amount, v.tax_rate;
end $$;
rollback;

-- ── 2) generate_invoice — INTER-state (customer 27, seller 07 → IGST) ─────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaa2222-0000-0000-0000-000000000002','TAX INTER','te@example.in','07','TAXE');
insert into public.customers (id, tenant_id, name, state_code)
  values ('bbbb2222-0000-0000-0000-000000000002','aaaa2222-0000-0000-0000-000000000002','Cust Inter','27');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaa2222-0000-0000-0000-000000000002','invoice', public.indian_fiscal_year(current_date), 'INV', 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-TAX-INTER','aaaa2222-0000-0000-0000-000000000002','bbbb2222-0000-0000-0000-000000000002','Cust Inter',
          118000, 100000, 18, 'sent', 'awaiting', '[]'::jsonb);
do $$
declare v record;
begin
  perform public.generate_invoice('Q-TAX-INTER');
  select taxable_value, tax_amount, inter_state, amount
    into v from public.invoices where quote_id='Q-TAX-INTER';
  if v.taxable_value <> 100000 then raise exception 'FAIL inter: taxable expected 100000, got %', v.taxable_value; end if;
  if v.tax_amount    <> 18000  then raise exception 'FAIL inter: tax expected 18000, got %', v.tax_amount; end if;
  if not v.inter_state         then raise exception 'FAIL inter: inter_state expected true'; end if;
  if v.taxable_value + v.tax_amount <> v.amount then raise exception 'FAIL inter: identity broken'; end if;
  raise notice 'PASS inter: taxable=% tax=% inter=true', v.taxable_value, v.tax_amount;
end $$;
rollback;

-- ── 3) raise_project_milestone_invoice — reverse-derive from inclusive total ──
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaa3333-0000-0000-0000-000000000003','TAX PROJ','tp@example.in','07','TAXP');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaa3333-0000-0000-0000-000000000003','invoice', public.indian_fiscal_year(current_date), 'INV', 0);
insert into public.project_sales (id, tenant_id, customer_name, title, gst_rate, inter_state, taxable_amount, gst_amount, total_amount, status)
  values ('cccc3333-0000-0000-0000-000000000003','aaaa3333-0000-0000-0000-000000000003','Proj Cust','Custom SW',
          18, true, 100000, 18000, 118000, 'active');
insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount)
  values ('dddd3333-0000-0000-0000-000000000003','aaaa3333-0000-0000-0000-000000000003','cccc3333-0000-0000-0000-000000000003',
          1, 'Full', 118000);
do $$
declare v record; v_inv text;
begin
  v_inv := public.raise_project_milestone_invoice('dddd3333-0000-0000-0000-000000000003');
  select taxable_value, tax_amount, tax_rate, inter_state, amount
    into v from public.invoices where id = v_inv;
  if v.taxable_value <> 100000 then raise exception 'FAIL proj: taxable expected 100000, got %', v.taxable_value; end if;
  if v.tax_amount    <> 18000  then raise exception 'FAIL proj: tax expected 18000, got %', v.tax_amount; end if;
  if v.tax_rate      <> 18     then raise exception 'FAIL proj: rate expected 18, got %', v.tax_rate; end if;
  if not v.inter_state         then raise exception 'FAIL proj: inter_state expected true'; end if;
  if v.taxable_value + v.tax_amount <> v.amount then raise exception 'FAIL proj: identity broken'; end if;
  raise notice 'PASS proj: taxable=% tax=% rate=% inter=true', v.taxable_value, v.tax_amount, v.tax_rate;
end $$;
rollback;
