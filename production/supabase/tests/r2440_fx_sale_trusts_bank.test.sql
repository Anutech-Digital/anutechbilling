-- R-2440 (3 Nov 2026, independent review 2 of R-2425): reconcile_bank_credit_new_sale_fx books an export
-- receipt only as the BANK wrote it, and only under an LUT. Migration
-- 20261103163318_r2440_fx_sale_trusts_bank. Self-asserting, ONE transaction, rolled back. Local/test DB only.
--
--   G. "USD1024.0@93.6" (₹95,846) sent as USD 1 @ 95846 (1 × 95846 = the credit) → refused; nothing booked.
--   H. The same line sent as XYZ 1024 @ 93.6 → refused (a made-up currency).
--   I. A line whose narration has no foreign amount + rate → refused (book it by hand in ₹).
--   J. No LUT on file → refused with the Settings step; an LUT of LAST year (valid up to 31 Mar 2026)
--      for an August 2026 receipt → refused too.
--   K. LUT for FY 2026-27 → booked; the quote and invoice carry the narration's USD / 93.6.

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
  ('dddddddd-0000-0000-0000-000000244001','R2440 Export Co','r2440@example.in','07','R244');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000244001','owner2440@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000244001','dddddddd-0000-0000-0000-000000244001','owner2440@example.in','Owner 2440','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000244001','dddddddd-0000-0000-0000-000000244001','Design Box LLC',null,'United States','designbox2440.example');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000244001','dddddddd-0000-0000-0000-000000244001','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000244001','dddddddd-0000-0000-0000-000000244001','bbbbbbbb-0000-0000-0000-000000244001','2026-08-07','INW 070826I049902623 USD1024.0@93.6',0,95846,null,'manual'),
  ('11111111-0000-0000-0000-000000244002','dddddddd-0000-0000-0000-000000244001','bbbbbbbb-0000-0000-0000-000000244001','2026-08-08','NEFT CR-CITI0000001-DESIGN BOX LLC',0,93600,null,'manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000244001","role":"authenticated"}', true);

do $$
declare
  c_cust  constant uuid := 'cccccccc-0000-0000-0000-000000244001';
  c_line  constant jsonb := '[{"item_id":null,"name":"Website design","qty":1,"rate":95846,"cost":0,"commitment":"one_time"}]';
  r jsonb; ok boolean; v_msg text; n int; q record; i record;
begin
  update public.tenants set lut_number = 'AD070426000123X', lut_valid_upto = '2027-03-31'
   where id = 'dddddddd-0000-0000-0000-000000244001';

  -- G. forged rate: 1 × 95846 = the credit, but the bank wrote USD 1024 @ 93.6.
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244001', c_cust,
              c_line, false, null, null, 'yearly', null, 'USD', 95846, 1);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'The bank narration says USD 1024 @ ₹93.6%';
    if not ok then raise exception 'FAIL G: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL G: USD 1 @ 95846 was booked against "USD1024.0@93.6"'; end if;

  -- H. a made-up currency.
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244001', c_cust,
              c_line, false, null, null, 'yearly', null, 'XYZ', 93.6, 1024);
  exception when sqlstate '22023' or check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%XYZ%';
    if not ok then raise exception 'FAIL H: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL H: XYZ was booked'; end if;

  -- I. no remittance in the narration.
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244002', c_cust,
              '[{"item_id":null,"name":"Website design","qty":1,"rate":93600,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 'yearly', null, 'USD', 93.6, 1000);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'This bank line''s narration has no foreign amount and rate%';
    if not ok then raise exception 'FAIL I: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL I: a line with no remittance in its narration was booked in USD'; end if;
  raise notice 'G-I PASS: forged rate, made-up currency and plain narration refused';

  -- J. no LUT, then last year's LUT.
  update public.tenants set lut_number = null, lut_valid_upto = null where id = 'dddddddd-0000-0000-0000-000000244001';
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244001', c_cust,
              c_line, false, null, null, 'yearly', null, 'USD', 93.6, 1024);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'No LUT for FY 2026-27 on file%Settings%';
    if not ok then raise exception 'FAIL J: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL J: an export sale at 0%% GST was booked with no LUT'; end if;
  update public.tenants set lut_number = 'AD070425000999X', lut_valid_upto = '2026-03-31' where id = 'dddddddd-0000-0000-0000-000000244001';
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244001', c_cust,
              c_line, false, null, null, 'yearly', null, 'USD', 93.6, 1024);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'No LUT for FY 2026-27 on file%';
    if not ok then raise exception 'FAIL J2: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL J2: last year''s LUT accepted for an FY 2026-27 receipt'; end if;

  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000244001') is not null then
    raise exception 'FAIL G-J: a refused line was reconciled';
  end if;
  select count(*) into n from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000244001';
  if n <> 0 then raise exception 'FAIL G-J: % quotes left behind by refused sales', n; end if;
  raise notice 'J PASS: no LUT / last year''s LUT refused; nothing booked';

  -- K. this year's LUT → booked at the narration's values.
  update public.tenants set lut_number = 'AD070426000123X', lut_valid_upto = '2027-03-31' where id = 'dddddddd-0000-0000-0000-000000244001';
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244001', c_cust,
         c_line, false, null, null, 'yearly', null, 'usd', 93.6, 1024);
  select currency, exchange_rate, tax_rate into q from public.quotes where id = r->>'quote_id';
  if q.currency <> 'USD' or q.exchange_rate <> 93.6 or q.tax_rate <> 0 then
    raise exception 'FAIL K: quote is % % GST %', q.currency, q.exchange_rate, q.tax_rate;
  end if;
  select currency, fx_rate into i from public.invoices where id = r->>'invoice_id';
  if i.currency is distinct from 'USD' or i.fx_rate is distinct from 93.6 then
    raise exception 'FAIL K: invoice is % %', i.currency, i.fx_rate;
  end if;
  if (r->>'foreign_amount')::numeric <> 1024 or (r->>'fx_invoices')::int <> 1 then raise exception 'FAIL K: result %', r; end if;
  raise notice 'K PASS: booked in USD 1024 @ 93.6 under this year''s LUT';
end $$;

select 'R-2440 fx sale trusts the bank narration + LUT: ALL PASS' as result;

rollback;
