-- Regression test: R-373 (7 Oct 2026, money-flow audit finding 6).
-- Migration 20261007200000_invoice_state_from_gstin.sql. Self-asserting; rolled back.
--
--   1. generate_invoice: customer with a GSTIN (27…) but no state_code, seller in 07
--      -> invoice issued, IGST (inter_state true), place of supply 27.
--   2. generate_invoice: GSTIN 07… and no state_code -> issued, CGST+SGST.
--   3. generate_invoice: no GSTIN and no state_code -> still refused (guard kept).
--   4. accept_quote reuses a customer with no state -> state_code/state filled from the lead.
--   5. accept_quote reuses a customer whose state is already set -> NOT overwritten.
--   6. record_payment reuses a customer with no state, lead has only a GSTIN (24…)
--      -> state_code filled from the GSTIN prefix, and generate_invoice then issues.
--
-- Fixture owns its data: its own tenant, customers, leads, quotes. Literal ids.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('37300000-0000-4000-8000-000000000001', 'R373 TEST', 'r373@example.in', '07', 'R373');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('37300000-0000-4000-8000-000000000001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 990000);

insert into public.customers (id, tenant_id, name, contact_email, gstin, state_code, state, country) values
  ('37300000-0000-4000-8000-0000000000c1', '37300000-0000-4000-8000-000000000001', 'Mumbai Gstin Ltd', 'a@mg.in', '27AAPFU0939F1ZV', null, null, 'India'),
  ('37300000-0000-4000-8000-0000000000c2', '37300000-0000-4000-8000-000000000001', 'Delhi Gstin Ltd',  'a@dg.in', '07AAACE1234F1Z5', null, null, 'India'),
  ('37300000-0000-4000-8000-0000000000c3', '37300000-0000-4000-8000-000000000001', 'Nothing Ltd',      'a@no.in', null,              null, null, 'India'),
  ('37300000-0000-4000-8000-0000000000c4', '37300000-0000-4000-8000-000000000001', 'Blank State Co',   'a@bs.in', null,              null, null, 'India'),
  ('37300000-0000-4000-8000-0000000000c5', '37300000-0000-4000-8000-000000000001', 'Karnataka Co',     'a@ka.in', null,              '29', 'Karnataka', 'India'),
  ('37300000-0000-4000-8000-0000000000c6', '37300000-0000-4000-8000-000000000001', 'Gujarat Firm',     'a@gf.in', '24AAACG1111F1Z1', null, null, 'India');

insert into public.leads (id, tenant_id, company, contact_email, stage, source, priority, state_code, state, gstin) values
  ('L-R373-4', '37300000-0000-4000-8000-000000000001', 'Blank State Co', 'a@bs.in', 'quote', 'manual', 'medium', '27', 'Maharashtra', null),
  ('L-R373-5', '37300000-0000-4000-8000-000000000001', 'Karnataka Co',   'a@ka.in', 'quote', 'manual', 'medium', '27', 'Maharashtra', null),
  ('L-R373-6', '37300000-0000-4000-8000-000000000001', 'Gujarat Firm',   'x@other.in', 'quote', 'manual', 'medium', null, null, '24AAACG1111F1Z1');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R373-1', '37300000-0000-4000-8000-000000000001', null, '37300000-0000-4000-8000-0000000000c1', 'Mumbai Gstin Ltd', 11800, 10000, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R373-2', '37300000-0000-4000-8000-000000000001', null, '37300000-0000-4000-8000-0000000000c2', 'Delhi Gstin Ltd',  11800, 10000, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R373-3', '37300000-0000-4000-8000-000000000001', null, '37300000-0000-4000-8000-0000000000c3', 'Nothing Ltd',      11800, 10000, 18, 'accepted', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R373-4', '37300000-0000-4000-8000-000000000001', 'L-R373-4', null, 'Blank State Co', 11800, 10000, 18, 'sent', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R373-5', '37300000-0000-4000-8000-000000000001', 'L-R373-5', null, 'Karnataka Co',   11800, 10000, 18, 'sent', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb),
  ('Q-R373-6', '37300000-0000-4000-8000-000000000001', 'L-R373-6', null, 'Gujarat Firm',   11800, 10000, 18, 'sent', 'awaiting', '[{"name":"Thing","qty":1,"rate":10000}]'::jsonb);

do $$
declare
  v_inv text; v_inter boolean; v_pos text; v_refused boolean := false;
  v_cust uuid; v_sc text; v_st text;
begin
  -- 1. GSTIN 27…, no state_code, seller 07 -> IGST, POS 27
  select invoice_id into v_inv from public.generate_invoice('Q-R373-1');
  select inter_state, pos_state_code into v_inter, v_pos from public.invoices where id = v_inv;
  if v_inter is not true then raise exception 'FAIL 1: GSTIN 27 vs seller 07 must be inter-state, got %', v_inter; end if;
  if v_pos is distinct from '27' then raise exception 'FAIL 1: place of supply expected 27, got %', v_pos; end if;

  -- 2. GSTIN 07…, no state_code -> CGST+SGST
  select invoice_id into v_inv from public.generate_invoice('Q-R373-2');
  select inter_state into v_inter from public.invoices where id = v_inv;
  if v_inter is not false then raise exception 'FAIL 2: GSTIN 07 vs seller 07 must be intra-state, got %', v_inter; end if;

  -- 3. no GSTIN, no state -> still refused
  begin
    perform public.generate_invoice('Q-R373-3');
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 3: customer with no state and no GSTIN must still be refused'; end if;

  -- 4. accept_quote reuses a blank-state customer -> filled from the lead
  perform public.accept_quote('Q-R373-4');
  select customer_id into v_cust from public.quotes where id = 'Q-R373-4';
  if v_cust is distinct from '37300000-0000-4000-8000-0000000000c4'::uuid then raise exception 'FAIL 4: customer not reused (got %)', v_cust; end if;
  select state_code, state into v_sc, v_st from public.customers where id = v_cust;
  if v_sc is distinct from '27' or v_st is distinct from 'Maharashtra' then
    raise exception 'FAIL 4: blank customer state not filled from lead (got %/%)', v_sc, v_st;
  end if;

  -- 5. accept_quote reuses a customer with a state -> unchanged
  perform public.accept_quote('Q-R373-5');
  select state_code, state into v_sc, v_st from public.customers where id = '37300000-0000-4000-8000-0000000000c5';
  if v_sc is distinct from '29' or v_st is distinct from 'Karnataka' then
    raise exception 'FAIL 5: existing customer state overwritten (got %/%)', v_sc, v_st;
  end if;

  -- 6. record_payment reuses (same GSTIN) a blank-state customer, lead has only a GSTIN
  perform public.record_payment('Q-R373-6', 11800, 'upi', 'r373-pay-6');
  select customer_id into v_cust from public.quotes where id = 'Q-R373-6';
  if v_cust is distinct from '37300000-0000-4000-8000-0000000000c6'::uuid then raise exception 'FAIL 6: customer not reused (got %)', v_cust; end if;
  select state_code into v_sc from public.customers where id = v_cust;
  if v_sc is distinct from '24' then raise exception 'FAIL 6: state_code not filled from lead GSTIN prefix (got %)', v_sc; end if;

  raise notice 'PASS invoice_state_from_gstin (6/6)';
end $$;
rollback;
