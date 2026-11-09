-- R-2621 (9 Nov 2026, p0 money): no NEW sale from a bank line of a GST-filed month. Migration
-- 20261109052458_r2621_gst_filed_no_new_sale. Self-asserting, ONE transaction, rolled back.
-- RED without the migration (set_gst_filed_through does not exist; A's new sale is booked).
--
--   A. GST filed up to Sep 2026 (owner, stored 30 Sep) → a bank line of 8 Apr 2026: reconcile_bank_credit_new_sale
--      (10 and 11 args), reconcile_bank_credit_split with a new sale, and a below-cost sale (park for approval)
--      are all refused with "GST for Apr 2026 is already filed …"; the line stays unmatched, no quote is made.
--   B. A bank line of 5 Oct 2026 (open month) → the new sale is booked as before.
--   C. An imported Zoho sale (zoho_invoice_id + its Zoho number) is still PAID from a filed-month line
--      (bank_credit_pay_item — no new sale, no GST change).
--   D. The one rule gst_month_filed: books lock, compliance_log gst_gstr1 by month and by FY quarter (QRMP),
--      month_close_checks gstr1_filed — each counts; an unmarked month is open; gst_filed_days picks the
--      filed days; a signed-in login cannot call the helpers.
--   E. set_gst_filed_through: not the owner → 42501; a month not ended → 22023; a direct table write → 42501;
--      NULL clears; each change one activity_log row.

begin;

insert into auth.users (id, email) values
  ('b2621000-0000-0000-0000-0000000000a1', 'r2621-owner@example.test'),
  ('b2621000-0000-0000-0000-0000000000a2', 'r2621-acct@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2621000-0000-0000-0000-0000000000f0', 'R2621 T', 'r2621@example.test', '07', '07AAACR2621A1Z5', 'R2621', 'Test street, Delhi'),
  ('b2621000-0000-0000-0000-0000000000f1', 'R2621 Q', 'r2621q@example.test', '07', '07AAACR2621B1Z5', 'R2621Q', 'Test street, Delhi');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2621000-0000-0000-0000-0000000000a1', 'b2621000-0000-0000-0000-0000000000f0', 'r2621-owner@example.test', 'Owner', 'owner', true),
  ('b2621000-0000-0000-0000-0000000000a2', 'b2621000-0000-0000-0000-0000000000f0', 'r2621-acct@example.test', 'Acct', 'accountant', true);

insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('b2621000-0000-0000-0000-0000000000c1', 'b2621000-0000-0000-0000-0000000000f0', 'R2621 Buyer', '07', 'India', 'r2621buyer.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('b2621000-0000-0000-0000-0000000000d1', 'b2621000-0000-0000-0000-0000000000f0', 'Current', 'HDFC');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2621000-0000-0000-0000-0000000000e1', 'b2621000-0000-0000-0000-0000000000f0', 'b2621000-0000-0000-0000-0000000000d1', '2026-04-08', 'NEFT CR R2621 A', 0, 1180, 'R2621UTR1', 'manual'),
  ('b2621000-0000-0000-0000-0000000000e2', 'b2621000-0000-0000-0000-0000000000f0', 'b2621000-0000-0000-0000-0000000000d1', '2026-10-05', 'NEFT CR R2621 B', 0, 1180, 'R2621UTR2', 'manual'),
  ('b2621000-0000-0000-0000-0000000000e3', 'b2621000-0000-0000-0000-0000000000f0', 'b2621000-0000-0000-0000-0000000000d1', '2026-04-09', 'NEFT CR R2621 C', 0, 1180, 'R2621UTR3', 'manual'),
  ('b2621000-0000-0000-0000-0000000000e4', 'b2621000-0000-0000-0000-0000000000f0', 'b2621000-0000-0000-0000-0000000000d1', '2026-04-10', 'NEFT CR R2621 D', 0, 944, 'R2621UTR4', 'manual'),
  ('b2621000-0000-0000-0000-0000000000e5', 'b2621000-0000-0000-0000-0000000000f0', 'b2621000-0000-0000-0000-0000000000d1', '2025-11-20', 'NEFT CR R2621 E', 0, 10160, 'R2621UTR5', 'manual');

-- C: an FY 2025-26 sale imported from Zoho through R-2499's own import (zoho_invoice_id, its Zoho number, no quote).
update public.tenants set books_start_date = '2025-04-01' where id = 'b2621000-0000-0000-0000-0000000000f0';
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2621000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zr2621', 'INV/25-26/R2621', '2025-11-15', 'sent',
   jsonb_build_object('number', 'INV/25-26/R2621', 'date', '2025-11-15', 'dueDate', '2025-11-15', 'status', 'sent', 'customerName', 'Buyer',
     'gstin', '', 'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR', 'fxRate', null, 'taxable', 8610, 'tax', 1550, 'amount', 10160,
     'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
     'lines', jsonb_build_array(jsonb_build_object('name', 'R2621 Seat', 'hsn', '998315', 'qty', 1, 'rate', 8610, 'taxable', 8610))), now());

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.quotes() returns bigint language sql as $f$
  select count(*) from public.quotes where tenant_id = 'b2621000-0000-0000-0000-0000000000f0' $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.quotes() to authenticated;

set local role authenticated;

select pg_temp.as_user('b2621000-0000-0000-0000-0000000000a1');
do $$
declare r jsonb;
begin
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'zr2621', 'customer_id', 'b2621000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 1 then raise exception 'SETUP: sales import %', r; end if;
end $$;

-- ── E (first part). The owner sets the month; others are refused ─────────────────────────────────
select pg_temp.as_user('b2621000-0000-0000-0000-0000000000a2');
do $$
declare ok boolean := false;
begin
  begin
    perform public.set_gst_filed_through('2026-09-15');
  exception when sqlstate '42501' then ok := true;
  end;
  if not ok then raise exception 'FAIL E: an accountant set the GST filed month'; end if;
  raise notice 'PASS E1: only the owner sets the GST filed month';
end $$;

select pg_temp.as_user('b2621000-0000-0000-0000-0000000000a1');
do $$
declare ok boolean := false; v date; v_msg text;
begin
  begin
    perform public.set_gst_filed_through(public.ist_today());
  exception when sqlstate '22023' then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like '%has not ended%' then raise exception 'FAIL E: the current month was accepted (%)', v_msg; end if;
  v := public.set_gst_filed_through('2026-09-15');
  if v <> '2026-09-30' then raise exception 'FAIL E: stored % (want 30 Sep 2026)', v; end if;
  ok := false;
  begin
    update public.tenants set gst_filed_through = '2026-10-31' where id = 'b2621000-0000-0000-0000-0000000000f0';
  exception when sqlstate '42501' then ok := true;
  end;
  if not ok then raise exception 'FAIL E: a direct table write changed the GST filed month'; end if;
  raise notice 'PASS E2: a month not ended is refused; Sep 2026 stored as 30 Sep; a direct write is refused';
end $$;

-- ── A. Filed month: every new-sale path is refused, nothing written ──────────────────────────────
do $$
declare
  c_line constant jsonb := '[{"item_id":null,"name":"Setup","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}]';
  c_below constant jsonb := '[{"item_id":null,"name":"Seat","qty":1,"rate":800,"cost":1000,"commitment":"one_time"}]';
  v_q0 bigint := pg_temp.quotes(); v_msg text; ok boolean;
begin
  -- A1: 10 args
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('b2621000-0000-0000-0000-0000000000e1', 'b2621000-0000-0000-0000-0000000000c1',
              c_line, false, null, null, 0, null, null, 'yearly');
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Apr 2026 is already filed, so a new sale on 8 Apr 2026 would change a filed return.%' then
    raise exception 'FAIL A1: new sale on a filed month not refused (%)', v_msg; end if;
  -- A2: 11 args (Zoho number)
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('b2621000-0000-0000-0000-0000000000e1', 'b2621000-0000-0000-0000-0000000000c1',
              c_line, false, null, null, 0, null, null, 'yearly', 'INV/26-27/R2621');
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Apr 2026 is already filed%' then raise exception 'FAIL A2: 11-arg new sale not refused (%)', v_msg; end if;
  -- A3: split with a new sale
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('b2621000-0000-0000-0000-0000000000e3', 'b2621000-0000-0000-0000-0000000000c1',
              '[]'::jsonb, jsonb_build_object('lines', c_line, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 1180), null);
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Apr 2026 is already filed%' then raise exception 'FAIL A3: split new sale not refused (%)', v_msg; end if;
  -- A4: below cost → would park a quote for approval
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('b2621000-0000-0000-0000-0000000000e4', 'b2621000-0000-0000-0000-0000000000c1',
              c_below, false, null, null, 0, null, null, 'yearly');
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Apr 2026 is already filed%' then raise exception 'FAIL A4: below-cost park not refused (%)', v_msg; end if;

  if pg_temp.quotes() <> v_q0 then raise exception 'FAIL A: % quotes made by refused sales', pg_temp.quotes() - v_q0; end if;
  if exists (select 1 from public.bank_transactions where id in ('b2621000-0000-0000-0000-0000000000e1', 'b2621000-0000-0000-0000-0000000000e3',
             'b2621000-0000-0000-0000-0000000000e4') and matched_to_type is not null) then
    raise exception 'FAIL A: a refused line was reconciled'; end if;
  raise notice 'PASS A: new sale (10/11 args), split sale and below-cost park on 8-10 Apr 2026 refused — %', v_msg;
end $$;

-- ── B. Open month: as before ─────────────────────────────────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_new_sale('b2621000-0000-0000-0000-0000000000e2', 'b2621000-0000-0000-0000-0000000000c1',
         '[{"item_id":null,"name":"Setup","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}]'::jsonb, false, null, null, 0, null, null, 'yearly');
  if r->>'invoice_id' is null or (select invoice_date from public.invoices where id = r->>'invoice_id') <> '2026-10-05' then
    raise exception 'FAIL B: open-month new sale not booked on the bank date (%)', r; end if;
  raise notice 'PASS B: 5 Oct 2026 (open) → new sale % as before', r->>'invoice_id';
end $$;

-- ── C. Imported Zoho sale is still paid from a filed-month line ──────────────────────────────────
do $$
declare r jsonb; v_inv text := (select id from public.invoices where zoho_invoice_id = 'zr2621');
begin
  r := public.reconcile_bank_credit_to_item('b2621000-0000-0000-0000-0000000000e5', null, v_inv);
  if (select status::text from public.invoices where id = v_inv) <> 'paid'
     or (select taxable_value from public.invoices where id = v_inv) <> 8610 then
    raise exception 'FAIL C: the imported Zoho sale was not paid or its GST moved (%)', r; end if;
  raise notice 'PASS C: 20 Nov 2025 line (filed) pays imported INV/25-26/R2621 — no new sale';
end $$;

-- ── E (rest). Clear + activity log ───────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  if public.set_gst_filed_through(null) is not null then raise exception 'FAIL E: clear did not clear'; end if;
  select count(*) into n from public.activity_log where tenant_id = 'b2621000-0000-0000-0000-0000000000f0' and action = 'gst.filed_through_set';
  if n <> 2 then raise exception 'FAIL E: % activity rows (want 2: set + clear)', n; end if;
  raise notice 'PASS E3: NULL clears; each change logged';
end $$;

-- helpers are not for signed-in logins
do $$
declare ok boolean := false;
begin
  begin
    perform public.gst_month_filed('b2621000-0000-0000-0000-0000000000f0', '2026-04-08');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL D0: a signed-in login can call gst_month_filed'; end if;
end $$;

reset role;

-- ── D. The one rule: every source counts ─────────────────────────────────────────────────────────
insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date) values
  ('b2621000-0000-0000-0000-0000000000f1', 'gst_gstr1', '2026-07', '2026-08-10'),
  ('b2621000-0000-0000-0000-0000000000f1', 'gst_gstr1', '2025-q4', '2026-04-13'),
  ('b2621000-0000-0000-0000-0000000000f1', 'gst_gstr3b', '2026-06', '2026-07-20');
insert into public.month_close_checks (tenant_id, period, key) values
  ('b2621000-0000-0000-0000-0000000000f1', '2026-05', 'gstr1_filed');
update public.tenants set books_locked_until = '2025-12-31' where id = 'b2621000-0000-0000-0000-0000000000f1';

do $$
declare t uuid := 'b2621000-0000-0000-0000-0000000000f1'; v date[];
begin
  if not public.gst_month_filed(t, '2025-12-31') then raise exception 'FAIL D: books lock does not count'; end if;
  if not public.gst_month_filed(t, '2026-02-14') then raise exception 'FAIL D: FY quarter 2025-q4 (Jan-Mar 2026) does not count'; end if;
  if not public.gst_month_filed(t, '2026-05-31') then raise exception 'FAIL D: month close gstr1_filed does not count'; end if;
  if not public.gst_month_filed(t, '2026-07-01') then raise exception 'FAIL D: compliance_log month does not count'; end if;
  if public.gst_month_filed(t, '2026-06-15') then raise exception 'FAIL D: GSTR-3B alone made June filed'; end if;
  if public.gst_month_filed(t, '2026-08-01') then raise exception 'FAIL D: August is open but read as filed'; end if;
  if public.gst_filed_refusal(t, '2026-08-01') is not null then raise exception 'FAIL D: refusal text for an open month'; end if;
  v := public.gst_filed_days(t, array['2026-08-01', '2026-07-09', '2026-06-15', '2026-02-14', '2026-07-09']::date[]);
  if v <> array['2026-02-14', '2026-07-09']::date[] then raise exception 'FAIL D: gst_filed_days %', v; end if;
  raise notice 'PASS D: lock, quarter, month close, compliance month count; 3B alone and open months do not';
end $$;

rollback;
