-- R-2565: FY receipts import — a Razorpay payment Zoho recorded with bank_charges (Razorpay's fee + GST,
-- kept before it settles) is booked: the receipt = the FULL amount on the invoice (invoice fully paid),
-- the fee = ONE Bank Charges expense EXP-RZPFEE-<receipt> (+ payments.gateway_fee), no single bank line
-- (it waits for its Razorpay settlement, R-2099, which then books no second fee). A non-fee payment is
-- unchanged (matched to its own bank line); a forged fee on a non-Razorpay payment / a fee not below the
-- money is refused; a re-import is idempotent; Remove import takes the fee expense back.
-- Staging 7 Nov: 130 of 155 "Razorpay Clearing" payments were refused "book it by hand".
-- Self-asserting; the whole file rolls back. Red without 20261107134000_r2565_razorpay_fee_receipts.sql.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values ('b2565000-0000-0000-0000-0000000000a1', 'r2565-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2565000-0000-0000-0000-0000000000f0', 'R2565 T', 'r2565@example.test', '07', '07AAACR2565A1Z5', 'R2565');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2565000-0000-0000-0000-0000000000a1', 'b2565000-0000-0000-0000-0000000000f0', 'r2565-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2565000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2565000-0000-0000-0000-0000000000c1', 'b2565000-0000-0000-0000-0000000000f0', 'R2565 Buyer', null, '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2565000-0000-0000-0000-0000000000d1', 'b2565000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');
-- Razorpay as a vendor with a Karnataka GSTIN (made up): the fee GST is IGST for a Delhi company.
insert into public.vendors (id, tenant_id, name, gstin) values
  ('b2565000-0000-0000-0000-0000000000e9', 'b2565000-0000-0000-0000-0000000000f0', 'Razorpay Software Pvt Ltd', '29AAACR2565B1Z1');

-- 4 FY sales: 1 = ₹11,800 (paid by Razorpay), 2 = ₹5,000 (NEFT), 3 / 4 = ₹2,360 (refused payments)
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2565000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi' || g, 'INV/25-26/R2565-' || g, date '2025-05-01', 'sent',
  jsonb_build_object('number', 'INV/25-26/R2565-' || g, 'date', '2025-05-01', 'dueDate', '2025-05-01',
    'status', 'sent', 'customerName', 'Buyer', 'gstin', '', 'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR', 'fxRate', null,
    'taxable', t.taxable, 'tax', t.taxable * 18 / 100, 'amount', t.taxable * 118 / 100, 'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', t.taxable, 'taxable', t.taxable))), now()
  from (values (1, 10000), (2, 5000 * 100 / 118), (3, 2000), (4, 2000), (5, 2000), (6, 2000)) as t(g, taxable);
-- sale 2: make it exactly ₹5,000 incl. GST is awkward — use 4237 + 763 = 5000 by the scan's own figures
update public.zoho_fy_scan set payload = payload || jsonb_build_object('taxable', 4237, 'tax', 763, 'amount', 5000,
  'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', 4237, 'taxable', 4237)))
 where tenant_id = 'b2565000-0000-0000-0000-0000000000f0' and kind = 'invoices' and zoho_id = 'zi2';

-- Zoho payments as the R-2565 normaliser stores them
create function pg_temp.pay(zid text, inv text, amt int, fee int, fee_gst int, method text, ref text, via boolean) returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', zid, 'number', 'R2565-' || zid, 'date', '2025-06-10', 'status', '', 'zohoCustomerId', 'zc',
    'customerName', 'Buyer', 'method', method, 'zohoMode', method, 'reference', ref,
    'depositAccountId', 'zrzp', 'depositAccountName', 'Razorpay Clearing', 'amount', amt, 'receivedPaise', amt * 100,
    'lines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', inv, 'invoiceNumber', 'INV/25-26/R2565-' || right(inv, 1), 'settle', amt, 'tds', 0)),
    'excess', 0, 'tds', 0, 'fee', fee, 'feeGst', fee_gst, 'viaSettlement', via, 'problems', '[]'::jsonb);
$f$;
-- p1 Razorpay with fee · p2 NEFT (no Razorpay) · p3 forged fee on a non-Razorpay payment · p4 fee = the money ·
-- p5 Razorpay (UPI through Razorpay Clearing) with NO fee — still waits for its settlement ·
-- p6 the same Razorpay payment id as p1 on another sale — refused (no double receipt)
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p1', 'R2565-p1', '2025-06-10', '', pg_temp.pay('p1', 'zi1', 11800, 278, 42, 'razorpay', 'pay_R2565AAAAAAAA1', true), now()),
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p2', 'R2565-p2', '2025-06-10', '', pg_temp.pay('p2', 'zi2', 5000, 0, 0, 'bank_transfer', 'R2565UTR000002', false), now()),
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p3', 'R2565-p3', '2025-06-10', '', pg_temp.pay('p3', 'zi3', 2360, 50, 8, 'bank_transfer', 'R2565UTR000003', false), now()),
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p4', 'R2565-p4', '2025-06-10', '', pg_temp.pay('p4', 'zi4', 2360, 2360, 360, 'razorpay', 'pay_R2565AAAAAAAA4', true), now()),
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p5', 'R2565-p5', '2025-06-10', '', pg_temp.pay('p5', 'zi5', 2360, 0, 0, 'upi', 'R2565UPI000005', true), now()),
  ('b2565000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p6', 'R2565-p6', '2025-06-10', '', pg_temp.pay('p6', 'zi6', 2360, 47, 7, 'razorpay', 'pay_R2565AAAAAAAA1', true), now());

-- Bank lines: p2's NEFT (matched as before); a line of p1's FULL ₹11,800 carrying its pay_ id — must NOT be
-- taken (Razorpay never sends one payment alone, gross); the Razorpay settlement ₹11,522 (= 11,800 − 278).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2565000-0000-0000-0000-0000000000b2', 'b2565000-0000-0000-0000-0000000000f0', 'b2565000-0000-0000-0000-0000000000d1', '2025-06-10',
   'NEFT CR-R2565UTR000002-R2565 BUYER', 0, 5000, 'R2565UTR000002', 'manual'),
  ('b2565000-0000-0000-0000-0000000000b1', 'b2565000-0000-0000-0000-0000000000f0', 'b2565000-0000-0000-0000-0000000000d1', '2025-06-10',
   'R2565 BUYER pay_R2565AAAAAAAA1', 0, 11800, 'pay_R2565AAAAAAAA1', 'manual'),
  ('b2565000-0000-0000-0000-0000000000b9', 'b2565000-0000-0000-0000-0000000000f0', 'b2565000-0000-0000-0000-0000000000d1', '2025-06-12',
   'NEFT CR-AXIS0000-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR', 0, 11522, 'AXISR2565SETL1', 'manual'),
  -- a ₹2,360 line carrying p5's reference: a Razorpay payment is never matched alone, so it stays free
  ('b2565000-0000-0000-0000-0000000000b5', 'b2565000-0000-0000-0000-0000000000f0', 'b2565000-0000-0000-0000-0000000000d1', '2025-06-10',
   'UPI-R2565UPI000005-R2565 BUYER', 0, 2360, 'R2565UPI000005', 'manual');

create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', 'p' || g, 'bank_account_id', 'b2565000-0000-0000-0000-0000000000d1') order by g)
    from generate_series(1, 6) g;
$f$;
grant execute on function pg_temp.picks() to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', 'b2565000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t constant uuid := 'b2565000-0000-0000-0000-0000000000f0';
  r jsonb;
  n int;
  v_pay uuid;
  v_batch uuid;
  e record;
  inv record;
  why text;
begin
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', 'zi' || g,
         'customer_id', 'b2565000-0000-0000-0000-0000000000c1') order by g) from generate_series(1, 6) g), false);
  if (r->>'imported')::int <> 6 then raise exception 'SETUP: sales import %', r; end if;
  select i.amount, i.net_payable into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1';
  if coalesce(inv.net_payable, inv.amount) <> 11800 then raise exception 'SETUP: sale 1 is %, expected 11800', inv; end if;

  -- 1. Check first (dry run): the fee payment is importable, its fee counted apart; nothing is written
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), true);
  if (r->>'imported')::int <> 3 or (r->>'with_fee')::int <> 1 or (r->>'fee')::int <> 278 or (r->>'received')::int <> 19160 then
    raise exception 'FAIL 1a: check %', r;
  end if;
  select string_agg(x->>'zoho_payment_id' || ': ' || (x->>'reason'), ' | ' order by x->>'zoho_payment_id') into why from jsonb_array_elements(r->'skipped') x;
  if why not like 'p3: %not a Razorpay payment%' or why not like '%p4: %Razorpay fee on this payment could not be booked%'
     or why not like '%p6: Razorpay payment pay_R2565AAAAAAAA1 is already in the app%' then
    raise exception 'FAIL 1b: refusals %', why;
  end if;
  if exists (select 1 from public.expenses x where x.tenant_id = t) or exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t) then
    raise exception 'FAIL 1c: the check wrote something';
  end if;

  -- 2. Import: receipt = the full ₹11,800, invoice paid; fee = ONE Bank Charges expense ₹278 (GST ₹42, IGST)
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 3 or (r->>'fee')::int <> 278 or (r->>'banked')::int <> 1 or (r->>'bank_later')::int <> 2 then
    raise exception 'FAIL 2a: import %', r;
  end if;
  v_batch := (r->>'batch_id')::uuid;
  select i.status::text as status, i.paid_amount, coalesce(i.net_payable, i.amount) as due into inv
    from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1';
  if inv.paid_amount <> 11800 or inv.status <> 'paid' then raise exception 'FAIL 2b: sale 1 %', inv; end if;
  select p.id into v_pay from public.payments p
   where p.tenant_id = t and p.status = 'received' and p.invoice_id = (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1');
  select coalesce(sum(p.amount), 0)::int into n from public.payments p
   where p.tenant_id = t and p.invoice_id = (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1');
  if n <> 11800 then raise exception 'FAIL 2c: receipts on sale 1 = ₹%, expected the full 11800', n; end if;
  select x.* into e from public.expenses x where x.tenant_id = t and x.id = 'EXP-RZPFEE-' || v_pay::text;
  if not found then raise exception 'FAIL 2d: no Razorpay fee expense on the receipt'; end if;
  if e.amount <> 278 or e.gst_paid <> 42 or e.igst <> 42 or e.cgst <> 0 or e.category <> 'Bank Charges'
     or e.vendor_id is distinct from 'b2565000-0000-0000-0000-0000000000e9'::uuid or e.expense_date <> date '2025-06-10' or not e.paid then
    raise exception 'FAIL 2e: fee expense %', row_to_json(e);
  end if;
  select count(*) into n from public.expenses x where x.tenant_id = t;
  if n <> 1 then raise exception 'FAIL 2f: % expenses, expected only the one fee', n; end if;
  if not exists (select 1 from public.payments p where p.id = v_pay and p.gateway_fee = 278 and p.gateway_fee_gst = 42 and p.fee_bearer = 'business') then
    raise exception 'FAIL 2g: the receipt does not carry the fee';
  end if;
  -- no single bank line for the fee payment (not even the ₹11,800 one carrying its pay_ id); the NEFT one is matched as before
  if exists (select 1 from public.bank_transactions b where b.id = 'b2565000-0000-0000-0000-0000000000b1' and b.matched_to_type is not null)
     or exists (select 1 from public.payments p where p.id = v_pay and p.bank_txn_id is not null) then
    raise exception 'FAIL 2h: the Razorpay receipt was matched to a single bank line';
  end if;
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p2'
                  and z.bank_txn_id = 'b2565000-0000-0000-0000-0000000000b2' and z.fee = 0 and z.fee_expense_id is null) then
    raise exception 'FAIL 2i: the NEFT payment is not booked as before';
  end if;
  if exists (select 1 from public.payments p where p.tenant_id = t and p.gateway_fee is not null and p.id <> v_pay) then
    raise exception 'FAIL 2j: a fee landed on a non-Razorpay receipt';
  end if;
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1'
                  and z.fee = 278 and z.fee_gst = 42 and z.fee_expense_id = 'EXP-RZPFEE-' || v_pay::text and z.bank_txn_id is null and z.cash = 11800) then
    raise exception 'FAIL 2k: zoho_fy_receipts row of p1';
  end if;
  -- a Razorpay payment with NO fee also waits for its settlement (its ₹2,360 line carrying the reference stays free)
  if exists (select 1 from public.bank_transactions b where b.id = 'b2565000-0000-0000-0000-0000000000b5' and b.matched_to_type is not null)
     or not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p5'
                     and z.via_settlement and z.bank_txn_id is null and z.fee = 0 and z.fee_expense_id is null) then
    raise exception 'FAIL 2l: the no-fee Razorpay payment was matched alone';
  end if;
  if exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p6') then
    raise exception 'FAIL 2m: the same Razorpay payment was booked twice';
  end if;

  -- 3a. Remove import refuses while the fee expense was changed since the import
  update public.expenses set amount = 300 where tenant_id = t and id = 'EXP-RZPFEE-' || v_pay::text;
  begin
    perform public.remove_zoho_fy_receipts_import(v_batch, 'R-2565 test undo');
    raise exception 'FAIL 3a: Remove import deleted a fee expense changed since the import';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%Razorpay fee expense % was changed after the import%' then raise; end if;
  end;
  update public.expenses set amount = 278 where tenant_id = t and id = 'EXP-RZPFEE-' || v_pay::text;

  -- 3. Remove import takes the fee expense back with the receipts
  r := public.remove_zoho_fy_receipts_import(v_batch, 'R-2565 test undo');
  if exists (select 1 from public.expenses x where x.tenant_id = t) or exists (select 1 from public.payments p where p.tenant_id = t) then
    raise exception 'FAIL 3: Remove import left the fee expense or receipts behind %', r;
  end if;

  -- 4. Import again, then a re-import: idempotent — no second receipt, no second fee, no bank line taken
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 3 then raise exception 'FAIL 4a: import after undo %', r; end if;
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 3 or (r->>'banked')::int <> 0 then raise exception 'FAIL 4b: rerun %', r; end if;
  select count(*) into n from public.expenses x where x.tenant_id = t;
  if n <> 1 then raise exception 'FAIL 4c: % fee expenses after a rerun', n; end if;
  select p.id into v_pay from public.payments p
   where p.tenant_id = t and p.status = 'received' and p.invoice_id = (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1');
  if exists (select 1 from public.bank_transactions b where b.id in ('b2565000-0000-0000-0000-0000000000b1', 'b2565000-0000-0000-0000-0000000000b5') and b.matched_to_type is not null) then
    raise exception 'FAIL 4d: a rerun matched the Razorpay receipt to a single line';
  end if;
  select coalesce(sum(i.paid_amount), 0)::int into n from public.invoices i where i.tenant_id = t and i.zoho_invoice_id in ('zi1', 'zi2');
  if n <> 16800 then raise exception 'FAIL 4e: sales paid ₹%, expected 16800', n; end if;

  -- 5. The Razorpay settlement (R-2099): ₹11,800 − ₹11,522 = ₹278 fee, already booked → no second fee
  r := public.reconcile_razorpay_settlement('b2565000-0000-0000-0000-0000000000b9'::uuid, jsonb_build_object(
         'id', 'setl_R2565SETL01', 'utr', 'AXISR2565SETL1', 'fee_paise', 27800, 'tax_paise', 4200,
         'payments', jsonb_build_array(jsonb_build_object('rzp_id', 'pay_R2565AAAAAAAA1', 'amount_paise', 1180000, 'payment_ids', jsonb_build_array(v_pay))),
         'refunds', '[]'::jsonb));
  if (r->>'fee')::int <> 278 or (r->>'fee_booked_now')::int <> 0 or r->>'fee_expense_id' is not null then
    raise exception 'FAIL 5a: settlement booked a second fee %', r;
  end if;
  select coalesce(sum(x.amount), 0)::int into n from public.expenses x where x.tenant_id = t and x.category = 'Bank Charges';
  if n <> 278 then raise exception 'FAIL 5b: Bank Charges ₹%, expected 278 once', n; end if;
  if not exists (select 1 from public.payments p where p.id = v_pay and p.bank_txn_id = 'b2565000-0000-0000-0000-0000000000b9') then
    raise exception 'FAIL 5c: the receipt is not on its settlement line';
  end if;

  raise notice 'R-2565 Razorpay fee receipts: all checks passed';
end $$;

rollback;
