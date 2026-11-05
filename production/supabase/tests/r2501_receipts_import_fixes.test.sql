-- R-2501 follow-up (independent review v9): voucher numbers (Zoho's own, else the payment date's FY
-- series; holder quote numbered + dated on the payment date; Record payment by hand keeps today's);
-- an invoice with a quote cannot use the quote-less path; 2b (a same-day line already reconciled is
-- refused even when a free line exists; a hand receipt of the same money on the invoice is refused);
-- 2c (the only line that day is taken only when it names the customer); the ₹1 rounding rupee is a
-- round-off on the bank line, not a ₹1 advance; TDS gross = what the payment settles; undo
-- (remove_zoho_fy_receipts_import: owner only, refused once touched, otherwise takes everything back).
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('c2501000-0000-0000-0000-0000000000a1', 'r2501f-owner@example.test'),
  ('c2501000-0000-0000-0000-0000000000a2', 'r2501f-acct@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('c2501000-0000-0000-0000-0000000000f0', 'R2501F T', 'r2501f@example.test', '07', '07AAACR2501F1Z5', 'R251F');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2501000-0000-0000-0000-0000000000a1', 'c2501000-0000-0000-0000-0000000000f0', 'r2501f-owner@example.test', 'Owner', 'owner', true),
  ('c2501000-0000-0000-0000-0000000000a2', 'c2501000-0000-0000-0000-0000000000f0', 'r2501f-acct@example.test', 'Acct', 'accountant', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'c2501000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('c2501000-0000-0000-0000-0000000000c1', 'c2501000-0000-0000-0000-0000000000f0', 'Acmewidget Private Limited', '29AAACR2501G1Z5', '29', 'India'),
  ('c2501000-0000-0000-0000-0000000000c2', 'c2501000-0000-0000-0000-0000000000f0', 'Zenithcorp Traders', '07AAACR2501H1Z5', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('c2501000-0000-0000-0000-0000000000d1', 'c2501000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');

-- An ordinary invoice WITH a quote (the negative case: never the quote-less path).
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
values ('R251F-QI', 'c2501000-0000-0000-0000-0000000000f0', 'Acmewidget', 'c2501000-0000-0000-0000-0000000000c1', 1180, 1180, 1000, '2025-06-01', null);
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
values ('Q-R251F-QI', 'c2501000-0000-0000-0000-0000000000f0', null, 'c2501000-0000-0000-0000-0000000000c1', 'Acmewidget', 1180, 1000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R251F-QI');
update public.invoices set quote_id = 'Q-R251F-QI' where id = 'R251F-QI';

create function pg_temp.s(num text, d text, taxable int, tax int, head text, pos text)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', pos, 'head', head, 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'c2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', v.z, v.n, v.d::date, 'sent', pg_temp.s(v.n, v.d, v.tx, v.tax, v.h, v.pos), now()
  from (values
    ('zi1', 'INV/25-26/F01', '2025-05-10', 10000, 1800, 'igst', '29'),
    ('zi2', 'INV/25-26/F02', '2025-06-05', 5000, 900, 'igst', '29'),
    ('zi3', 'INV/25-26/F03', '2025-06-01', 2000, 360, 'cgst_sgst', '07'),
    ('zi4', 'INV/25-26/F04', '2025-07-01', 2000, 360, 'igst', '29'),
    ('zi5', 'INV/25-26/F05', '2025-08-01', 1000, 180, 'igst', '29'),
    ('zi6', 'INV/25-26/F06', '2025-08-02', 1000, 180, 'igst', '29'),
    ('zi7', 'INV/25-26/F07', '2025-09-01', 1000, 180, 'cgst_sgst', '07')) v(z, n, d, tx, tax, h, pos);

create function pg_temp.pay(num text, d text, ref text, paise bigint, excess int, lines jsonb)
returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', num, 'number', num, 'date', d, 'status', '', 'zohoCustomerId', 'zc', 'customerName', 'Buyer',
    'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', ref, 'depositAccountId', 'za', 'depositAccountName', 'HDFC 4523',
    'amount', round(paise / 100.0)::int, 'receivedPaise', paise, 'lines', lines, 'excess', excess,
    'tds', coalesce((select sum((l->>'tds')::int) from jsonb_array_elements(lines) l), 0), 'problems', '[]'::jsonb);
$f$;
create function pg_temp.l(zid text, num text, settle int, tds int default 0) returns jsonb language sql as $f$
  select jsonb_build_object('zohoInvoiceId', zid, 'invoiceNumber', num, 'settle', settle, 'tds', tds);
$f$;
-- Zoho payment ids double as their numbers here; pN has NO Zoho number.
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  -- pA (PMT-0042): INV-F01 in full with ₹1,000 TDS — its UTR line is in
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-0042', 'PMT-0042', '2025-06-11', '',
     pg_temp.pay('PMT-0042', '2025-06-11', 'FIXUTR000001', 1080000, 0, jsonb_build_array(pg_temp.l('zi1', 'INV/25-26/F01', 11800, 1000))), now()),
  -- pT: INV-F03 (Zenithcorp); the same money that day was already reconciled by hand, AND a free line of it sits 2 days later
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-T', 'PMT-T', '2025-06-12', '',
     pg_temp.pay('PMT-T', '2025-06-12', 'FIXUTRTTTT02', 236000, 0, jsonb_build_array(pg_temp.l('zi3', 'INV/25-26/F03', 2360))), now()),
  -- pM: ₹1,180 on INV-F04 — a hand receipt of ₹1,180 on it already exists (other reference)
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-M', 'PMT-M', '2025-07-03', '',
     pg_temp.pay('PMT-M', '2025-07-03', 'FIXUTRMMMM03', 118000, 0, jsonb_build_array(pg_temp.l('zi4', 'INV/25-26/F04', 1180))), now()),
  -- pC: half of INV-F02, no UTR; the only line that day names ANOTHER customer → left unmatched
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-C', 'PMT-C', '2025-06-20', '',
     pg_temp.pay('PMT-C', '2025-06-20', '', 295000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/F02', 2950))), now()),
  -- pD: the other half + ₹1 rounding, no UTR; the only line that day names the customer → matched, ₹1 round-off
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-D', 'PMT-D', '2025-06-21', '',
     pg_temp.pay('PMT-D', '2025-06-21', '', 295100, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/F02', 2951))), now()),
  -- pV (PMT-0050): INV-F05 + INV-F06 + ₹100 advance → vouchers PMT-0050, -2, -3; quote on the payment date
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-0050', 'PMT-0050', '2025-08-10', '',
     pg_temp.pay('PMT-0050', '2025-08-10', 'FIXUTRVVVV05', 246000, 100,
       jsonb_build_array(pg_temp.l('zi5', 'INV/25-26/F05', 1180), pg_temp.l('zi6', 'INV/25-26/F06', 1180))), now());
-- pN: no Zoho number at all → the app series of the payment date's FY
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('c2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'zpN', '', '2025-09-05', '',
     pg_temp.pay('', '2025-09-05', 'FIXUTRNNNN06', 118000, 0, jsonb_build_array(pg_temp.l('zi7', 'INV/25-26/F07', 1180))), now());

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('c2501000-0000-0000-0000-0000000000e1', 'c2501000-0000-0000-0000-0000000000f0', 'c2501000-0000-0000-0000-0000000000d1', '2025-06-11', 'NEFT CR-FIXUTR000001-ACMEWIDGET', 0, 10800, 'FIXUTR000001', 'manual'),
  ('c2501000-0000-0000-0000-0000000000e2', 'c2501000-0000-0000-0000-0000000000f0', 'c2501000-0000-0000-0000-0000000000d1', '2025-06-12', 'NEFT CR-ZENITHCORP', 0, 2360, '000000000000000', 'manual'),
  ('c2501000-0000-0000-0000-0000000000e3', 'c2501000-0000-0000-0000-0000000000f0', 'c2501000-0000-0000-0000-0000000000d1', '2025-06-14', 'NEFT CR-ZENITHCORP AGAIN', 0, 2360, '000000000000000', 'manual'),
  ('c2501000-0000-0000-0000-0000000000e4', 'c2501000-0000-0000-0000-0000000000f0', 'c2501000-0000-0000-0000-0000000000d1', '2025-06-20', 'NEFT CR-ZENITHCORP TRADERS', 0, 2950, '000000000000000', 'manual'),
  ('c2501000-0000-0000-0000-0000000000e5', 'c2501000-0000-0000-0000-0000000000f0', 'c2501000-0000-0000-0000-0000000000d1', '2025-06-21', 'NEFT CR-ACMEWIDGET PVT', 0, 2951, '000000000000000', 'manual');
-- pT's money that day was reconciled by hand (e.g. kept as an advance on the Reconcile sheet)
update public.bank_transactions set matched_to_type = 'manual', matched_at = now(), match_confidence = 'manual'
 where id = 'c2501000-0000-0000-0000-0000000000e2';

-- 0. An invoice with a quote never takes a quote-less receipt, and no invoice can be tagged as a Zoho sale afterwards
do $$
begin
  begin
    insert into public.payments (tenant_id, quote_id, invoice_id, customer_id, amount, method, reference, status, received_at)
    values ('c2501000-0000-0000-0000-0000000000f0', null, 'R251F-QI', 'c2501000-0000-0000-0000-0000000000c1', 1180, 'bank_transfer', 'NEGQI0001', 'received', now());
    raise exception 'FAIL 0a: a quote-less receipt went onto an invoice with a quote';
  exception when check_violation then null;
  end;
  begin
    insert into public.payments (tenant_id, quote_id, invoice_id, customer_id, amount, method, reference, status, received_at)
    values ('c2501000-0000-0000-0000-0000000000f0', 'Q-R251F-QI', 'R251F-QI', 'c2501000-0000-0000-0000-0000000000c1', 1180, 'bank_transfer', 'NEGQI0002', 'received', now());
    raise exception 'FAIL 0b: a receipt carried both its quote and the invoice';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set zoho_invoice_id = 'zfake' where id = 'R251F-QI';
    raise exception 'FAIL 0c: an invoice with a quote was tagged as a Zoho sale';
  exception when check_violation then null;
  end;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', z, 'bank_account_id', 'c2501000-0000-0000-0000-0000000000d1'))
    from unnest(array['PMT-0042', 'PMT-T', 'PMT-M', 'PMT-C', 'PMT-D', 'PMT-0050', 'zpN']) z;
$f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.picks() to authenticated;

set local role authenticated;

do $$
declare
  t constant uuid := 'c2501000-0000-0000-0000-0000000000f0';
  r jsonb;
  reasons text;
  v_batch uuid;
  v_q record;
begin
  perform pg_temp.as_user('c2501000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', z,
          'customer_id', case when z in ('zi3', 'zi7') then 'c2501000-0000-0000-0000-0000000000c2' else 'c2501000-0000-0000-0000-0000000000c1' end))
        from unnest(array['zi1', 'zi2', 'zi3', 'zi4', 'zi5', 'zi6', 'zi7']) z), false);
  if (r->>'imported')::int <> 7 then raise exception 'SETUP: sales %', r; end if;

  -- a hand receipt (Record payment) on INV-F04: today's series, as before
  r := public.record_multi_invoice_payment('c2501000-0000-0000-0000-0000000000c1', '2025-07-02', 'bank_transfer', null,
         'HANDREF123', 1180, jsonb_build_array(jsonb_build_object('invoice_id', 'INV/25-26/F04', 'amount', 1180)), false, null);
  if (select receipt_voucher_no from public.payments where tenant_id = t and reference = 'HANDREF123')
       not like '%-' || right(public.indian_fiscal_year(public.ist_today()), 2) || '-%' then
    raise exception 'FAIL 1: a hand receipt left today''s series: %', (select receipt_voucher_no from public.payments where tenant_id = t and reference = 'HANDREF123');
  end if;

  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  select string_agg((s->>'zoho_payment_id') || ': ' || (s->>'reason'), E'\n' order by s->>'zoho_payment_id') into reasons
    from jsonb_array_elements(r->'skipped') s;
  v_batch := (r->>'batch_id')::uuid;

  -- 2b: the same-day line was reconciled by hand → refused although a free line of that money sits 2 days later
  if coalesce(reasons, '') not like '%PMT-T: Its bank line (12 Jun 2025, ₹2360.00) is already reconciled as manual%'
     or exists (select 1 from public.bank_transactions where id = 'c2501000-0000-0000-0000-0000000000e3' and matched_to_type is not null) then
    raise exception 'FAIL 2: same-day reconciled line not refused:%', E'\n' || coalesce(reasons, '(none)');
  end if;
  -- 2b: a hand receipt of the same money on the invoice → refused (other reference)
  if coalesce(reasons, '') not like '%PMT-M: INV/25-26/F04 already has a ₹1180 receipt of 02 Jul 2025 that this import did not make%' then
    raise exception 'FAIL 3: hand receipt not detected:%', E'\n' || coalesce(reasons, '(none)');
  end if;
  if (r->>'imported')::int <> 5 then raise exception 'FAIL 3b: imported %', r; end if;

  -- 2c: pC's only line that day names Zenithcorp, not Acmewidget → left unmatched
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'PMT-C') is not null
     or exists (select 1 from public.bank_transactions where id = 'c2501000-0000-0000-0000-0000000000e4' and matched_to_type is not null) then
    raise exception 'FAIL 4: another customer''s line was taken';
  end if;
  -- 2c: pD's only line that day names Acmewidget → matched; the ₹1 rounding is a round-off, not an advance
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'PMT-D') is distinct from 'c2501000-0000-0000-0000-0000000000e5'::uuid
     or (select amount from public.bank_receipt_round_offs where bank_txn_id = 'c2501000-0000-0000-0000-0000000000e5') is distinct from -1
     or (select status::text from public.invoices where tenant_id = t and zoho_invoice_id = 'zi2') <> 'paid'
     or exists (select 1 from public.customer_credits c where c.tenant_id = t and c.amount = 1) then
    raise exception 'FAIL 5: pD match / round-off';
  end if;

  -- vouchers: Zoho's number; -2 / -3 for the same Zoho payment's other receipt + advance
  if (select receipt_voucher_no from public.payments where tenant_id = t and reference = 'FIXUTR000001') <> 'PMT-0042'
     or (select array_agg(receipt_voucher_no order by receipt_voucher_no) from public.payments where tenant_id = t and reference = 'FIXUTRVVVV05')
          <> array['PMT-0050', 'PMT-0050-2', 'PMT-0050-3'] then
    raise exception 'FAIL 6: Zoho voucher numbers %', (select array_agg(receipt_voucher_no) from public.payments where tenant_id = t and reference like 'FIXUTR%');
  end if;
  -- no Zoho number: the app series of the PAYMENT date (FY 2025-26), not today's
  if (select receipt_voucher_no from public.payments where tenant_id = t and reference = 'FIXUTRNNNN06') not like '%-26-%' then
    raise exception 'FAIL 7: voucher without a Zoho number %', (select receipt_voucher_no from public.payments where tenant_id = t and reference = 'FIXUTRNNNN06');
  end if;
  -- the advance's holder quote: numbered in the payment date's FY series, created on the payment date
  select q.id, q.created_date into v_q from public.quotes q
   join public.payments p on p.quote_id = q.id and p.tenant_id = q.tenant_id
   where q.tenant_id = t and p.reference = 'FIXUTRVVVV05';
  if v_q.id not like '%-26-%' or v_q.created_date <> '2025-08-10' then
    raise exception 'FAIL 8: holder quote % %', v_q.id, v_q.created_date;
  end if;
  -- TDS gross = what pA settles on the invoice
  if not exists (select 1 from public.tds_receivable x where x.tenant_id = t and x.tds_amount = 1000 and x.gross_amount = 11800) then
    raise exception 'FAIL 9: TDS gross';
  end if;

  -- 10. undo: the accountant is refused; touched (TDS certificate in) refused
  perform pg_temp.as_user('c2501000-0000-0000-0000-0000000000a2');
  begin
    perform public.remove_zoho_fy_receipts_import(v_batch, 'wrong account');
    raise exception 'FAIL 10a: accountant removed';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.as_user('c2501000-0000-0000-0000-0000000000a1');
end $$;

reset role;
update public.tds_receivable set status = 'cert_received' where tenant_id = 'c2501000-0000-0000-0000-0000000000f0' and tds_amount = 1000;
set local role authenticated;
do $$
declare v_batch uuid := (select id from public.zoho_fy_import_batches where tenant_id = 'c2501000-0000-0000-0000-0000000000f0' and kind = 'customerpayments');
begin
  perform pg_temp.as_user('c2501000-0000-0000-0000-0000000000a1');
  begin
    perform public.remove_zoho_fy_receipts_import(v_batch, 'wrong account');
    raise exception 'FAIL 10b: removed although its TDS certificate came in';
  exception when others then
    if sqlerrm not like '%used since: TDS on INV/25-26/F01 is cert_received%' then raise exception 'FAIL 10b: %', sqlerrm; end if;
  end;
end $$;

reset role;
update public.tds_receivable set status = 'pending_cert' where tenant_id = 'c2501000-0000-0000-0000-0000000000f0' and tds_amount = 1000;
set local role authenticated;
do $$
declare
  t constant uuid := 'c2501000-0000-0000-0000-0000000000f0';
  v_batch uuid := (select id from public.zoho_fy_import_batches where tenant_id = t and kind = 'customerpayments');
  r jsonb;
begin
  perform pg_temp.as_user('c2501000-0000-0000-0000-0000000000a1');
  r := public.remove_zoho_fy_receipts_import(v_batch, 'wrong account');
  if (r->>'removed')::int <> 5 then raise exception 'FAIL 11: removed %', r; end if;
  if exists (select 1 from public.payments where tenant_id = t and reference like 'FIXUTR%')
     or exists (select 1 from public.zoho_fy_receipts where tenant_id = t)
     or exists (select 1 from public.tds_receivable where tenant_id = t)
     or exists (select 1 from public.customer_credits where tenant_id = t)
     or exists (select 1 from public.quotes where tenant_id = t and plan = 'Advance on account')
     or exists (select 1 from public.bank_transactions where tenant_id = t and matched_to_type = 'payment')
     or exists (select 1 from public.bank_receipt_round_offs where tenant_id = t) then
    raise exception 'FAIL 11b: something stayed after the undo';
  end if;
  -- the invoices are back to unpaid (the hand receipt on INV-F04 stays)
  if (select paid_amount from public.invoices where tenant_id = t and zoho_invoice_id = 'zi1') <> 0
     or (select paid_amount from public.invoices where tenant_id = t and zoho_invoice_id = 'zi4') <> 1180
     or (select removed_at from public.zoho_fy_import_batches where id = v_batch) is null then
    raise exception 'FAIL 11c: invoices / batch after the undo';
  end if;
  -- the hand-reconciled line is untouched; a second undo is refused
  if (select matched_to_type from public.bank_transactions where id = 'c2501000-0000-0000-0000-0000000000e2') <> 'manual' then
    raise exception 'FAIL 11d: a hand-reconciled line was un-reconciled';
  end if;
  begin
    perform public.remove_zoho_fy_receipts_import(v_batch, 'again');
    raise exception 'FAIL 11e: removed twice';
  exception when others then
    if sqlerrm not like '%already removed%' then raise exception 'FAIL 11e: %', sqlerrm; end if;
  end;
  -- and it can be imported again (idempotency key freed)
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), true);
  if (r->>'imported')::int <> 5 then raise exception 'FAIL 12: re-import after undo %', r; end if;
end $$;

reset role;
select 'R-2501 follow-up (vouchers, 2b/2c, round-off, TDS gross, undo): all checks passed' as result;
rollback;
