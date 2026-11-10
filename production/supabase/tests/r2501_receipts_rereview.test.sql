-- R-2501 re-review (independentReview v13): (1) 2b — a SAME-DAY bank line of the money already
-- reconciled is refused whatever its narration (UPI / IMPS lines carry only a VPA or a number — the
-- reviewer's probe), unless a free line carries Zoho's reference; (2) undo — earned referral
-- commissions of the batch's receipts are removed with them, a PAID one refuses the undo; a credit
-- note added to the invoice after the import refuses it; the customer-panel invite the receipts queued
-- is taken back while unsent; (3) TDS gross of a part payment = its taxable share.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values ('d2501000-0000-0000-0000-0000000000a1', 'r2501g-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('d2501000-0000-0000-0000-0000000000f0', 'R2501G T', 'r2501g@example.test', '07', '07AAACR2501J1Z5', 'R251G');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('d2501000-0000-0000-0000-0000000000a1', 'd2501000-0000-0000-0000-0000000000f0', 'r2501g-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'd2501000-0000-0000-0000-0000000000f0';
insert into public.customers (id, tenant_id, name, gstin, state_code, country, contact_email) values
  ('d2501000-0000-0000-0000-0000000000c1', 'd2501000-0000-0000-0000-0000000000f0', 'Acmewidget Private Limited', '29AAACR2501K1Z5', '29', 'India', 'acme@example.test'),
  ('d2501000-0000-0000-0000-0000000000c2', 'd2501000-0000-0000-0000-0000000000f0', 'Zenithcorp Traders', '07AAACR2501L1Z5', '07', 'India', null);
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('d2501000-0000-0000-0000-0000000000d1', 'd2501000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');
-- Acmewidget came through a referral partner: every receipt earns a commission (fn_accrue_referral_commission)
insert into public.referral_partners (id, tenant_id, name) values
  ('d2501000-0000-0000-0000-0000000000b9', 'd2501000-0000-0000-0000-0000000000f0', 'R2501G Partner');
insert into public.referral_agreements (tenant_id, partner_id, customer_id, basis, percent, scope, status) values
  ('d2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000b9', 'd2501000-0000-0000-0000-0000000000c1', 'percent', 10, 'recurring', 'active');

create function pg_temp.s(num text, d text, taxable int, tax int, head text, pos text)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', pos, 'head', head, 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'd2501000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', v.z, v.n, v.d::date, 'sent', pg_temp.s(v.n, v.d, v.tx, v.tax, v.h, v.pos), now()
  from (values
    ('zi1', 'INV/25-26/G01', '2025-05-10', 10000, 1800, 'igst', '29'),
    ('zi2', 'INV/25-26/G02', '2025-06-05', 5000, 900, 'igst', '29'),
    ('zi3', 'INV/25-26/G03', '2025-06-01', 2000, 360, 'cgst_sgst', '07'),
    ('zi4', 'INV/25-26/G04', '2025-06-01', 1000, 180, 'igst', '29')) v(z, n, d, tx, tax, h, pos);

create function pg_temp.pay(num text, d text, ref text, paise bigint, lines jsonb)
returns jsonb language sql as $f$
  select jsonb_build_object('zohoId', num, 'number', num, 'date', d, 'status', '', 'zohoCustomerId', 'zc', 'customerName', 'Buyer',
    'method', 'bank_transfer', 'zohoMode', 'Bank Transfer', 'reference', ref, 'depositAccountId', 'za', 'depositAccountName', 'HDFC 4523',
    'amount', round(paise / 100.0)::int, 'receivedPaise', paise, 'lines', lines, 'excess', 0,
    'tds', coalesce((select sum((l->>'tds')::int) from jsonb_array_elements(lines) l), 0), 'problems', '[]'::jsonb);
$f$;
create function pg_temp.l(zid text, num text, settle int, tds int default 0) returns jsonb language sql as $f$
  select jsonb_build_object('zohoInvoiceId', zid, 'invoiceNumber', num, 'settle', settle, 'tds', tds);
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  -- the reviewer's probe: ₹2,360 on 12 Jun; that day's line of it is already reconciled by hand and
  -- says only 'UPI-9876543210-PAYMENT' (no name); no free line → refused, never booked twice
  ('d2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-T', 'PMT-T', '2025-06-12', '',
     pg_temp.pay('PMT-T', '2025-06-12', 'FIXUTRTTTT02', 236000, jsonb_build_array(pg_temp.l('zi3', 'INV/25-26/G03', 2360))), now()),
  -- the escape: a reconciled unnamed line of the same money that day, AND a free line carrying Zoho's UTR → booked on the free one
  ('d2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-E', 'PMT-E', '2025-06-20', '',
     pg_temp.pay('PMT-E', '2025-06-20', 'FIXUTREEEE01', 590000, jsonb_build_array(pg_temp.l('zi2', 'INV/25-26/G02', 5900))), now()),
  -- a PART payment with TDS: ₹5,900 settled (₹500 TDS) of the ₹11,800 invoice → gross ₹5,000 (its taxable share), 10%
  ('d2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-P', 'PMT-P', '2025-07-01', '',
     pg_temp.pay('PMT-P', '2025-07-01', 'FIXUTRPPPP03', 540000, jsonb_build_array(pg_temp.l('zi1', 'INV/25-26/G01', 5900, 500))), now()),
  -- not a regression: a reconciled line of the same money 2 days earlier that names the customer (another
  -- invoice it paid, booked by hand) does NOT stop its own free same-day line that names it (2c 'high')
  ('d2501000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'PMT-N', 'PMT-N', '2025-06-25', '',
     pg_temp.pay('PMT-N', '2025-06-25', '', 118000, jsonb_build_array(pg_temp.l('zi4', 'INV/25-26/G04', 1180))), now());

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('d2501000-0000-0000-0000-0000000000e2', 'd2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000d1', '2025-06-12', 'UPI-9876543210-PAYMENT', 0, 2360, '000000000000000', 'manual'),
  ('d2501000-0000-0000-0000-0000000000e4', 'd2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000d1', '2025-06-20', 'NEFT CR-FIXUTREEEE01', 0, 5900, 'FIXUTREEEE01', 'manual'),
  ('d2501000-0000-0000-0000-0000000000e5', 'd2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000d1', '2025-06-20', 'UPI-1111111111-PAY', 0, 5900, '000000000000000', 'manual'),
  ('d2501000-0000-0000-0000-0000000000e6', 'd2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000d1', '2025-06-23', 'NEFT CR-ACMEWIDGET', 0, 1180, '000000000000000', 'manual'),
  ('d2501000-0000-0000-0000-0000000000e7', 'd2501000-0000-0000-0000-0000000000f0', 'd2501000-0000-0000-0000-0000000000d1', '2025-06-25', 'NEFT CR-ACMEWIDGET PVT', 0, 1180, '000000000000000', 'manual');
update public.bank_transactions set matched_to_type = 'manual', matched_at = now(), match_confidence = 'manual'
 where id in ('d2501000-0000-0000-0000-0000000000e2', 'd2501000-0000-0000-0000-0000000000e5', 'd2501000-0000-0000-0000-0000000000e6');

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('zoho_payment_id', z, 'bank_account_id', 'd2501000-0000-0000-0000-0000000000d1'))
    from unnest(array['PMT-T', 'PMT-E', 'PMT-P', 'PMT-N']) z;
$f$;
create function pg_temp.undo_error() returns text language plpgsql as $f$
begin
  perform public.remove_zoho_fy_receipts_import(
    (select id from public.zoho_fy_import_batches where tenant_id = 'd2501000-0000-0000-0000-0000000000f0' and kind = 'customerpayments'), 'test undo');
  return null;
exception when others then
  return sqlerrm;
end $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.picks(), pg_temp.undo_error() to authenticated;

set local role authenticated;
do $$
declare
  t constant uuid := 'd2501000-0000-0000-0000-0000000000f0';
  r jsonb;
begin
  perform pg_temp.as_user('d2501000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'zi1', 'customer_id', 'd2501000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zi2', 'customer_id', 'd2501000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zi3', 'customer_id', 'd2501000-0000-0000-0000-0000000000c2'),
    jsonb_build_object('zoho_invoice_id', 'zi4', 'customer_id', 'd2501000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 4 then raise exception 'SETUP: sales %', r; end if;

  r := public.import_zoho_fy_receipts('2025-26', pg_temp.picks(), false);

  -- 1. the probe: refused (the money is in the books already), nothing booked on INV-G03
  if r->'skipped' @? '$[*] ? (@.zoho_payment_id == "PMT-T")' is not true
     or (select string_agg(s->>'reason', ' ') from jsonb_array_elements(r->'skipped') s where s->>'zoho_payment_id' = 'PMT-T')
          not like 'Its bank line (12 Jun 2025, ₹2360.00) is already reconciled as manual%'
     or exists (select 1 from public.payments where tenant_id = t and reference = 'FIXUTRTTTT02') then
    raise exception 'FAIL 1: an unnamed same-day reconciled line did not stop PMT-T: %', r;
  end if;
  -- 1b. the escape: the free line with Zoho's UTR is taken although an unnamed reconciled line of that money sits that day
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'PMT-E') is distinct from 'd2501000-0000-0000-0000-0000000000e4'::uuid then
    raise exception 'FAIL 1b: PMT-E not on its UTR line: %', r;
  end if;
  -- 1c. PMT-N: the reconciled named line 2 days earlier does not block its own free named same-day line
  if (select bank_txn_id from public.zoho_fy_receipts where tenant_id = t and zoho_payment_id = 'PMT-N') is distinct from 'd2501000-0000-0000-0000-0000000000e7'::uuid then
    raise exception 'FAIL 1c: PMT-N not on its own named line: %', r;
  end if;
  -- 3. TDS gross of the part payment = its taxable share
  if not exists (select 1 from public.tds_receivable x where x.tenant_id = t and x.tds_amount = 500 and x.gross_amount = 5000 and x.rate_pct = 10) then
    raise exception 'FAIL 3: part-payment TDS gross %', (select json_agg(row_to_json(x)) from public.tds_receivable x where x.tenant_id = t);
  end if;
  -- setup checks for the undo: the receipts earned commissions and queued the panel invite
  if (select count(*) from public.referral_commissions c where c.tenant_id = t and c.status = 'earned'
        and c.payment_id in (select unnest(payment_ids) from public.zoho_fy_receipts where tenant_id = t)) <> 3 then
    raise exception 'SETUP 2: commissions not made by the receipts';
  end if;
end $$;

-- (the panel outbox is server-only: read as the database owner)
reset role;
do $$
begin
  if not exists (select 1 from public.panel_account_outbox o where o.tenant_id = 'd2501000-0000-0000-0000-0000000000f0'
                  and o.customer_id = 'd2501000-0000-0000-0000-0000000000c1') then
    raise exception 'SETUP 2b: the receipts did not queue the panel invite';
  end if;
end $$;

-- 2a. a PAID commission on one of its receipts refuses the undo
reset role;
update public.referral_commissions set status = 'paid', paid_date = '2025-08-01'
 where id = (select id from public.referral_commissions where tenant_id = 'd2501000-0000-0000-0000-0000000000f0' order by created_at, id limit 1);
set local role authenticated;
do $$
declare e text;
begin
  perform pg_temp.as_user('d2501000-0000-0000-0000-0000000000a1');
  e := pg_temp.undo_error();
  if e is null or e not like '%referral commission%already paid to the partner%' then raise exception 'FAIL 2a: undo with a paid commission: %', coalesce(e, 'went through'); end if;
end $$;
reset role;
update public.referral_commissions set status = 'earned', paid_date = null where tenant_id = 'd2501000-0000-0000-0000-0000000000f0';

-- 2b. a credit note added to its invoice after the import refuses the undo
insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate, inter_state, customer_id)
values ('CN-R251G-1', 'd2501000-0000-0000-0000-0000000000f0', 'INV/25-26/G02', 118, 100, 18, 18, true, 'd2501000-0000-0000-0000-0000000000c1');
set local role authenticated;
do $$
declare e text;
begin
  perform pg_temp.as_user('d2501000-0000-0000-0000-0000000000a1');
  e := pg_temp.undo_error();
  if e is null or e not like '%credit note CN-R251G-1%' then raise exception 'FAIL 2b: undo with a later credit note: %', coalesce(e, 'went through'); end if;
end $$;
reset role;
delete from public.credit_notes where id = 'CN-R251G-1';

-- 2c. untouched → the undo takes back the receipts, their EARNED commissions and the unsent panel invite
set local role authenticated;
do $$
declare
  t constant uuid := 'd2501000-0000-0000-0000-0000000000f0';
  e text;
begin
  perform pg_temp.as_user('d2501000-0000-0000-0000-0000000000a1');
  e := pg_temp.undo_error();
  if e is not null then raise exception 'FAIL 2c: undo refused: %', e; end if;
  if exists (select 1 from public.referral_commissions where tenant_id = t)
     or exists (select 1 from public.payments where tenant_id = t) then
    raise exception 'FAIL 2c: commissions / receipts left after the undo';
  end if;
end $$;

reset role;
do $$
begin
  if exists (select 1 from public.panel_account_outbox where tenant_id = 'd2501000-0000-0000-0000-0000000000f0') then
    raise exception 'FAIL 2d: the unsent panel invite stayed after the undo';
  end if;
end $$;
select 'R-2501 re-review (2b probe, undo commissions / credit note / panel invite, part-payment TDS gross): all checks passed' as result;
rollback;
