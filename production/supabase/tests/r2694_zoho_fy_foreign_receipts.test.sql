-- R-2694 (R-2693 part 2): FY receipts import — a USD Zoho payment on a USD invoice is booked:
--   receipt = the invoice's ₹ at ITS OWN rate (invoice Paid when Zoho settles it in full), exchange
--   gain / loss = receipts − USD × Zoho's rate (EXP-ZFXD-<receipt id>, "Exchange gain / loss (realised)"),
--   Zoho's bank charges × Zoho's rate (EXP-ZFXC-<receipt id>, Bank Charges); the bank line, now or later, is
--   matched to the receipt and the FX is never booked a second time.
--   A. USD 100 invoice booked at ₹83, Zoho payment USD 100 @ 84, no bank line yet → Paid, ₹100 gain once
--   B. its remittance line (USD100.0@84 = ₹8,400) comes later: reconcile_bank_credit_fx_invoice refused
--      (nothing due); Import again matches it to the receipt; the gain is tied to the line, not booked
--      again; un-reconciled → the gain stays (untied); matched again → tied again
--   C. part payment USD 40 @ 84 → ₹3,320 (40 × 83) on the invoice, ₹40 gain, ₹4,980 left due; a USD60
--      remittance paid on that invoice through R-2427 meanwhile → refused (the imported receipt waits for
--      its line); the Zoho payment of the other USD 60 @ 85 → the whole ₹ due, invoice Paid, ₹120 gain,
--      its line matched
--   D. USD 100 @ 84 with Zoho bank charges USD 2: bank got USD 98 = ₹8,232 → matched at import;
--      receipt ₹8,300, gain ₹100, charges ₹168 (8,300 + 100 − 168 = 8,232, no round-off)
--   E. refused: facts read before R-2694 (no per-invoice USD), USD unused (advance), USD on a ₹ invoice,
--      foreign TDS, Zoho's rate more than 25% off the invoice's
--   F. Check first writes nothing; G. Remove import takes the receipts AND the FX rows back
--   H. the 2-cent "whole ₹ due" rule at a fractional rate (₹83.47); Delete payment refused on an imported
--      USD receipt and on an R-2565 Razorpay-fee receipt (Remove import only)
-- Self-asserting; the whole file rolls back. Red without 20261112064956_r2694_zoho_fy_foreign_receipts.sql.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values ('b2694000-0000-0000-0000-0000000000a1', 'r2694-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2694000-0000-0000-0000-0000000000f0', 'R2694 T', 'r2694@example.test', '07', '07AAACR2694A1Z5', 'R2694');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2694000-0000-0000-0000-0000000000a1', 'b2694000-0000-0000-0000-0000000000f0', 'r2694-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2694000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code) values
  ('b2694000-0000-0000-0000-0000000000c1', 'b2694000-0000-0000-0000-0000000000f0', 'R2694 US Buyer', null, null, null,
   'United States', '1 Main St', 'Austin', '78701');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2694000-0000-0000-0000-0000000000d1', 'b2694000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');

-- FY sales from Zoho: zi1..zi4 = USD 100 at ₹83 (₹8,300 = 7,034 + 1,266 IGST), zi5 = a ₹ sale of ₹8,300
create function pg_temp.sale(num text, cur text, fx numeric) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('number', num, 'date', '2025-06-01', 'dueDate', '2025-06-01', 'status', 'sent',
    'customerName', 'R2694 US Buyer', 'gstin', '', 'posStateCode', '96', 'head', 'igst', 'currency', cur, 'fxRate', fx,
    'taxable', 7034, 'tax', 1266, 'amount', 8300, 'roundOff', 0, 'taxRate', 18, 'appGstTreatment', 'overseas',
    'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', 7034, 'taxable', 7034))));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2694000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi' || g, 'INV/25-26/R2694-' || g, date '2025-06-01', 'sent',
       pg_temp.sale('INV/25-26/R2694-' || g, case when g = 5 then 'INR' else 'USD' end, case when g = 5 then null else 83 end), now()
  from generate_series(1, 5) g;
-- zi6 / zi7 = USD 100 at a FRACTIONAL rate ₹83.47 (₹8,347 = 7,074 + 1,273): the 2-cent "whole ₹ due" rule
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2694000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi' || g, 'INV/25-26/R2694-' || g, date '2025-06-01', 'sent',
       pg_temp.sale('INV/25-26/R2694-' || g, 'USD', 83.47) || jsonb_build_object('taxable', 7074, 'tax', 1273, 'amount', 8347,
         'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', 7074, 'taxable', 7074))), now()
  from generate_series(6, 7) g;

-- Zoho USD payments as R-2694's normaliser stores them (₹ = amount at Zoho's rate; per-invoice USD in foreignLines)
create function pg_temp.usd(zid text, dt date, inv text, usd numeric, rate numeric, chg numeric, extra jsonb default '{}') returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', zid, 'number', 'R2694-' || zid, 'date', dt, 'status', '', 'zohoCustomerId', 'zc',
    'customerName', 'R2694 US Buyer', 'method', 'bank_transfer', 'zohoMode', 'Bank Remittance', 'reference', 'R2694REF' || zid,
    'depositAccountId', 'zhdfc', 'depositAccountName', 'HDFC 4523', 'amount', round(usd * rate), 'receivedPaise', round((usd - chg) * rate * 100),
    'lines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', inv, 'invoiceNumber', 'INV/25-26/R2694-' || right(inv, 1), 'settle', round(usd), 'tds', 0)),
    'excess', 0, 'tds', 0, 'fee', 0, 'feeGst', 0, 'viaSettlement', false, 'problems', '[]'::jsonb,
    'currency', 'USD', 'foreignAmount', usd, 'fxRate', rate, 'foreignCharges', chg,
    'foreignLines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', inv, 'invoiceNumber', 'INV/25-26/R2694-' || right(inv, 1), 'foreign', usd))) || extra;
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2694000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', x.zid, 'R2694-' || x.zid, x.dt, '', x.payload, now()
  from (values
    ('p1',  date '2025-06-10', pg_temp.usd('p1',  '2025-06-10', 'zi1', 100, 84, 0)),
    ('p2a', date '2025-06-10', pg_temp.usd('p2a', '2025-06-10', 'zi2', 40, 84, 0)),
    ('p2b', date '2025-06-20', pg_temp.usd('p2b', '2025-06-20', 'zi2', 60, 85, 0)),
    ('p3',  date '2025-06-10', pg_temp.usd('p3',  '2025-06-10', 'zi3', 100, 84, 2)),
    -- E: read by R-2693 part 1 (currency, but no per-invoice USD — its lines are whole dollars), with its problem
    ('p4',  date '2025-06-10', pg_temp.usd('p4',  '2025-06-10', 'zi4', 100, 84, 0)
            - 'foreignLines' - 'foreignCharges'
            || jsonb_build_object('problems', jsonb_build_array('Received in USD in Zoho — foreign-currency payments are not imported yet; book it from its bank line (Banking → the inward USD line → Reconcile, exchange gain / loss there).'))),
    -- the same without the problem (no per-invoice USD) → "read it from Zoho again"
    ('p5',  date '2025-06-10', pg_temp.usd('p5',  '2025-06-10', 'zi4', 100, 84, 0) - 'foreignLines'),
    -- USD 10 unused (an advance in USD)
    ('p6',  date '2025-06-10', pg_temp.usd('p6',  '2025-06-10', 'zi4', 100, 84, 0, '{"foreignAmount": 110}')),
    -- USD money on a ₹ invoice
    ('p7',  date '2025-06-10', pg_temp.usd('p7',  '2025-06-10', 'zi5', 100, 84, 0)),
    -- foreign TDS
    -- Zoho's rate 120 vs the invoice's 83 (> 25% off — probably not this invoice's money)
    ('p9',  date '2025-06-10', pg_temp.usd('p9',  '2025-06-10', 'zi4', 100, 120, 0)),
    -- H: the 2-cent rule at ₹83.47 — USD 99.99 (₹8,346 at its rate, ₹1 off the ₹8,347 due: within
    --    2 cents = ceil(83.47 × 0.02) = ₹2) settles it in full; USD 99.97 (₹8,344, ₹3 off) is a part payment
    ('p10', date '2025-06-10', pg_temp.usd('p10', '2025-06-10', 'zi6', 99.99, 84, 0)),
    ('p11', date '2025-06-10', pg_temp.usd('p11', '2025-06-10', 'zi7', 99.97, 84, 0)),
    -- H: an INR Razorpay payment with its fee (R-2565) on the ₹ sale zi5
    ('p12', date '2025-06-10', jsonb_build_object('zohoId', 'p12', 'number', 'R2694-p12', 'date', '2025-06-10', 'status', '', 'zohoCustomerId', 'zc',
      'customerName', 'R2694 US Buyer', 'method', 'razorpay', 'zohoMode', 'Razorpay', 'reference', 'pay_R2694AAAAAAA12',
      'depositAccountId', 'zrzp', 'depositAccountName', 'Razorpay Clearing', 'amount', 8300, 'receivedPaise', 830000,
      'lines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', 'zi5', 'invoiceNumber', 'INV/25-26/R2694-5', 'settle', 8300, 'tds', 0)),
      'excess', 0, 'tds', 0, 'fee', 196, 'feeGst', 30, 'viaSettlement', true, 'problems', '[]'::jsonb, 'currency', 'INR')),
    ('p8',  date '2025-06-10', pg_temp.usd('p8',  '2025-06-10', 'zi4', 100, 84, 0,
            '{"lines": [{"zohoInvoiceId": "zi4", "invoiceNumber": "INV/25-26/R2694-4", "settle": 100, "tds": 5}]}'))
  ) as x(zid, dt, payload);

-- Bank lines: D's USD98 remittance (₹8,232) is in already; B's USD100 (₹8,400) and C's USD60 @ 85 (₹5,100) come later.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2694000-0000-0000-0000-0000000000b3', 'b2694000-0000-0000-0000-0000000000f0', 'b2694000-0000-0000-0000-0000000000d1', '2025-06-11',
   'INW 0706R2694003 USD98.0@84 R2694 US BUYER', 0, 8232, 'R2694REFp3', 'manual');

create function pg_temp.picks(ids text[]) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', x, 'bank_account_id', 'b2694000-0000-0000-0000-0000000000d1') order by x)
    from unnest(ids) x;
$f$;
grant execute on function pg_temp.picks(text[]) to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', 'b2694000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  t   constant uuid := 'b2694000-0000-0000-0000-0000000000f0';
  l1  constant uuid := 'b2694000-0000-0000-0000-0000000000b1';
  l2  constant uuid := 'b2694000-0000-0000-0000-0000000000b2';
  l3  constant uuid := 'b2694000-0000-0000-0000-0000000000b3';
  all_ids constant text[] := array['p1', 'p2a', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
  r jsonb;
  n int;
  why text;
  inv record;
  e record;
  v_inv1 text;
  v_inv2 text;
  v_batch uuid;
  v_batch2 uuid;
  v_batch3 uuid;
  v_pay uuid;
begin
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', 'zi' || g,
         'customer_id', 'b2694000-0000-0000-0000-0000000000c1') order by g) from generate_series(1, 7) g), false);
  if (r->>'imported')::int <> 7 then raise exception 'SETUP: sales import %', r; end if;
  select i.id into v_inv1 from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi1';
  select i.id into v_inv2 from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi2';
  if not exists (select 1 from public.invoices i where i.id = v_inv1 and i.currency = 'USD' and i.fx_rate = 83 and coalesce(i.net_payable, i.amount) = 8300) then
    raise exception 'SETUP: USD invoice not as expected';
  end if;

  -- F. Check first: A, C (first part), D importable; E refused with reasons; nothing written
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(all_ids), true);
  if (r->>'imported')::int <> 3 or (r->>'foreign')::int <> 3 then raise exception 'FAIL F1: check %', r; end if;
  select string_agg(x->>'zoho_payment_id' || ': ' || (x->>'reason'), ' | ' order by x->>'zoho_payment_id') into why from jsonb_array_elements(r->'skipped') x;
  if why not like 'p4: Received in USD in Zoho — foreign-currency payments are not imported yet%'
     or why not like '%p5: Received in USD — read it from Zoho again%'
     or why not like '%p6: USD 10 of it is not applied to any invoice in Zoho (an advance in USD)%'
     or why not like '%p7: % is in ₹ here, but this payment is in USD%'
     or why not like '%p8: %Zoho shows TDS on a USD payment%'
     or why not like '%p9: Zoho''s rate on this payment (₹120) is more than 25% away from %''s rate (₹83)%' then
    raise exception 'FAIL F2: refusals %', why;
  end if;
  if exists (select 1 from public.expenses x where x.tenant_id = t) or exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t)
     or exists (select 1 from public.payments p where p.tenant_id = t) then
    raise exception 'FAIL F3: the check wrote something';
  end if;

  -- A. Import: USD 100 @ 84 on the ₹83 invoice → receipt ₹8,300 (Paid), gain ₹100 = ONE expense, no line yet
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(all_ids), false);
  if (r->>'imported')::int <> 3 or (r->>'banked')::int <> 1 or (r->>'fx_difference')::int <> -240 or (r->>'fx_charges')::int <> 168 then
    raise exception 'FAIL A1: import %', r;
  end if;
  v_batch := (r->>'batch_id')::uuid;
  select i.status::text as status, i.paid_amount into inv from public.invoices i where i.id = v_inv1;
  if inv.status <> 'paid' or inv.paid_amount <> 8300 then raise exception 'FAIL A2: invoice 1 %', inv; end if;
  select coalesce(sum(p.amount), 0)::int into n from public.payments p where p.tenant_id = t and p.invoice_id = v_inv1 and p.status = 'received';
  if n <> 8300 then raise exception 'FAIL A3: receipts on invoice 1 = ₹%, expected 8300 (its own rate)', n; end if;
  select x.* into e from public.expenses x where x.tenant_id = t and x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1');
  if not found or e.amount <> -100 or e.category <> 'Exchange gain / loss (realised)' or not e.paid or e.expense_date <> date '2025-06-10'
     or e.bank_account_id <> 'b2694000-0000-0000-0000-0000000000d1'::uuid or e.reconciled_txn_id is not null then
    raise exception 'FAIL A4: gain row %', row_to_json(e);
  end if;
  select count(*) into n from public.expenses x where x.tenant_id = t and x.category = 'Exchange gain / loss (realised)'
     and (x.id like 'EXP-FXD-%' or x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1'));
  if n <> 1 then raise exception 'FAIL A5: % FX rows for p1, expected exactly one', n; end if;
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1'
                   and z.currency = 'USD' and z.foreign_amount = 100 and z.fx_rate = 84 and z.fx_difference = -100
                   and z.received_paise = 840000 and z.bank_txn_id is null) then
    raise exception 'FAIL A6: receipt row %', (select row_to_json(z) from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1');
  end if;

  -- D. USD 100 with USD 2 charges @ 84: receipt 8,300; gain 100; charges 168; matched to the ₹8,232 line at import
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p3') and x.amount = -100 and x.reconciled_txn_id = l3)
     or not exists (select 1 from public.expenses x where x.id = (select z.fx_charges_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p3') and x.amount = 168 and x.category = 'Bank Charges' and x.reconciled_txn_id = l3) then
    raise exception 'FAIL D1: p3 FX rows %', (select json_agg(row_to_json(x)) from public.expenses x where x.tenant_id = t and x.id like 'EXP-ZFX%');
  end if;
  if not exists (select 1 from public.bank_transactions b where b.id = l3 and b.matched_to_type = 'payment') then raise exception 'FAIL D2: p3 line not matched'; end if;
  if exists (select 1 from public.bank_receipt_round_offs o where o.bank_txn_id = l3) then raise exception 'FAIL D3: round-off on an exact line'; end if;
  if not exists (select 1 from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi3' and i.status::text = 'paid' and i.paid_amount = 8300) then
    raise exception 'FAIL D4: invoice 3 not paid in full';
  end if;

  -- C. Part payment USD 40 @ 84: ₹3,320 (40 × 83), gain ₹40, ₹4,980 left
  select i.status::text as status, i.paid_amount into inv from public.invoices i where i.id = v_inv2;
  if inv.status = 'paid' or inv.paid_amount <> 3320 then raise exception 'FAIL C1: invoice 2 after USD 40 %', inv; end if;
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p2a') and x.amount = -40) then raise exception 'FAIL C2: part gain'; end if;

  -- C. The other USD 60 arrives on the bank (@ 85 = ₹5,100) and is paid through R-2427 while USD 40's receipt
  --    still waits for its line → refused (that receipt may be this money)
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
    (l2, t, 'b2694000-0000-0000-0000-0000000000d1', '2025-06-20', 'INW 0706R2694002 USD60.0@85 R2694 US BUYER', 0, 5100, 'R2694REFp2b', 'manual');
  begin
    perform public.reconcile_bank_credit_fx_invoice(l2, v_inv2, 'USD', 85, 60);
    raise exception 'FAIL C3: a bank receipt on invoice 2 was booked while its imported USD receipt waits';
  exception when check_violation then
    get stacked diagnostics why = message_text;
    if why not like 'Invoice % already has receipt % from Zoho payment p2a (USD 40 on 10 Jun 2025), waiting for its bank line%' then
      raise exception 'FAIL C3b: wrong refusal: %', why;
    end if;
  end;
  if exists (select 1 from public.bank_transactions b where b.id = l2 and b.matched_to_type is not null) then raise exception 'FAIL C3c: line taken'; end if;

  -- C. Zoho's USD 60 @ 85 imported: the whole ₹4,980 due (60 × 83), Paid, gain 4,980 − 5,100 = ₹120, its line matched
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(array['p2b']), false);
  v_batch2 := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 1 or (r->>'banked')::int <> 1 or (r->>'fx_difference')::int <> -120 then raise exception 'FAIL C4: %', r; end if;
  select i.status::text as status, i.paid_amount into inv from public.invoices i where i.id = v_inv2;
  if inv.status <> 'paid' or inv.paid_amount <> 8300 then raise exception 'FAIL C5: invoice 2 %', inv; end if;
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p2b') and x.amount = -120 and x.reconciled_txn_id = l2) then
    raise exception 'FAIL C6: second part gain %', (select row_to_json(x) from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p2b'));
  end if;

  -- B. p1's remittance arrives (USD100.0@84 = ₹8,400). R-2427 on the paid invoice → refused (nothing due), line untouched
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
    (l1, t, 'b2694000-0000-0000-0000-0000000000d1', '2025-06-11', 'INW 0706R2694001 USD100.0@84 R2694 US BUYER', 0, 8400, 'R2694REFp1', 'manual');
  begin
    perform public.reconcile_bank_credit_fx_invoice(l1, v_inv1, 'USD', 84, 100);
    raise exception 'FAIL B1: the paid invoice took the remittance again';
  exception when check_violation then
    get stacked diagnostics why = message_text;
    if why not like '%nothing left to pay%' then raise exception 'FAIL B1b: %', why; end if;
  end;
  -- Import again → the line is matched to p1's receipt; the gain row is tied to it; no second FX row
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(array['p1']), false);
  if (r->>'already')::int <> 1 or (r->>'banked')::int <> 1 then raise exception 'FAIL B2: import again %', r; end if;
  if not exists (select 1 from public.bank_transactions b where b.id = l1 and b.matched_to_type = 'payment'
                   and b.matched_to_id in (select p.id::text from public.payments p where p.invoice_id = v_inv1)) then
    raise exception 'FAIL B3: p1 line not matched to its receipt';
  end if;
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1') and x.amount = -100 and x.reconciled_txn_id = l1) then raise exception 'FAIL B4: gain not tied'; end if;
  if exists (select 1 from public.expenses x where x.tenant_id = t and x.id in ('EXP-FXD-' || l1::text, 'EXP-FXC-' || l1::text)) then
    raise exception 'FAIL B5: FX booked a second time on the line';
  end if;
  if exists (select 1 from public.bank_receipt_round_offs o where o.bank_txn_id = l1) then raise exception 'FAIL B6: round-off on an exact line'; end if;
  select coalesce(sum(x.amount), 0)::int into n from public.expenses x where x.tenant_id = t and x.category = 'Exchange gain / loss (realised)';
  if n <> -360 then raise exception 'FAIL B7: total FX ₹%, expected -360 (100 + 40 + 120 + 100)', n; end if;

  -- B. Un-reconcile p1's line: the gain stays (belongs to the Zoho payment), untied; match again → tied again
  perform public.reconcile_bank_txn(l1, null, null, null);
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1') and x.amount = -100 and x.reconciled_txn_id is null) then
    raise exception 'FAIL B8: gain after un-reconcile %', (select row_to_json(x) from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1'));
  end if;
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(array['p1']), false);
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p1') and x.reconciled_txn_id = l1) then raise exception 'FAIL B9: not tied again'; end if;
  select count(*) into n from public.expenses x where x.tenant_id = t and x.category = 'Exchange gain / loss (realised)';
  if n <> 4 then raise exception 'FAIL B10: % FX rows, expected 4 (one per Zoho payment)', n; end if;

  -- H. The 2-cent rule at a fractional invoice rate (₹83.47): USD 99.99 → the whole ₹8,347 due, Paid;
  --    USD 99.97 → ₹8,344 (99.97 × 83.47), ₹3 left due. Red if the rule is dropped (v_settle := v_part).
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(array['p10', 'p11', 'p12']), false);
  v_batch3 := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 3 then raise exception 'FAIL H1: %', r; end if;
  select i.status::text as status, i.paid_amount into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi6';
  if inv.status <> 'paid' or inv.paid_amount <> 8347 then raise exception 'FAIL H2: USD 99.99 at ₹83.47 within 2 cents should pay ₹8,347 in full: %', inv; end if;
  select i.status::text as status, i.paid_amount into inv from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi7';
  if inv.status = 'paid' or inv.paid_amount <> 8344 then raise exception 'FAIL H3: USD 99.97 at ₹83.47 (3 cents short) should be a ₹8,344 part payment: %', inv; end if;
  if not exists (select 1 from public.expenses x where x.id = (select z.fx_expense_id from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p10')
                   and x.amount = 8347 - 8399) then
    raise exception 'FAIL H4: p10 FX should be 8,347 − round(99.99 × 84) = −52';
  end if;

  -- H. Payments → Delete payment on an imported receipt with side rows → refused (USD FX rows; R-2565 Razorpay fee)
  select p.id into v_pay from public.payments p where p.tenant_id = t and p.invoice_id = (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi6');
  begin
    perform public.delete_payment(v_pay);
    raise exception 'FAIL H5: an imported USD receipt was deleted by Delete payment';
  exception when check_violation then
    get stacked diagnostics why = message_text;
    if why <> 'This receipt came from the Zoho import — use Remove import on Invoices → FY receipts from Zoho.' then raise exception 'FAIL H5b: %', why; end if;
  end;
  select p.id into v_pay from public.payments p where p.tenant_id = t and p.invoice_id = (select i.id from public.invoices i where i.tenant_id = t and i.zoho_invoice_id = 'zi5');
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = t and z.zoho_payment_id = 'p12' and z.fee_expense_id is not null) then
    raise exception 'SETUP H6: p12 imported without its Razorpay fee';
  end if;
  begin
    perform public.delete_payment(v_pay);
    raise exception 'FAIL H6: an imported Razorpay-fee receipt was deleted by Delete payment';
  exception when check_violation then
    get stacked diagnostics why = message_text;
    if why not like 'This receipt came from the Zoho import%' then raise exception 'FAIL H6b: %', why; end if;
  end;
  if (select count(*) from public.payments p where p.tenant_id = t and p.id = v_pay) <> 1 then raise exception 'FAIL H7: receipt gone'; end if;

  -- G. Remove import: the third, second (p2b) then the first batch take their receipts AND FX rows back
  r := public.remove_zoho_fy_receipts_import(v_batch3, 'R-2694 test undo');
  r := public.remove_zoho_fy_receipts_import(v_batch2, 'R-2694 test undo');
  r := public.remove_zoho_fy_receipts_import(v_batch, 'R-2694 test undo');
  if exists (select 1 from public.expenses x where x.tenant_id = t) then
    raise exception 'FAIL G1: expenses left after Remove import: %', (select json_agg(x.id) from public.expenses x where x.tenant_id = t);
  end if;
  if exists (select 1 from public.payments p where p.tenant_id = t) then raise exception 'FAIL G2: receipts left'; end if;
  if exists (select 1 from public.bank_transactions b where b.tenant_id = t and b.matched_to_type is not null) then raise exception 'FAIL G3: lines still matched'; end if;
  if not exists (select 1 from public.invoices i where i.id = v_inv1 and i.status::text <> 'paid' and coalesce(i.paid_amount, 0) = 0) then raise exception 'FAIL G4: invoice 1 still paid'; end if;

  raise notice 'R-2694 foreign receipts: all checks passed';
end $$;

rollback;
