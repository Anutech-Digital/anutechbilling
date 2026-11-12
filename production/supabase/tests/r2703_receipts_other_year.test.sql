-- R-2703: Zoho FY receipts whose invoice is outside the year (import_zoho_fy_receipts) — the REASON says
-- what the invoice is, and a ₹0 line no longer blocks. Nothing new is booked.
--   pZ  ₹0 lines (30 paise — on a later-year invoice AND on an invoice that is here) no longer block the receipt
--   pZ0 a payment of only ₹0 lines → refused
--   pA  an opening invoice already paid → "in the books already"
--   pO  an opening invoice with money due → by hand (never paid from the import)
--   pV  a void opening invoice → by hand
--   pE  an earlier year's invoice with no opening invoice → "add it as an opening invoice"
--   pEF the same, foreign payment → by hand
--   pN  numbered this year but not among the year's Zoho invoices → "check its date"; with Zoho's
--       invoice date (pN2) → FY 2024-25
--   pD  this year's invoice Zoho has but the app does not → still "import FY sales first" (the only one)
--   pM  a later year's invoice → "record this payment on that invoice in the app"
--   pL  later-year invoices inside a payment that also pays this year's → the WHOLE payment left out (no advance)
--   pC  a credit / debit note line → by hand
-- Self-asserting; the whole file rolls back. Red without the r2703_receipts_other_year migration.

begin;

insert into auth.users (id, email) values ('b2703000-0000-0000-0000-0000000000a1', 'r2703-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2703000-0000-0000-0000-0000000000f0', 'R2703 T', 'r2703@example.test', '07', '07AAACR2703A1Z5', 'R2703');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2703000-0000-0000-0000-0000000000a1', 'b2703000-0000-0000-0000-0000000000f0', 'r2703-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2703000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2703000-0000-0000-0000-0000000000c1', 'b2703000-0000-0000-0000-0000000000f0', 'R2703 KA Buyer', '29AAACR2703B1Z5', '29', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2703000-0000-0000-0000-0000000000d1', 'b2703000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-03-31');

-- Opening invoices (R-1739): -1 ₹2,000 still due of ₹5,000; -2 paid; -3 void.
insert into public.invoice_import_batches (id, tenant_id) values ('b2703000-0000-0000-0000-0000000000b1', 'b2703000-0000-0000-0000-0000000000f0');
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date,
  taxable_value, tax_amount, tax_rate, line_items, document_kind, opening_balance, external_number, import_batch_id)
values
  ('INV/24-25/R2703-1', 'b2703000-0000-0000-0000-0000000000f0', 'b2703000-0000-0000-0000-0000000000c1', 'R2703 KA Buyer',
   5000, 5000, 3000, 'overdue', '2025-03-03', '2025-03-15', 0, 0, 0, '[]', 'opening_invoice', 2000, 'INV/24-25/R2703-1', 'b2703000-0000-0000-0000-0000000000b1'),
  ('INV/24-25/R2703-2', 'b2703000-0000-0000-0000-0000000000f0', 'b2703000-0000-0000-0000-0000000000c1', 'R2703 KA Buyer',
   500, 500, 500, 'paid', '2025-03-04', '2025-03-15', 0, 0, 0, '[]', 'opening_invoice', 500, 'INV/24-25/R2703-2', 'b2703000-0000-0000-0000-0000000000b1'),
  ('INV/24-25/R2703-3', 'b2703000-0000-0000-0000-0000000000f0', 'b2703000-0000-0000-0000-0000000000c1', 'R2703 KA Buyer',
   1000, 1000, 0, 'void', '2025-03-05', '2025-03-15', 0, 0, 0, '[]', 'opening_invoice', 1000, 'INV/24-25/R2703-3', 'b2703000-0000-0000-0000-0000000000b1');
select set_config('app.opening_invoice_import', '', true);

-- This year's Zoho invoices as read: zi1 + zi2 are imported below; zi9 is left out of the sales import.
create function pg_temp.s(num text, d text, taxable int, tax int)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', '29', 'head', 'igst', 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'R2703 Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2703000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2703zi1', 'INV/25-26/R2703-01', '2025-05-10', 'sent', pg_temp.s('INV/25-26/R2703-01', '2025-05-10', 10000, 1800), now()),
  ('b2703000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2703zi2', 'INV/25-26/R2703-02', '2025-06-01', 'sent', pg_temp.s('INV/25-26/R2703-02', '2025-06-01', 1000, 180), now()),
  ('b2703000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'r2703zi9', 'INV/25-26/R2703-09', '2025-06-02', 'sent', pg_temp.s('INV/25-26/R2703-09', '2025-06-02', 1000, 180), now());

create function pg_temp.pay(num text, d text, paise bigint, excess int, lines jsonb, extra jsonb default '{}')
returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', num, 'number', num, 'date', d, 'status', '', 'zohoCustomerId', 'zc', 'customerName', 'Buyer',
    'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', 'R2703UTR' || upper(num), 'depositAccountId', 'za', 'depositAccountName', 'HDFC Current 4523',
    'amount', round(paise / 100.0)::int, 'receivedPaise', paise, 'lines', lines, 'excess', excess,
    'tds', coalesce((select sum((l->>'tds')::int) from jsonb_array_elements(lines) l), 0), 'problems', '[]'::jsonb) || extra;
$f$;
create function pg_temp.l(zid text, num text, settle int, tds int default 0, on_date text default null) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('zohoInvoiceId', zid, 'invoiceNumber', num, 'settle', settle, 'tds', tds, 'invoiceDate', on_date));
$f$;
create function pg_temp.scan(num text, d text, payload jsonb) returns void language sql as $f$
  insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
  values ('b2703000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', num, num, d::date, '', payload, now());
$f$;

select pg_temp.scan('pZ', '2025-06-10', pg_temp.pay('pZ', '2025-06-10', 118060, 0, jsonb_build_array(
  pg_temp.l('r2703zi2', 'INV/25-26/R2703-02', 1180), pg_temp.l('r2703zi1', 'INV/25-26/R2703-01', 0), pg_temp.l('r2703zq', 'INV/26-27/R2703-15', 0))));
select pg_temp.scan('pZ0', '2025-06-10', pg_temp.pay('pZ0', '2025-06-10', 30, 0, jsonb_build_array(pg_temp.l('r2703zq', 'INV/26-27/R2703-15', 0))));
select pg_temp.scan('pA', '2025-06-12', pg_temp.pay('pA', '2025-06-12', 50000, 0, jsonb_build_array(pg_temp.l('r2703zo2', 'inv/24-25/r2703-2', 500))));
select pg_temp.scan('pO', '2025-06-11', pg_temp.pay('pO', '2025-06-11', 190000, 0, jsonb_build_array(pg_temp.l('r2703zo1', 'INV/24-25/R2703-1', 2000, 100))));
select pg_temp.scan('pV', '2025-06-13', pg_temp.pay('pV', '2025-06-13', 100000, 0, jsonb_build_array(pg_temp.l('r2703zo3', 'INV/24-25/R2703-3', 1000))));
select pg_temp.scan('pE', '2025-06-17', pg_temp.pay('pE', '2025-06-17', 651800, 0, jsonb_build_array(
  pg_temp.l('r2703zi1', 'INV/25-26/R2703-01', 6001), pg_temp.l('r2703zold', 'LSINV/24-25/R2703-77', 517))));
select pg_temp.scan('pEF', '2025-06-16', pg_temp.pay('pEF', '2025-06-16', 850000, 0, jsonb_build_array(pg_temp.l('r2703zold2', 'INV/24-25/R2703-90', 100)),
  jsonb_build_object('currency', 'USD', 'foreignAmount', 100, 'fxRate', 85, 'foreignCharges', 0,
    'foreignLines', jsonb_build_array(jsonb_build_object('zohoInvoiceId', 'r2703zold2', 'invoiceNumber', 'INV/24-25/R2703-90', 'foreign', 100)))));
select pg_temp.scan('pN', '2025-06-18', pg_temp.pay('pN', '2025-06-18', 2000000, 0, jsonb_build_array(pg_temp.l('r2703z1979', 'INV/25-26/R2703-1979', 20000))));
select pg_temp.scan('pN2', '2025-06-18', pg_temp.pay('pN2', '2025-06-18', 2000000, 0, jsonb_build_array(pg_temp.l('r2703z1979', 'INV/25-26/R2703-1979', 20000, 0, '2025-01-28'))));
select pg_temp.scan('pD', '2025-06-19', pg_temp.pay('pD', '2025-06-19', 118000, 0, jsonb_build_array(pg_temp.l('r2703zi9', 'INV/25-26/R2703-09', 1180))));
select pg_temp.scan('pM', '2026-03-31', pg_temp.pay('pM', '2026-03-31', 297400, 0, jsonb_build_array(pg_temp.l('r2703z77', 'INV/26-27/R2703-77', 2974))));
select pg_temp.scan('pL', '2026-01-13', pg_temp.pay('pL', '2026-01-13', 556200, 39, jsonb_build_array(
  pg_temp.l('r2703zi1', 'INV/25-26/R2703-01', 5000), pg_temp.l('r2703z43', 'INV/26-27/R2703-43', 189), pg_temp.l('r2703z44', 'INV/26-27/R2703-44', 334))));
select pg_temp.scan('pC', '2025-11-21', pg_temp.pay('pC', '2025-11-21', 41700, 0, jsonb_build_array(
  pg_temp.l('r2703zi1', 'INV/25-26/R2703-01', 100), pg_temp.l('r2703zcdn', 'CDN-000004', 317))));

create function pg_temp.as_owner() returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', 'b2703000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.picks(variadic ids text[]) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', i, 'bank_account_id', 'b2703000-0000-0000-0000-0000000000d1')) from unnest(ids) i;
$f$;
create function pg_temp.why(r jsonb, id text) returns text language sql as $f$
  select coalesce((select s->>'reason' from jsonb_array_elements(r->'skipped') s where s->>'zoho_payment_id' = id), '(not skipped)');
$f$;
grant execute on function pg_temp.as_owner(), pg_temp.picks(text[]), pg_temp.why(jsonb, text) to authenticated;

set local role authenticated;

do $$
declare
  t constant uuid := 'b2703000-0000-0000-0000-0000000000f0';
  c1 constant uuid := 'b2703000-0000-0000-0000-0000000000c1';
  r jsonb;
begin
  perform pg_temp.as_owner();
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'r2703zi1', 'customer_id', c1),
    jsonb_build_object('zoho_invoice_id', 'r2703zi2', 'customer_id', c1)), false);
  if (r->>'imported')::int <> 2 then raise exception 'SETUP: sales import %', r; end if;

  -- 1. only pZ is booked: ₹1,180 on INV-02; its two ₹0 lines book nothing
  r := public.import_zoho_fy_receipts('2025-26',
         pg_temp.picks('pZ', 'pZ0', 'pA', 'pO', 'pV', 'pE', 'pEF', 'pN', 'pN2', 'pD', 'pM', 'pL', 'pC'), false);
  if (r->>'imported')::int <> 1 or (r->>'received')::int <> 1180 or (r->>'advance')::int <> 0 or (r->>'tds')::int <> 0 then
    raise exception 'FAIL 1: import result %', r;
  end if;
  if (select status::text from public.invoices where tenant_id = t and zoho_invoice_id = 'r2703zi2') <> 'paid'
     or (select count(*) from public.payments where tenant_id = t) <> 1
     or (select sum(amount) from public.payments where tenant_id = t and reference = 'R2703UTRPZ') <> 1180
     or (select coalesce(paid_amount, 0) from public.invoices where tenant_id = t and zoho_invoice_id = 'r2703zi1') <> 0 then
    raise exception 'FAIL 1b: pZ — receipts %', (select jsonb_agg(jsonb_build_object('ref', reference, 'amt', amount, 'inv', invoice_id)) from public.payments where tenant_id = t);
  end if;

  -- 2. nothing else is booked: no receipt on an opening invoice, no advance from later-year money
  if (select paid_amount from public.invoices where tenant_id = t and id = 'INV/24-25/R2703-1') <> 3000
     or exists (select 1 from public.customer_credits c where c.tenant_id = t)
     or exists (select 1 from public.tds_receivable x where x.tenant_id = t) then
    raise exception 'FAIL 2: something other than pZ was booked';
  end if;

  -- 3. the reasons — each says what the invoice is; "import FY sales first" only for pD
  if pg_temp.why(r, 'pZ0') <> 'Zoho applies no whole rupee of this payment to an invoice — record it by hand.' then raise exception 'FAIL 3 pZ0: %', pg_temp.why(r, 'pZ0'); end if;
  if pg_temp.why(r, 'pA') <> 'inv/24-25/r2703-2 is an opening invoice that is already paid here — this receipt is in the books already.' then raise exception 'FAIL 3 pA: %', pg_temp.why(r, 'pA'); end if;
  if pg_temp.why(r, 'pO') <> 'INV/24-25/R2703-1 is an opening invoice here with ₹2000 still due — its balance was taken when it was added and may already leave this receipt out. If it does not, record this payment on it by hand (Invoices → INV/24-25/R2703-1 → Record payment).' then raise exception 'FAIL 3 pO: %', pg_temp.why(r, 'pO'); end if;
  if pg_temp.why(r, 'pV') <> 'INV/24-25/R2703-3 is an opening invoice that is void here — book this payment by hand.' then raise exception 'FAIL 3 pV: %', pg_temp.why(r, 'pV'); end if;
  if pg_temp.why(r, 'pE') <> 'LSINV/24-25/R2703-77 is an invoice of FY 2024-25 — add it as an opening invoice, then record this payment on it.' then raise exception 'FAIL 3 pE: %', pg_temp.why(r, 'pE'); end if;
  if pg_temp.why(r, 'pEF') <> 'INV/24-25/R2703-90 is an invoice of FY 2024-25 and this payment is in USD — book it by hand.' then raise exception 'FAIL 3 pEF: %', pg_temp.why(r, 'pEF'); end if;
  if pg_temp.why(r, 'pN') <> 'INV/25-26/R2703-1979 is not among the FY 2025-26 invoices read from Zoho — check its date in Zoho: an earlier year''s invoice is added as an opening invoice, a later year''s is paid in the app.' then raise exception 'FAIL 3 pN: %', pg_temp.why(r, 'pN'); end if;
  if pg_temp.why(r, 'pN2') <> 'INV/25-26/R2703-1979 is an invoice of FY 2024-25 — add it as an opening invoice, then record this payment on it.' then raise exception 'FAIL 3 pN2: %', pg_temp.why(r, 'pN2'); end if;
  if pg_temp.why(r, 'pD') <> 'INV/25-26/R2703-09 is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).' then raise exception 'FAIL 3 pD: %', pg_temp.why(r, 'pD'); end if;
  if pg_temp.why(r, 'pM') <> 'INV/26-27/R2703-77 is an invoice of FY 2026-27 — record this payment on that invoice in the app.' then raise exception 'FAIL 3 pM: %', pg_temp.why(r, 'pM'); end if;
  if pg_temp.why(r, 'pL') <> 'INV/26-27/R2703-43 is an invoice of FY 2026-27 — record this payment on that invoice in the app.' then raise exception 'FAIL 3 pL: %', pg_temp.why(r, 'pL'); end if;
  if pg_temp.why(r, 'pC') <> 'CDN-000004 is a credit / debit note in Zoho, not an invoice — book this payment by hand.' then raise exception 'FAIL 3 pC: %', pg_temp.why(r, 'pC'); end if;
  if (select count(*) from jsonb_array_elements(r->'skipped') s where s->>'reason' like '%import FY sales first%') <> 1 then
    raise exception 'FAIL 3z: "import FY sales first" said for another year''s invoice: %', r->'skipped';
  end if;

  -- 4. import again: pZ is "already" — no second receipt
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks('pZ'), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 1 or (select count(*) from public.payments where tenant_id = t) <> 1 then
    raise exception 'FAIL 4: rerun %', r;
  end if;
end $$;

-- 5. the year's Zoho invoices were not read at all: an unknown invoice numbered in this year still says "import FY sales first"
reset role;
delete from public.zoho_fy_scan where tenant_id = 'b2703000-0000-0000-0000-0000000000f0' and kind = 'invoices';
set local role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.as_owner();
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks('pN', 'pE'), true);
  if pg_temp.why(r, 'pN') not like 'INV/25-26/R2703-1979 is not an FY sale imported from Zoho here — import FY sales first%'
     or pg_temp.why(r, 'pE') not like 'LSINV/24-25/R2703-77 is an invoice of FY 2024-25%' then
    raise exception 'FAIL 5: no invoice scan %', r->'skipped';
  end if;
end $$;

reset role;
select 'R-2703 receipts on other-year invoices: all checks passed' as result;
rollback;
