-- R-2444 (4 Nov 2026): the LUT per financial year, checked on EVERY 0% export path. Migration
-- 20261104014038_r2444_lut_per_fy. Self-asserting, ONE transaction, rolled back. Local/test DB only.
-- Red without the migration (tenant_luts / save_tenant_lut / lut_for do not exist, and the ₹ paths
-- book a 0% export with no LUT).
--
--   A. A company created with the old single LUT (tenants.lut_number + lut_valid_upto 31 Mar 2027)
--      → tenant_luts holds it as FY 2026-27; lut_for finds it for Aug 2026 and not for Mar 2026.
--   B. Quote → invoice (generate_invoice) for a foreign customer at 0% with NO LUT → refused with the
--      FY and the next step (Settings → Company → LUT; RFD-11). The same customer billed WITH GST
--      → issued (the guard never blocks a taxed invoice).
--   C. Find in Zoho / a ₹ sale from a bank line (reconcile_bank_credit_new_sale) for a foreign customer
--      dated 20 Mar 2026 (FY 2025-26) while only the FY 2026-27 LUT is on file → refused; nothing booked.
--   D. FY 2025-26 LUT added in Settings (save_tenant_lut) → the same ₹ sale books; its invoice is
--      dated in FY 2025-26 and lut_for gives the FY 2025-26 ARN (what the PDF prints).
--   E. The USD bank sale (reconcile_bank_credit_new_sale_fx) for an FY 2025-26 receipt books under the
--      FY 2025-26 LUT (R-2440 refused it: its one LUT was FY 2026-27).
--   F. tenants.lut_number mirrors the LATEST FY's LUT (old readers keep working).
--   G. Deleting the FY 2025-26 LUT is refused — export invoices of that FY rely on it.
--   H. A sales user cannot save an LUT.
--   I. An old writer of tenants.lut_number replaces an unused LUT but never drops one invoices rely on.
--   K. A customer in Germany still marked unregistered_business (treatment never updated): the 0%
--      invoice is an export by its country, so it is refused without the LUT too.

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
-- Company 1: has the old single LUT (FY 2026-27). Company 2: no LUT at all.
insert into public.tenants (id, name, email, state_code, doc_code, lut_number, lut_valid_upto) values
  ('dddddddd-0000-0000-0000-000000244401','R2444 Export Co','r2444@example.in','07','R2441','AD070426000123X','2027-03-31'),
  ('dddddddd-0000-0000-0000-000000244402','R2444 No LUT Co','r2444b@example.in','07','R2442',null,null);
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000244401','owner2444@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244402','owner2444b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244403','sales2444@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000244401','dddddddd-0000-0000-0000-000000244401','owner2444@example.in','Owner 2444','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000244402','dddddddd-0000-0000-0000-000000244402','owner2444b@example.in','Owner 2444b','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000244403','dddddddd-0000-0000-0000-000000244401','sales2444@example.in','Sales 2444','sales', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000244401','dddddddd-0000-0000-0000-000000244401','Design Box LLC',null,'United States','designbox2444.example'),
  ('cccccccc-0000-0000-0000-000000244402','dddddddd-0000-0000-0000-000000244402','Ranz International LLC',null,'United Arab Emirates','ranz2444.example');
-- K: entered as an Indian business, later moved abroad — its treatment was never updated.
insert into public.customers (id, tenant_id, name, state_code, country, domain, gst_treatment) values
  ('cccccccc-0000-0000-0000-000000244403','dddddddd-0000-0000-0000-000000244402','Berlin Tools GmbH',null,'Germany','berlin2444.example','unregistered_business');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2444-DE0',  'dddddddd-0000-0000-0000-000000244402', 'cccccccc-0000-0000-0000-000000244403', 'Berlin Tools GmbH',      50000,  50000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2444-EXP0', 'dddddddd-0000-0000-0000-000000244402', 'cccccccc-0000-0000-0000-000000244402', 'Ranz International LLC', 100000, 100000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2444-IGST', 'dddddddd-0000-0000-0000-000000244402', 'cccccccc-0000-0000-0000-000000244402', 'Ranz International LLC', 118000, 100000, 18, 'accepted', 'received', '[]'::jsonb);
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000244401','dddddddd-0000-0000-0000-000000244401','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000244401','dddddddd-0000-0000-0000-000000244401','bbbbbbbb-0000-0000-0000-000000244401','2026-03-20','NEFT CR-CITI0000001-DESIGN BOX LLC',0,93600,null,'manual'),
  ('11111111-0000-0000-0000-000000244402','dddddddd-0000-0000-0000-000000244401','bbbbbbbb-0000-0000-0000-000000244401','2026-03-24','INW 240326I049902623 USD1000.0@85.2',0,85200,null,'manual');

do $$
declare
  c_t1   constant uuid := 'dddddddd-0000-0000-0000-000000244401';
  c_t2   constant uuid := 'dddddddd-0000-0000-0000-000000244402';
  c_cust constant uuid := 'cccccccc-0000-0000-0000-000000244401';
  ok boolean; v_msg text; n int; r jsonb; v_inv text; v_date date; v_rate numeric;
begin
  -- A. the old single LUT moved to its FY.
  select count(*) into n from public.tenant_luts where tenant_id = c_t1 and fy_start = '2026-04-01' and arn = 'AD070426000123X'
     and valid_from = '2026-04-01' and valid_upto = '2027-03-31';
  if n <> 1 then raise exception 'FAIL A: the old LUT is not FY 2026-27 in tenant_luts (% rows)', n; end if;
  if public.lut_for(c_t1, '2026-08-07') is distinct from 'AD070426000123X' then raise exception 'FAIL A: lut_for Aug 2026 = %', public.lut_for(c_t1, '2026-08-07'); end if;
  if public.lut_for(c_t1, '2026-03-20') is not null then raise exception 'FAIL A: FY 2026-27 LUT used for a March 2026 date'; end if;
  raise notice 'A PASS: old LUT is FY 2026-27; lut_for picks by FY';

  -- B. quote → invoice at 0% for a foreign customer, no LUT → refused; with IGST → issued.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000244402","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.generate_invoice('Q-R2444-EXP0');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'No LUT for FY 20__-__ on file%Settings → Company → LUT%RFD-11%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a 0%% export invoice was issued with no LUT'; end if;
  select count(*) into n from public.invoices where tenant_id = c_t2;
  if n <> 0 then raise exception 'FAIL B: % invoices left by the refused export', n; end if;
  select invoice_id into v_inv from public.generate_invoice('Q-R2444-IGST');
  select tax_rate into v_rate from public.invoices where id = v_inv;
  if v_inv is null or v_rate <> 18 then raise exception 'FAIL B: the IGST invoice to a foreign customer was not issued (%, %)', v_inv, v_rate; end if;
  raise notice 'B PASS: 0%% export without LUT refused; same customer with IGST issued';

  -- C. ₹ sale from a bank line (Find in Zoho at the bank rate), FY 2025-26 date, only FY 2026-27 LUT → refused.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000244401","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000244401', c_cust,
              '[{"item_id":null,"name":"Website design","qty":1,"rate":93600,"cost":0,"commitment":"one_time"}]'::jsonb,
              false, null, null, 0, null, null, 'yearly', null);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'No LUT for FY 2025-26 on file%';
    if not ok then raise exception 'FAIL C: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL C: a ₹ export sale of FY 2025-26 was booked at 0%% with no LUT for that year'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000244401') is not null then
    raise exception 'FAIL C: the refused line was reconciled';
  end if;
  raise notice 'C PASS: ₹ export sale refused without the FY 2025-26 LUT';

  -- H. a sales user cannot save an LUT.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000244403","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.save_tenant_lut('2025-04-01', 'AD070425000999X', null, null);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL H: a sales user saved an LUT'; end if;
  raise notice 'H PASS: sales user refused';

  -- D. FY 2025-26 LUT added → the ₹ sale books, invoice in FY 2025-26, ARN of that FY.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000244401","role":"authenticated"}', true);
  r := public.save_tenant_lut('2025-04-01', ' ad070425000999x ', null, null);
  if r->>'arn' <> 'AD070425000999X' or (r->>'valid_upto')::date <> '2026-03-31' then raise exception 'FAIL D: save returned %', r; end if;
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000244401', c_cust,
         '[{"item_id":null,"name":"Website design","qty":1,"rate":93600,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly', null);
  select invoice_date, tax_rate into v_date, v_rate from public.invoices where id = r->>'invoice_id';
  if v_date is null or v_date >= '2026-04-01' or v_rate <> 0 then raise exception 'FAIL D: invoice % dated % at %%%', r->>'invoice_id', v_date, v_rate; end if;
  if public.lut_for(c_t1, v_date) is distinct from 'AD070425000999X' then raise exception 'FAIL D: the invoice''s ARN is %', public.lut_for(c_t1, v_date); end if;
  raise notice 'D PASS: FY 2025-26 ₹ export sale booked under the FY 2025-26 LUT';

  -- E. the USD bank sale for an FY 2025-26 receipt books under the FY 2025-26 LUT.
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000244402', c_cust,
         '[{"item_id":null,"name":"Website design","qty":1,"rate":85200,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 'yearly', null, 'USD', 85.2, 1000);
  if (r->>'fx_invoices')::int <> 1 then raise exception 'FAIL E: result %', r; end if;
  raise notice 'E PASS: FY 2025-26 USD receipt booked with the FY 2025-26 LUT';

  -- F. tenants mirrors the latest FY's LUT.
  if (select lut_number from public.tenants where id = c_t1) is distinct from 'AD070426000123X'
     or (select lut_valid_upto from public.tenants where id = c_t1) is distinct from '2027-03-31' then
    raise exception 'FAIL F: tenants.lut_number is % (expected the FY 2026-27 ARN)', (select lut_number from public.tenants where id = c_t1);
  end if;
  raise notice 'F PASS: tenants mirrors the latest FY';

  -- G. delete of an LUT that issued invoices rely on → refused.
  ok := false;
  begin
    perform public.delete_tenant_lut('2025-04-01');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '2 export invoice(s) of FY 2025-26%';
    if not ok then raise exception 'FAIL G: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL G: an LUT that issued export invoices rely on was deleted'; end if;
  raise notice 'G PASS: delete refused while invoices rely on it';

  -- I. an old writer of tenants.lut_number (old Settings form) cannot drop an LUT invoices rely on.
  update public.tenants set lut_number = 'AD070425000999X', lut_valid_upto = '2026-03-31' where id = c_t1;
  if exists (select 1 from public.tenant_luts where tenant_id = c_t1 and fy_start = '2026-04-01') then
    raise exception 'FAIL I: the old writer''s previous LUT (FY 2026-27, no invoices) was not replaced';
  end if;
  update public.tenants set lut_number = null, lut_valid_upto = null where id = c_t1;
  if public.lut_for(c_t1, '2026-03-20') is distinct from 'AD070425000999X' then
    raise exception 'FAIL I: clearing tenants.lut_number dropped the FY 2025-26 LUT that 2 export invoices rely on';
  end if;
  raise notice 'I PASS: old writer replaces an unused LUT, never one invoices rely on';

  -- K. a customer abroad whose GST treatment was never updated (still unregistered_business): the
  --    0% decision follows the country, so the LUT check does too.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000244402","role":"authenticated"}', true);
  ok := false;
  begin
    perform public.generate_invoice('Q-R2444-DE0');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'No LUT for FY 20__-__ on file%';
    if not ok then raise exception 'FAIL K: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL K: a 0%% invoice to a customer in Germany (treatment not updated) skipped the LUT check'; end if;
  raise notice 'K PASS: country outside India → LUT checked even with an old treatment';
end $$;

select 'R-2444 LUT per FY on every export path: ALL PASS' as result;

rollback;
