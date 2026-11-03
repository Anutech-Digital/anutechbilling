-- R-2425 (3 Nov 2026): an export receipt ("INW 070826I049902623 USD1024.0@93.6", ₹95,846 in the bank — whole rupees) booked as
-- a sale in the customer's currency, ₹ = the bank credit. Migration
-- 20261103153553_r2425_bank_sale_foreign_currency (reconcile_bank_credit_new_sale_fx).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. $1,024 @ 93.6 for a US customer → the line is reconciled, the quote and its invoice carry
--      USD / 93.6 / manual / the bank date, 0% GST, ₹95,846 (whole rupees), Zoho number kept.
--   B. $1,000 @ 93.6 against the ₹95,846.40 line → refused (not the bank credit); nothing booked.
--   C. An Indian customer → refused; nothing booked.
--   D. INR as the currency → refused.
--   E. Another company's bank line → refused.
--   F. A below-cost sale waits for approval and its quote already carries USD / 93.55.

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
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000242501','R2425 Export Co','r2425@example.in','07','R242'),
  ('dddddddd-0000-0000-0000-000000242502','R2425 Other Co','r2425b@example.in','07','R243');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000242501','owner2425@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000242501','dddddddd-0000-0000-0000-000000242501','owner2425@example.in','Owner 2425','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000242501','dddddddd-0000-0000-0000-000000242501','Design Box LLC',null,'United States','designbox.example'),
  ('cccccccc-0000-0000-0000-000000242502','dddddddd-0000-0000-0000-000000242501','Desi Buyer','07','India','desibuyer.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000242501','dddddddd-0000-0000-0000-000000242501','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000242502','dddddddd-0000-0000-0000-000000242502','Other HDFC','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000242501','dddddddd-0000-0000-0000-000000242501','bbbbbbbb-0000-0000-0000-000000242501','2026-08-07','INW 070826I049902623 USD1024.0@93.6',0,95846,null,'manual'),
  ('11111111-0000-0000-0000-000000242502','dddddddd-0000-0000-0000-000000242501','bbbbbbbb-0000-0000-0000-000000242501','2026-08-05','INW 050826I049902875 USD759.0@93.55',0,71004,null,'manual'),
  ('11111111-0000-0000-0000-000000242503','dddddddd-0000-0000-0000-000000242502','bbbbbbbb-0000-0000-0000-000000242502','2026-08-05','INW 050826I049902522 USD1600.0@93.55',0,149680,null,'manual'),
  ('11111111-0000-0000-0000-000000242504','dddddddd-0000-0000-0000-000000242501','bbbbbbbb-0000-0000-0000-000000242501','2026-09-11','INW 110926I049908171 USD56.0@93.99',0,5263,null,'manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000242501","role":"authenticated"}', true);

do $$
declare
  c_cust  constant uuid := 'cccccccc-0000-0000-0000-000000242501';
  c_line  constant jsonb := '[{"item_id":null,"name":"Website design","qty":1,"rate":95846.4,"cost":0,"commitment":"one_time"}]';
  r jsonb; v_q text; v_inv text; ok boolean; v_msg text; n int; q record; i record;
begin
  -- A
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242501', c_cust,
         c_line, false, null, null, 'yearly', 'INV/26-27/0501', 'usd', 93.6, 1024);
  v_q := r->>'quote_id'; v_inv := r->>'invoice_id';
  if v_q is null or v_inv is null then raise exception 'FAIL A: no quote / invoice (%)', r; end if;
  select currency, exchange_rate, fx_source, fx_date, amount, tax_rate into q from public.quotes where id = v_q;
  if q.currency <> 'USD' or q.exchange_rate <> 93.6 or q.fx_source <> 'manual' or q.fx_date <> '2026-08-07'
     or q.amount <> 95846 or q.tax_rate <> 0 then
    raise exception 'FAIL A: quote % is % % % % ₹% GST %', v_q, q.currency, q.exchange_rate, q.fx_source, q.fx_date, q.amount, q.tax_rate;
  end if;
  select currency, fx_rate, fx_source, fx_date, external_number into i from public.invoices where id = v_inv;
  if i.currency is distinct from 'USD' or i.fx_rate is distinct from 93.6 or i.fx_date is distinct from '2026-08-07'
     or i.external_number is distinct from 'INV/26-27/0501' then
    raise exception 'FAIL A: invoice % is % % % (Zoho %)', v_inv, i.currency, i.fx_rate, i.fx_date, i.external_number;
  end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000242501') is null then
    raise exception 'FAIL A: the bank line was not reconciled';
  end if;
  if (r->>'fx_invoices')::int <> 1 or r->>'currency' <> 'USD' then raise exception 'FAIL A: result %', r; end if;
  raise notice 'A PASS: % / % in USD @ 93.6, ₹95,846, 0%% GST', v_q, v_inv;

  -- B
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242502', c_cust,
              '[{"item_id":null,"name":"Website design","qty":1,"rate":70000,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 'yearly', null, 'USD', 93.55, 1000);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'The bank line is ₹71004, but USD 1000 at ₹93.55 is ₹93550.00%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a remittance that is not the bank credit was booked'; end if;

  -- C
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242502', 'cccccccc-0000-0000-0000-000000242502',
              '[{"item_id":null,"name":"Website design","qty":1,"rate":71004.45,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 'yearly', null, 'USD', 93.55, 759);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL C: an Indian customer was booked as an export sale'; end if;

  -- D
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242502', c_cust,
              '[{"item_id":null,"name":"Website design","qty":1,"rate":71004.45,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 'yearly', null, 'INR', 1, 71004.45);
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL D: INR accepted as a foreign currency'; end if;

  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000242502') is not null then
    raise exception 'FAIL B-D: the refused line was reconciled';
  end if;
  select count(*) into n from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000242501';
  if n <> 1 then raise exception 'FAIL B-D: % quotes (want 1 — a refused sale left one behind)', n; end if;
  raise notice 'B-D PASS: wrong amount, Indian customer and INR refused; nothing booked';

  -- E
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242503', c_cust,
              '[{"item_id":null,"name":"Website design","qty":1,"rate":149680,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 'yearly', null, 'USD', 93.55, 1600);
  exception when sqlstate '42501' then ok := true;
  end;
  if not ok then raise exception 'FAIL E: another company''s bank line was booked'; end if;
  raise notice 'E PASS: other company''s line refused';

  -- F
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242504', c_cust,
         '[{"item_id":null,"name":"Website design","qty":1,"rate":5263.44,"cost":9000,"commitment":"one_time"}]'::jsonb,
         false, null, null, 'yearly', null, 'USD', 93.99, 56);
  if not coalesce((r->>'needs_approval')::boolean, false) then raise exception 'FAIL F: below cost not parked (%)', r; end if;
  select currency, exchange_rate into q from public.quotes where id = r->>'quote_id';
  if q.currency <> 'USD' or q.exchange_rate <> 93.99 then raise exception 'FAIL F: parked quote is % %', q.currency, q.exchange_rate; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000242504') is not null then
    raise exception 'FAIL F: a below-cost line was reconciled';
  end if;
  raise notice 'F PASS: below-cost sale waits for approval, quote in USD';
end $$;

select 'R-2425 foreign-currency bank sale: ALL PASS' as result;

rollback;
