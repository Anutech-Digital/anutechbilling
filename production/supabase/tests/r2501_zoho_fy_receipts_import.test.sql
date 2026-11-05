-- R-2501: FY 2025-26 Zoho customer payments → receipts (+ Zoho's TDS, excess → advance) on the FY sales
-- imported from Zoho (R-2499), matched to the bank line when it is in (else on a later run).
-- Owner / accountant only; no company → refused; dry run writes nothing; the money comes from the
-- server's scan (picks carry none); an opening invoice / a not-imported invoice skips the whole
-- payment; another company's account / scan never used; rerun = already (no second receipt) and
-- matches a bank line that came in since; books lock refused; one batch + one activity_log row.
-- Also: Record payment (record_multi_invoice_payment) now takes an imported Zoho sale (no quote) —
-- before this card it had no payment path at all.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2501000-0000-0000-0000-0000000000a1', 'r2501-owner@example.test'),
  ('b2501000-0000-0000-0000-0000000000a2', 'r2501-acct@example.test'),
  ('b2501000-0000-0000-0000-0000000000a3', 'r2501-mgr@example.test'),
  ('b2501000-0000-0000-0000-0000000000a4', 'r2501-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2501000-0000-0000-0000-0000000000f0', 'R2501 T', 'r2501@example.test', '07', '07AAACR2501A1Z5', 'R2501'),
  ('b2501000-0000-0000-0000-0000000000f1', 'R2501 O', 'r2501o@example.test', '07', null, 'R2501O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2501000-0000-0000-0000-0000000000a1', 'b2501000-0000-0000-0000-0000000000f0', 'r2501-owner@example.test', 'Owner', 'owner', true),
  ('b2501000-0000-0000-0000-0000000000a2', 'b2501000-0000-0000-0000-0000000000f0', 'r2501-acct@example.test', 'Acct', 'accountant', true),
  ('b2501000-0000-0000-0000-0000000000a3', 'b2501000-0000-0000-0000-0000000000f0', 'r2501-mgr@example.test', 'Mgr', 'manager', true);

update public.tenants set books_start_date = '2025-04-05' where id = 'b2501000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2501000-0000-0000-0000-0000000000c1', 'b2501000-0000-0000-0000-0000000000f0', 'R2501 KA Buyer', '29AAACR2501B1Z5', '29', 'India'),
  ('b2501000-0000-0000-0000-0000000000c2', 'b2501000-0000-0000-0000-0000000000f0', 'R2501 DL Buyer', '07AAACR2501C1Z5', '07', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2501000-0000-0000-0000-0000000000d1', 'b2501000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01'),
  ('b2501000-0000-0000-0000-0000000000d9', 'b2501000-0000-0000-0000-0000000000f1', 'Other Co Bank', 'HDFC', '9999', '2025-04-01');

-- The 4523 statement for FY 2025-26 is partly in: pA's credit is (its UTR in the narration).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2501000-0000-0000-0000-0000000000e1', 'b2501000-0000-0000-0000-0000000000f0', 'b2501000-0000-0000-0000-0000000000d1', '2025-06-11',
   'NEFT CR-R2501UTRAAAA01-KA BUYER', 0, 10800, 'R2501UTRAAAA01', 'manual'),
  -- same money, same account, no UTR, a week away: never picked
  ('b2501000-0000-0000-0000-0000000000e2', 'b2501000-0000-0000-0000-0000000000f0', 'b2501000-0000-0000-0000-0000000000d1', '2025-06-20',
   'NEFT CR-SOMEONE ELSE', 0, 10800, '000000000000000', 'manual');

-- An opening invoice (R-1739) of last year — its receipts wait for R-2504.
insert into public.invoice_import_batches (id, tenant_id) values ('b2501000-0000-0000-0000-0000000000b1', 'b2501000-0000-0000-0000-0000000000f0');
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date,
  taxable_value, tax_amount, tax_rate, line_items, document_kind, opening_balance, external_number, import_batch_id)
values ('INV/24-25/R2501-OP', 'b2501000-0000-0000-0000-0000000000f0', 'b2501000-0000-0000-0000-0000000000c1', 'R2501 KA Buyer',
  3000, 3000, 0, 'overdue', '2025-03-01', '2025-03-15', 0, 0, 0, '[]', 'opening_invoice', 3000, 'INV/24-25/R2501-OP', 'b2501000-0000-0000-0000-0000000000b1');
select set_config('app.opening_invoice_import', '', true);

-- The FY sales, read from Zoho (whole rupees) and imported through R-2499's own import.
create function pg_temp.s(num text, d text, taxable int, tax int, head text, pos text)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', pos, 'head', head, 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'R2501 Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi1', 'INV/25-26/R2501-01', '2025-05-10', 'sent', pg_temp.s('INV/25-26/R2501-01', '2025-05-10', 10000, 1800, 'igst', '29'), now()),
  ('b2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi2', 'INV/25-26/R2501-02', '2025-06-01', 'sent', pg_temp.s('INV/25-26/R2501-02', '2025-06-01', 1000, 180, 'cgst_sgst', '07'), now()),
  ('b2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi3', 'INV/25-26/R2501-03', '2025-06-05', 'sent', pg_temp.s('INV/25-26/R2501-03', '2025-06-05', 5000, 900, 'igst', '29'), now()),
  ('b2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zi4', 'INV/25-26/R2501-04', '2025-07-01', 'sent', pg_temp.s('INV/25-26/R2501-04', '2025-07-01', 2000, 360, 'igst', '29'), now());

-- Zoho customer payments, as the server read them (receipts-import/normalise.ts).
create function pg_temp.pay(num text, d text, ref text, paise bigint, excess int, lines jsonb, acct text default 'HDFC Current 4523', problems jsonb default '[]')
returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', num, 'number', num, 'date', d, 'status', '', 'zohoCustomerId', 'zc', 'customerName', 'Buyer',
    'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', ref, 'depositAccountId', 'za', 'depositAccountName', acct,
    'amount', round(paise / 100.0)::int, 'receivedPaise', paise, 'lines', lines, 'excess', excess,
    'tds', coalesce((select sum((l->>'tds')::int) from jsonb_array_elements(lines) l), 0), 'problems', problems);
$f$;
create function pg_temp.l(zid text, num text, settle int, tds int default 0) returns jsonb language sql as $f$
  select jsonb_build_object('zohoInvoiceId', zid, 'invoiceNumber', num, 'settle', settle, 'tds', tds);
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  -- pA: INV-01 in full, ₹1,000 TDS kept back, ₹10,800 in the bank (statement in)
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pA', 'pA', '2025-06-11', '',
     pg_temp.pay('pA', '2025-06-11', 'R2501UTRAAAA01', 1080000, 0, jsonb_build_array(pg_temp.l('zi1', 'INV/25-26/R2501-01', 11800, 1000))), now()),
  -- pB: INV-03 in full + ₹1,000 on INV-04 + ₹500 not applied (advance) — its bank line is not in yet
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pB', 'pB', '2025-07-15', '',
     pg_temp.pay('pB', '2025-07-15', 'R2501UTRBBBB02', 740000, 500,
       jsonb_build_array(pg_temp.l('zi3', 'INV/25-26/R2501-03', 5900), pg_temp.l('zi4', 'INV/25-26/R2501-04', 1000))), now()),
  -- pC: deposited to an account the owner mapped to ANOTHER company's bank account
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pC', 'pC', '2025-06-15', '',
     pg_temp.pay('pC', '2025-06-15', 'R2501UTRCCCC03', 118000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 1180))), now()),
  -- pD: pays last year's OPENING invoice → whole payment skipped
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pD', 'pD', '2025-06-20', '',
     pg_temp.pay('pD', '2025-06-20', 'R2501UTRDDDD04', 300000, 0, jsonb_build_array(pg_temp.l('zx', 'INV/24-25/R2501-OP', 3000))), now()),
  -- pE: Zoho problem (bank charges) → skipped with Zoho's reason
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pE', 'pE', '2025-06-21', '',
     pg_temp.pay('pE', '2025-06-21', 'R2501UTREEEE05', 118000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 1180)),
       'HDFC Current 4523', '["Zoho took bank charges off this payment — book it by hand."]'), now()),
  -- pF: more than is due on INV-02
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pF', 'pF', '2025-06-22', '',
     pg_temp.pay('pF', '2025-06-22', 'R2501UTRFFFF06', 500000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 5000))), now()),
  -- pG: before the books start
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pG', 'pG', '2025-04-02', '',
     pg_temp.pay('pG', '2025-04-02', 'R2501UTRGGGG07', 118000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 1180))), now()),
  -- the other company's scan row: never readable from T
  ('b2501000-0000-0000-0000-0000000000f1', 'customerpayments', '2025-26', 'pO', 'pO', '2025-06-11', '',
     pg_temp.pay('pO', '2025-06-11', 'R2501UTROOOO09', 118000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 1180))), now());

do $$
begin
  if to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') is null then
    raise exception 'FAIL 0: import_zoho_fy_receipts(text,jsonb,boolean) does not exist';
  end if;
  if has_function_privilege('anon', 'public.import_zoho_fy_receipts(text,jsonb,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._zoho_fy_receipt_advance(uuid,uuid,integer,date,text,text,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public._zoho_fy_receipt_bank_line(uuid,uuid,bigint,date,text)', 'execute') then
    raise exception 'FAIL 0: anon can import, or a login can call the internal helpers';
  end if;
  if has_table_privilege('authenticated', 'public.zoho_fy_receipts', 'insert')
     or has_table_privilege('authenticated', 'public.zoho_fy_receipts', 'update') then
    raise exception 'FAIL 0: a login can write zoho_fy_receipts';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;

create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('zoho_payment_id', 'pA', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pB', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pC', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d9'),
    jsonb_build_object('zoho_payment_id', 'pD', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pE', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pF', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pG', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_payment_id', 'pO', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1'));
$f$;

create function pg_temp.refused(p_who uuid, p_code text, p_msg text) returns boolean language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), true);
  return false;
exception when others then
  if sqlstate <> p_code or sqlerrm not like p_msg then
    raise exception 'wrong refusal: % %', sqlstate, sqlerrm;
  end if;
  return true;
end $f$;

grant execute on function pg_temp.as_user(uuid), pg_temp.picks(), pg_temp.refused(uuid, text, text) to authenticated;

set local role authenticated;

do $$
declare
  t constant uuid := 'b2501000-0000-0000-0000-0000000000f0';
  r jsonb;
  reasons text;
  n int;
  inv record;
  v_pay uuid;
  v_sales_batch uuid;
begin
  -- setup: the FY sales come in through R-2499's own import (owner)
  perform pg_temp.as_user('b2501000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'zi1', 'customer_id', 'b2501000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zi2', 'customer_id', 'b2501000-0000-0000-0000-0000000000c2'),
    jsonb_build_object('zoho_invoice_id', 'zi3', 'customer_id', 'b2501000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zi4', 'customer_id', 'b2501000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 4 then raise exception 'SETUP: sales import %', r; end if;
  v_sales_batch := (r->>'batch_id')::uuid;

  -- 1. manager refused, no company refused (owner / accountant only)
  if not pg_temp.refused('b2501000-0000-0000-0000-0000000000a3', '42501', '%owner or an accountant%') then raise exception 'FAIL 1: manager imported'; end if;
  if not pg_temp.refused('b2501000-0000-0000-0000-0000000000a4', '28000', '%sign-in%') then raise exception 'FAIL 1b: no-company login imported'; end if;

  -- 2. dry run (accountant): pA + pB would come in; NOTHING written
  perform pg_temp.as_user('b2501000-0000-0000-0000-0000000000a2');
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), true);
  if (r->>'dry_run')::boolean is not true or (r->>'imported')::int <> 2 or r->>'batch_id' is not null
     or (r->>'banked')::int <> 1 or (r->>'bank_later')::int <> 1 then
    raise exception 'FAIL 2: dry run result %', r;
  end if;
  if exists (select 1 from public.payments where tenant_id = t)
     or exists (select 1 from public.zoho_fy_receipts where tenant_id = t)
     or exists (select 1 from public.zoho_fy_import_batches where tenant_id = t and kind = 'customerpayments')
     or exists (select 1 from public.bank_transactions where tenant_id = t and matched_to_type is not null)
     or exists (select 1 from public.activity_log where tenant_id = t and action = 'zoho_fy_receipts.imported') then
    raise exception 'FAIL 2b: the dry run wrote something';
  end if;

  -- 3. real import
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  if (r->>'dry_run')::boolean or (r->>'imported')::int <> 2 or (r->>'received')::int <> 10800 + 7400
     or (r->>'tds')::int <> 1000 or (r->>'advance')::int <> 500 then
    raise exception 'FAIL 3: import result %', r;
  end if;
  select string_agg((s->>'zoho_payment_id') || ': ' || (s->>'reason'), E'\n' order by s->>'zoho_payment_id') into reasons
    from jsonb_array_elements(r->'skipped') s;
  if reasons not like '%pC: Choose the app account%'
     or reasons not like '%pD: INV/24-25/R2501-OP is an opening invoice here%'
     or reasons not like '%pE: Zoho took bank charges%'
     or reasons not like '%pF: INV/25-26/R2501-02 has only ₹1180 due%'
     or reasons not like '%pG: Dated 02 Apr 2025, before the books start (05 Apr 2025)%'
     or reasons not like '%pO: Not read from Zoho yet%' then
    raise exception 'FAIL 3b: skip reasons:%', E'\n' || coalesce(reasons, '(none)');
  end if;

  -- 4. pA: INV-01 paid in full = ₹10,800 money + ₹1,000 TDS (TDS receivable from Zoho's figure); bank line matched
  select id, status, paid_amount into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'zi1';
  if inv.status <> 'paid' or inv.paid_amount <> 11800 then raise exception 'FAIL 4: INV-01 %', row_to_json(inv); end if;
  if not exists (select 1 from public.tds_receivable x where x.tenant_id = t and x.invoice_id = inv.id
                  and x.tds_amount = 1000 and x.net_paid = 10800) then
    raise exception 'FAIL 4b: TDS receivable for INV-01 missing or wrong';
  end if;
  select id into v_pay from public.payments where tenant_id = t and invoice_id = inv.id and quote_id is null;
  if not exists (select 1 from public.bank_transactions b where b.id = 'b2501000-0000-0000-0000-0000000000e1'
                  and b.matched_to_type = 'payment' and b.matched_to_id = v_pay::text) then
    raise exception 'FAIL 4c: the 4523 line with pA''s UTR is not matched to its receipt';
  end if;
  if exists (select 1 from public.bank_transactions where id = 'b2501000-0000-0000-0000-0000000000e2' and matched_to_type is not null) then
    raise exception 'FAIL 4d: the line a week away was matched';
  end if;

  -- 5. pB: INV-03 paid, INV-04 part-paid, ₹500 advance (credit), no bank line yet
  if (select status::text from public.invoices where tenant_id = t and zoho_invoice_id = 'zi3') <> 'paid'
     or (select paid_amount from public.invoices where tenant_id = t and zoho_invoice_id = 'zi4') <> 1000
     or (select status::text from public.invoices where tenant_id = t and zoho_invoice_id = 'zi4') = 'paid' then
    raise exception 'FAIL 5: pB on INV-03 / INV-04';
  end if;
  if (select count(*) from public.customer_credits c where c.tenant_id = t and c.customer_id = 'b2501000-0000-0000-0000-0000000000c1'
       and c.amount = 500 and c.status = 'open' and c.source = 'overpayment') <> 1 then
    raise exception 'FAIL 5b: the ₹500 advance is not a customer credit';
  end if;
  if (select count(*) from public.payments where tenant_id = t and reference = 'R2501UTRBBBB02' and status = 'received') <> 3
     or (select sum(amount) from public.payments where tenant_id = t and reference = 'R2501UTRBBBB02') <> 7400 then
    raise exception 'FAIL 5c: pB receipts';
  end if;
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'pB') is not null then
    raise exception 'FAIL 5d: pB has a bank line it should not have';
  end if;

  -- 6. one batch + one activity_log row (the log is read as the owner — RLS)
  perform pg_temp.as_user('b2501000-0000-0000-0000-0000000000a1');
  if (select count(*) from public.zoho_fy_import_batches where tenant_id = t and kind = 'customerpayments' and imported_count = 2) <> 1
     or (select count(*) from public.activity_log where tenant_id = t and action = 'zoho_fy_receipts.imported') <> 1 then
    raise exception 'FAIL 6: batch / log rows';
  end if;

  -- 7. the sales batch cannot be taken back now (money on it)
  begin
    perform public.remove_zoho_fy_sales_import(v_sales_batch, 'test remove');
    raise exception 'FAIL 7: sales import removed under its receipts';
  exception when others then
    if sqlerrm like 'FAIL 7%' then raise; end if;
  end;
end $$;

-- 8. pB's bank line arrives later (same day, no UTR in the narration — the only one): a rerun matches it
reset role;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2501000-0000-0000-0000-0000000000e3', 'b2501000-0000-0000-0000-0000000000f0', 'b2501000-0000-0000-0000-0000000000d1', '2025-07-15',
   'NEFT CR-KA BUYER', 0, 7400, '000000000000000', 'manual');
set local role authenticated;

do $$
declare
  t constant uuid := 'b2501000-0000-0000-0000-0000000000f0';
  r jsonb;
  n int;
begin
  perform pg_temp.as_user('b2501000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 2 or (r->>'banked')::int <> 1 then
    raise exception 'FAIL 8: rerun result %', r;
  end if;
  if (select count(*) from public.payments where tenant_id = t and status = 'received') <> 4 then
    raise exception 'FAIL 8b: the rerun made another receipt';
  end if;
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'pB') <> 'b2501000-0000-0000-0000-0000000000e3'
     or (select count(*) from public.payments where tenant_id = t and bank_txn_id = 'b2501000-0000-0000-0000-0000000000e3') <> 3
     or (select matched_to_type from public.bank_transactions where id = 'b2501000-0000-0000-0000-0000000000e3') <> 'payment' then
    raise exception 'FAIL 8c: pB not matched to its later bank line';
  end if;

  -- 9. Record payment by hand now works on an imported Zoho sale (rest of INV-04: ₹1,360)
  r := public.record_multi_invoice_payment('b2501000-0000-0000-0000-0000000000c1', '2025-08-01', 'bank_transfer', null,
         'R2501HAND0001', 1360, jsonb_build_array(jsonb_build_object('invoice_id', 'INV/25-26/R2501-04', 'amount', 1360)), false, null);
  if (select status::text from public.invoices where tenant_id = t and zoho_invoice_id = 'zi4') <> 'paid' then
    raise exception 'FAIL 9: Record payment did not settle the imported sale: %', r;
  end if;
end $$;

-- 10. books lock: a payment dated inside it is refused
reset role;
update public.tenants set books_locked_until = '2025-06-30' where id = 'b2501000-0000-0000-0000-0000000000f0';
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'pL', 'pL', '2025-06-25', '',
     pg_temp.pay('pL', '2025-06-25', 'R2501UTRLLLL10', 118000, 0, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/R2501-02', 1180))), now());
set local role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b2501000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_receipts('2025-26', jsonb_build_array(
         jsonb_build_object('zoho_payment_id', 'pL', 'bank_account_id', 'b2501000-0000-0000-0000-0000000000d1')), false);
  if (r->>'imported')::int <> 0 or r->'skipped'->0->>'reason' not like '%inside the books lock%' then
    raise exception 'FAIL 10: lock %', r;
  end if;
end $$;

reset role;
select 'R-2501 zoho fy receipts import: all checks passed' as result;
rollback;
