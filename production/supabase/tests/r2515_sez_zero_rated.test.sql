-- R-2515 (5 Nov 2026): a supply to an SEZ unit WITHOUT payment of tax is zero-rated (0% GST) under the
-- LUT of its date's FY — from a bank receipt's "A new sale" too. Migration 20261105*_r2515_sez_zero_rated.
-- Self-asserting, ONE transaction, rolled back. Local/test DB only. Red without the migration (the bank
-- sale for an SEZ-without-payment customer is booked at 18% IGST, and a 0% SEZ invoice needs no LUT).
--
-- Owner's case (R-2094, May): an SEZ customer with a Haryana GSTIN paid ₹55,223 on 4 May 2026 against a
-- Zoho invoice at 0% GST. The app could only book it at IGST 18%.
--
--   A. Company with the FY 2026-27 LUT, SEZ (without payment) customer, bank line 4 May 2026 ₹55,223 →
--      "A new sale" of ₹55,223: quote at 0%, total ₹55,223 (no GST added), tax invoice at 0% with
--      gst_treatment sez_without_payment, inter_state (SEZ is always inter-state); the line is reconciled.
--   B. Same sale in a company with NO LUT → refused with the LUT step, naming the SEZ; nothing booked.
--   C. SEZ WITH payment customer → the bank sale stays 18%, IGST (inter-state even though…), total +18%.
--   D. Quote → invoice at 0% for an SEZ-without-payment customer, no LUT → refused (the invoice trigger
--      covers every path, not only the bank sale). With 18% the same customer's invoice is issued.
--   E. A regular Indian customer: the bank sale is still 18% (nothing else became 0%).

begin;

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

select set_config('request.jwt.claims', '', true);
-- Company 1 has the FY 2026-27 LUT. Company 2 has none.
insert into public.tenants (id, name, email, state_code, doc_code, lut_number, lut_valid_upto) values
  ('dddddddd-0000-0000-0000-000000251501','R2515 SEZ Seller','r2515@example.in','07','S515','AD070426000515X','2027-03-31'),
  ('dddddddd-0000-0000-0000-000000251502','R2515 No LUT Co','r2515b@example.in','07','N515',null,null);
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000251501','owner2515@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251502','owner2515b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251501','dddddddd-0000-0000-0000-000000251501','owner2515@example.in','Owner 2515','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251502','dddddddd-0000-0000-0000-000000251502','owner2515b@example.in','Owner 2515b','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, gstin, customer_type, gst_treatment, domain) values
  ('cccccccc-0000-0000-0000-000000251501','dddddddd-0000-0000-0000-000000251501','Gurugram SEZ Unit Pvt Ltd','06','India','06AAACS2515E1Z5','business','sez_without_payment','sez2515.example'),
  ('cccccccc-0000-0000-0000-000000251502','dddddddd-0000-0000-0000-000000251502','Noida SEZ Unit Pvt Ltd','09','India','09AAACS2515E1Z5','business','sez_without_payment','sez2515b.example'),
  ('cccccccc-0000-0000-0000-000000251503','dddddddd-0000-0000-0000-000000251501','Delhi SEZ Paid Pvt Ltd','07','India','07AAACS2515P1Z5','business','sez_with_payment','sezpaid2515.example'),
  ('cccccccc-0000-0000-0000-000000251504','dddddddd-0000-0000-0000-000000251501','Delhi Regular Pvt Ltd','07','India','07AAACR2515R1Z5','business','registered_regular','reg2515.example');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2515-SEZ0',  'dddddddd-0000-0000-0000-000000251502', 'cccccccc-0000-0000-0000-000000251502', 'Noida SEZ Unit Pvt Ltd', 50000, 50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2515-SEZ18', 'dddddddd-0000-0000-0000-000000251502', 'cccccccc-0000-0000-0000-000000251502', 'Noida SEZ Unit Pvt Ltd', 59000, 50000, 18, 'accepted', 'received', '[]'::jsonb);
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000251501','dddddddd-0000-0000-0000-000000251501','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000251502','dddddddd-0000-0000-0000-000000251502','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000251501','dddddddd-0000-0000-0000-000000251501','bbbbbbbb-0000-0000-0000-000000251501','2026-05-04','NEFT CR-CITI-SEZ UNIT',0,55223,'CITIN25150001','manual'),
  ('11111111-0000-0000-0000-000000251502','dddddddd-0000-0000-0000-000000251502','bbbbbbbb-0000-0000-0000-000000251502','2026-05-04','NEFT CR-CITI-NOIDA SEZ',0,55223,'CITIN25150002','manual'),
  ('11111111-0000-0000-0000-000000251503','dddddddd-0000-0000-0000-000000251501','bbbbbbbb-0000-0000-0000-000000251501','2026-05-06','NEFT CR-SEZ PAID',0,59000,'CITIN25150003','manual'),
  ('11111111-0000-0000-0000-000000251504','dddddddd-0000-0000-0000-000000251501','bbbbbbbb-0000-0000-0000-000000251501','2026-05-07','NEFT CR-REGULAR',0,11800,'CITIN25150004','manual');

do $$
declare
  c_t1 constant uuid := 'dddddddd-0000-0000-0000-000000251501';
  c_t2 constant uuid := 'dddddddd-0000-0000-0000-000000251502';
  ok boolean; v_msg text; n int; r jsonb; q record; i record; v_inv text;
begin
  -- A. SEZ without payment + LUT → 0% sale from the bank line.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251501","role":"authenticated"}', true);
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251501', 'cccccccc-0000-0000-0000-000000251501',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":55223,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly', null);
  if (r->>'tax_rate')::int is distinct from 0 then raise exception 'FAIL A: SEZ without payment sale taxed at % percent', r->>'tax_rate'; end if;
  if (r->>'quote_total')::int is distinct from 55223 then raise exception 'FAIL A: quote total % (GST added?)', r->>'quote_total'; end if;
  select * into i from public.invoices where tenant_id = c_t1 and customer_id = 'cccccccc-0000-0000-0000-000000251501';
  if not found then raise exception 'FAIL A: no tax invoice issued for the SEZ sale'; end if;
  if coalesce(i.tax_amount, -1) <> 0 or coalesce(i.tax_rate, -1) <> 0 then raise exception 'FAIL A: invoice tax % at % percent', i.tax_amount, i.tax_rate; end if;
  if i.gst_treatment is distinct from 'sez_without_payment' then raise exception 'FAIL A: invoice treatment %', i.gst_treatment; end if;
  if i.inter_state is distinct from true then raise exception 'FAIL A: SEZ invoice not inter-state'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000251501') is null then
    raise exception 'FAIL A: the bank line was not reconciled';
  end if;
  raise notice 'A PASS: SEZ (without payment) + LUT → bank new sale at 0%%, invoice 0%% SEZWOP, line reconciled';

  -- B. No LUT → refused, says SEZ + the LUT step; nothing booked.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251502","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251502', 'cccccccc-0000-0000-0000-000000251502',
              '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":55223,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 0, null, null, 'yearly', null);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%SEZ%' and v_msg like '%LUT%Settings → Company → LUT%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a 0%% SEZ sale was booked with no LUT'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000251502') is not null then
    raise exception 'FAIL B: the refused line was reconciled';
  end if;
  select count(*) into n from public.invoices where tenant_id = c_t2;
  if n <> 0 then raise exception 'FAIL B: % invoices left by the refused sale', n; end if;
  raise notice 'B PASS: SEZ 0%% sale without an LUT refused, nothing booked';

  -- C. SEZ WITH payment → 18% IGST.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251501","role":"authenticated"}', true);
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251503', 'cccccccc-0000-0000-0000-000000251503',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":50000,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly', null);
  if (r->>'tax_rate')::int is distinct from 18 or (r->>'quote_total')::int is distinct from 59000 then
    raise exception 'FAIL C: SEZ with payment sale at % percent, total %', r->>'tax_rate', r->>'quote_total';
  end if;
  select * into i from public.invoices where tenant_id = c_t1 and customer_id = 'cccccccc-0000-0000-0000-000000251503';
  if i.tax_amount <> 9000 or i.inter_state is distinct from true then raise exception 'FAIL C: invoice tax % inter %', i.tax_amount, i.inter_state; end if;
  raise notice 'C PASS: SEZ with payment stays IGST 18%%';

  -- D. Quote → invoice at 0% for SEZ without payment, no LUT → refused; at 18% → issued.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251502","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.generate_invoice('Q-R2515-SEZ0');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%SEZ%LUT%';
    if not ok then raise exception 'FAIL D: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D: a 0%% SEZ invoice was issued with no LUT'; end if;
  select invoice_id into v_inv from public.generate_invoice('Q-R2515-SEZ18');
  if v_inv is null or (select tax_rate from public.invoices where id = v_inv) <> 18 then
    raise exception 'FAIL D: the 18%% SEZ invoice was not issued';
  end if;
  raise notice 'D PASS: 0%% SEZ quote → invoice refused without LUT; 18%% issued';

  -- E. a regular customer is untouched.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251501","role":"authenticated"}', true);
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251504', 'cccccccc-0000-0000-0000-000000251504',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":10000,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly', null);
  if (r->>'tax_rate')::int is distinct from 18 then raise exception 'FAIL E: regular customer sale at % percent', r->>'tax_rate'; end if;
  raise notice 'E PASS: regular customer still 18%%';
end $$;

rollback;
