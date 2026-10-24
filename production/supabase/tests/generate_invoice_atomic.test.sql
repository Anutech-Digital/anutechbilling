-- Regression test: atomic generate_invoice RPC (migration 0058, bugs #8 race, #9 orphan).
-- Run on a dev/test DB. Self-asserting; rolled back.
--   psql "$DATABASE_URL" -f generate_invoice_atomic.test.sql
--
-- Proves:
--   1. Full payment  → invoice status='paid', net_payable=0, advances frozen.
--   2. Atomic + idempotent: 2nd call raises, still exactly 1 invoice, quote
--      stays marked invoiced (no orphan, no duplicate).
--   3. Partial payment → invoice status='pending', net_payable = balance owed.

-- ── 1) Full payment → invoice paid + idempotent double-call ──────────────────
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
  values ('eeeeeeee-0000-0000-0000-0000000000a1','GI FULL','gi1@example.in','07','GIA1');
/* R-041 (30 Sep 2026): state_code added. generate_invoice now REFUSES an invoice whose
   place of supply is unknown, so a customer with no state is no longer a valid fixture for
   a test about atomicity. The assertions below are untouched — only the setup is completed
   to satisfy a rule that did not exist when this file was written. */
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-0000-0000-0000-0000000000a1','eeeeeeee-0000-0000-0000-0000000000a1','Cust GI Full','07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('eeeeeeee-0000-0000-0000-0000000000a1','purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000),
         ('eeeeeeee-0000-0000-0000-0000000000a1','invoice',        public.indian_fiscal_year(current_date), 'INV', 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-GI-FULL','eeeeeeee-0000-0000-0000-0000000000a1','cccccccc-0000-0000-0000-0000000000a1','Cust GI Full',122342,103680,18,'sent','awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare
  r_id text; r_net int; r_adv int;
  v_cnt int; v_status text; v_qstatus text; v_qinv text; v_err boolean := false;
begin
  perform public.record_payment('Q-GI-FULL', 122342, 'upi', 'gi_full_ref');

  select invoice_id, net_payable, total_advances into r_id, r_net, r_adv
    from public.generate_invoice('Q-GI-FULL');
  if r_net <> 0      then raise exception 'FAIL full: net_payable expected 0, got %', r_net; end if;
  if r_adv <> 122342 then raise exception 'FAIL full: total_advances expected 122342, got %', r_adv; end if;

  select count(*), max(status::text) into v_cnt, v_status
    from public.invoices where quote_id='Q-GI-FULL';
  if v_cnt <> 1        then raise exception 'FAIL full: expected 1 invoice, got %', v_cnt; end if;
  if v_status <> 'paid' then raise exception 'FAIL full: status expected paid, got %', v_status; end if;

  select payment_status::text, invoice_id into v_qstatus, v_qinv from public.quotes where id='Q-GI-FULL';
  if v_qstatus <> 'invoiced' then raise exception 'FAIL full: quote payment_status expected invoiced, got %', v_qstatus; end if;
  if v_qinv <> r_id          then raise exception 'FAIL full: quote.invoice_id (%) <> returned id (%)', v_qinv, r_id; end if;

  -- Idempotency: 2nd call must raise and NOT create a duplicate.
  begin
    perform public.generate_invoice('Q-GI-FULL');
  exception when others then v_err := true;
  end;
  if not v_err then raise exception 'FAIL full: 2nd generate_invoice did NOT raise'; end if;

  select count(*) into v_cnt from public.invoices where quote_id='Q-GI-FULL';
  if v_cnt <> 1 then raise exception 'FAIL full: after 2nd call expected 1 invoice, got %', v_cnt; end if;

  raise notice 'PASS full-payment: invoice % paid, net 0, idempotent (1 invoice)', r_id;
end $$;
rollback;

-- ── 2) Partial payment → invoice pending, net_payable = balance ──────────────
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
  values ('eeeeeeee-0000-0000-0000-0000000000a2','GI PART','gi2@example.in','07','GIA2');
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-0000-0000-0000-0000000000a2','eeeeeeee-0000-0000-0000-0000000000a2','Cust GI Part','07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('eeeeeeee-0000-0000-0000-0000000000a2','purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000),
         ('eeeeeeee-0000-0000-0000-0000000000a2','invoice',        public.indian_fiscal_year(current_date), 'INV', 0);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-GI-PART','eeeeeeee-0000-0000-0000-0000000000a2','cccccccc-0000-0000-0000-0000000000a2','Cust GI Part',122342,103680,18,'sent','awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
do $$
declare
  r_id text; r_net int; r_adv int; v_status text;
begin
  perform public.record_payment('Q-GI-PART', 50000, 'upi', 'gi_part_ref');

  select invoice_id, net_payable, total_advances into r_id, r_net, r_adv
    from public.generate_invoice('Q-GI-PART');
  if r_adv <> 50000 then raise exception 'FAIL partial: total_advances expected 50000, got %', r_adv; end if;
  if r_net <> 72342 then raise exception 'FAIL partial: net_payable expected 72342, got %', r_net; end if;

  select status::text into v_status from public.invoices where quote_id='Q-GI-PART';
  if v_status <> 'pending' then raise exception 'FAIL partial: status expected pending, got %', v_status; end if;

  raise notice 'PASS partial-payment: invoice % pending, net 72342, advance 50000', r_id;
end $$;
rollback;
