-- R-2542 (6 Nov 2026, p1 money): an FY sale imported from Zoho (R-2499 — invoices.zoho_invoice_id, no
-- quote, no instalment) could not be paid from the bank page: Banking → Reconcile → "An open quote /
-- invoice" listed only quotes, and "This money is for" refused it. Migration
-- 20261106160000_r2542_zoho_sale_invoice_bank_credit (bank_credit_open_items + bank_credit_pay_item):
-- such an invoice is an 'opening' item too and books through _record_opening_invoice_payment (the
-- same quote-less receipt R-1739 / R-2466 / R-2501 use). Self-asserting, ONE transaction, rolled back.
-- RED without the migration (A: the imported sale is not listed).
--
--   A. bank_credit_open_items lists the Zoho sale — kind 'opening', its due, no quote.
--   B. A bank line of ₹11,600 + ₹200 TDS (2% of ₹10,000 taxable, 194J) → the ₹11,800 invoice is paid,
--      ₹0 due; one receipt (no quote, the bank account, the bank date), one TDS receivable row; the
--      line is matched to the receipt.
--   C. Un-reconcile (keep the receipt) frees the line; booking the line again → the SAME receipt.
--   D. Part payment: ₹500 on the ₹1,180 sale → ₹680 still due, not paid.
--   E. More than its due → refused, nothing saved.
--   F. Books locked up to the line's date → refused, nothing saved.
--   G. Another company's login: nothing listed, booking refused.
--   H. The quote-linked path is unchanged: a quote's invoice is listed as 'invoice' with its quote and
--      its receipt carries the quote.
--   I. Record payment (record_multi_invoice_payment) on a Zoho sale with 2% TDS → paid, ₹0 due.
--   J. A hand-made tax invoice with no quote / instalment / Zoho id is still left out (no payment path).

begin;

insert into auth.users (id, email) values
  ('b2542000-0000-0000-0000-0000000000a1', 'r2542-owner@example.test'),
  ('b2542000-0000-0000-0000-0000000000a2', 'r2542-other@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2542000-0000-0000-0000-0000000000f0', 'R2542 T', 'r2542@example.test', '07', '07AAACR2542A1Z5', 'R2542', 'Test street, Delhi'),
  ('b2542000-0000-0000-0000-0000000000f1', 'R2542 O', 'r2542o@example.test', '07', null, 'R2542O', 'Other street, Delhi');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2542000-0000-0000-0000-0000000000a1', 'b2542000-0000-0000-0000-0000000000f0', 'r2542-owner@example.test', 'Owner', 'owner', true),
  ('b2542000-0000-0000-0000-0000000000a2', 'b2542000-0000-0000-0000-0000000000f1', 'r2542-other@example.test', 'Other', 'owner', true);

update public.tenants set books_start_date = '2025-04-01' where id = 'b2542000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2542000-0000-0000-0000-0000000000c1', 'b2542000-0000-0000-0000-0000000000f0', 'R2542 KA Buyer', '29AAACR2542B1Z5', '29', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2542000-0000-0000-0000-0000000000d1', 'b2542000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2542000-0000-0000-0000-0000000000e1', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000d1', '2026-01-05',
   'NEFT CR-R2542UTR0001-KA BUYER', 0, 11600, 'R2542UTR0001', 'manual'),
  ('b2542000-0000-0000-0000-0000000000e2', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000d1', '2026-01-06',
   'NEFT CR-R2542UTR0002-KA BUYER PART', 0, 500, 'R2542UTR0002', 'manual'),
  ('b2542000-0000-0000-0000-0000000000e3', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000d1', '2026-01-07',
   'NEFT CR-R2542UTR0003-KA BUYER TOO MUCH', 0, 5000, 'R2542UTR0003', 'manual'),
  ('b2542000-0000-0000-0000-0000000000e4', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000d1', '2025-12-10',
   'NEFT CR-R2542UTR0004-KA BUYER LOCKED', 0, 100, 'R2542UTR0004', 'manual'),
  ('b2542000-0000-0000-0000-0000000000e5', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000d1', '2026-01-08',
   'NEFT CR-R2542UTR0005-KA BUYER QUOTE', 0, 1180, 'R2542UTR0005', 'manual');

-- The FY sales, read from Zoho (whole rupees) and imported through R-2499's own import.
create function pg_temp.s(num text, d text, taxable int, tax int)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', '29', 'head', 'igst', 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'R2542 Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2542000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zs1', 'INV/25-26/R2542-01', '2025-11-10', 'sent', pg_temp.s('INV/25-26/R2542-01', '2025-11-10', 10000, 1800), now()),
  ('b2542000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zs2', 'INV/25-26/R2542-02', '2025-11-11', 'sent', pg_temp.s('INV/25-26/R2542-02', '2025-11-11', 1000, 180), now()),
  ('b2542000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zs3', 'INV/25-26/R2542-03', '2025-11-12', 'sent', pg_temp.s('INV/25-26/R2542-03', '2025-11-12', 5000, 900), now());

-- H: a quote-linked invoice (the old path). J: a hand-made tax invoice with no quote and no Zoho id.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, is_one_off, created_date)
values ('Q-R2542-1', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000c1', 'R2542 KA Buyer',
        1180, 1000, 18, 'accepted', 'awaiting', '[{"name": "Setup", "qty": 1, "rate": 1000, "one_time": true}]'::jsonb, true, '2025-12-01');
insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2542-Q', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000c1', 'R2542 KA Buyer', 'Q-R2542-1',
   1180, 1180, 'pending', '2025-12-01', '2026-02-01', 1000, 180, 18, true, 0, 'tax_invoice', '[{"name": "Setup", "qty": 1, "rate": 1000}]'::jsonb),
  ('INV-R2542-NOQ', 'b2542000-0000-0000-0000-0000000000f0', 'b2542000-0000-0000-0000-0000000000c1', 'R2542 KA Buyer', null,
   1180, 1180, 'pending', '2025-12-02', '2026-02-02', 1000, 180, 18, true, 0, 'tax_invoice', '[{"name": "x", "qty": 1, "rate": 1000}]'::jsonb);
update public.quotes set invoice_id = 'INV-R2542-Q' where id = 'Q-R2542-1';

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.zs(p text) returns text language sql as $f$
  select id from public.invoices where zoho_invoice_id = p and tenant_id = 'b2542000-0000-0000-0000-0000000000f0' $f$;
create function pg_temp.received(p_inv text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where invoice_id = p_inv and status = 'received' $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.zs(text), pg_temp.received(text) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2542000-0000-0000-0000-0000000000a1');

do $$
declare r jsonb;
begin
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'zs1', 'customer_id', 'b2542000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zs2', 'customer_id', 'b2542000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zs3', 'customer_id', 'b2542000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 3 then raise exception 'SETUP: sales import %', r; end if;
  if (select quote_id from public.invoices where id = pg_temp.zs('zs1')) is not null
     or (select document_kind from public.invoices where id = pg_temp.zs('zs1')) = 'opening_invoice' then
    raise exception 'SETUP: the imported sale has a quote or is an opening invoice'; end if;
end $$;

-- ── A. listed ────────────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1') o where o.invoice_id = pg_temp.zs('zs1');
  if not found then raise exception 'FAIL A: the Zoho FY sale is not in "An open quote / invoice"'; end if;
  if r.kind <> 'opening' or r.amount_due <> 11800 or r.quote_id is not null or r.currency <> 'INR' or r.taxable_value <> 10000 then
    raise exception 'FAIL A: row % (want opening / ₹11,800 due / no quote / INR / ₹10,000 taxable)', to_jsonb(r); end if;
  raise notice 'PASS A: the Zoho FY sale is listed (kind opening, ₹11,800 due)';
end $$;

-- ── B. bank line + 2% TDS → paid, ₹0 due ─────────────────────────────────────────────────────
do $$
declare r jsonb; v_inv text := pg_temp.zs('zs1'); p record; n int; i record;
begin
  r := public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e1', null, v_inv, 200, 2, '194J');
  select status::text as status, paid_amount, net_payable, amount, paid_date into i from public.invoices where id = v_inv;
  if i.status <> 'paid' or coalesce(i.net_payable, i.amount) - i.paid_amount <> 0 or pg_temp.received(v_inv) <> 11800 then
    raise exception 'FAIL B: invoice % paid ₹% received ₹% (want paid, ₹0 due, ₹11,800) — %', i.status, i.paid_amount, pg_temp.received(v_inv), r; end if;
  if i.paid_date <> '2026-01-05' then raise exception 'FAIL B: paid on % (want the bank date)', i.paid_date; end if;
  select * into p from public.payments where id = (r->>'payment_id')::uuid;
  if p.quote_id is not null or p.invoice_id <> v_inv or p.bank_account_id <> 'b2542000-0000-0000-0000-0000000000d1'
     or p.receipt_voucher_no is null or p.amount <> 11800 or (p.received_at at time zone 'UTC')::date <> '2026-01-05' then
    raise exception 'FAIL B: receipt % (want no quote, the invoice, the bank account, a voucher, ₹11,800, the bank date)', to_jsonb(p); end if;
  select count(*) into n from public.tds_receivable
   where invoice_id = v_inv and payment_id = p.id and tds_amount = 200 and net_paid = 11600 and section = '194J' and rate_pct = 2
     and gross_amount = 10000;
  if n <> 1 then raise exception 'FAIL B: % TDS rows of ₹200 / net ₹11,600 / 194J @ 2%% on ₹10,000 taxable (want 1)', n; end if;
  if (select matched_to_id from public.bank_transactions where id = 'b2542000-0000-0000-0000-0000000000e1') <> p.id::text then
    raise exception 'FAIL B: the line is not matched to its receipt'; end if;
  if exists (select 1 from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1') o where o.invoice_id = v_inv) then
    raise exception 'FAIL B: the paid invoice is still listed as open'; end if;
  raise notice 'PASS B: ₹11,600 from the bank + ₹200 TDS (2%%) → the Zoho sale is paid, ₹0 due';
end $$;

-- ── C. un-reconcile frees the line; booking again → the same receipt ─────────────────────────
do $$
declare v_pay text; r jsonb; v_inv text := pg_temp.zs('zs1');
begin
  v_pay := (select matched_to_id from public.bank_transactions where id = 'b2542000-0000-0000-0000-0000000000e1');
  perform public.unreconcile_bank_receipt('b2542000-0000-0000-0000-0000000000e1', false);
  if (select matched_to_type from public.bank_transactions where id = 'b2542000-0000-0000-0000-0000000000e1') is not null then
    raise exception 'FAIL C: the line is still matched after un-reconcile'; end if;
  if pg_temp.received(v_inv) <> 11800 then raise exception 'FAIL C: un-reconcile changed the receipts: ₹%', pg_temp.received(v_inv); end if;
  r := public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e1', null, v_inv, 200, 2, '194J');
  if r->>'payment_id' <> v_pay then
    raise exception 'FAIL C: booking the line again made receipt % (want the same %)', r->>'payment_id', v_pay; end if;
  if pg_temp.received(v_inv) <> 11800 or (select count(*) from public.tds_receivable where invoice_id = v_inv) <> 1 then
    raise exception 'FAIL C: ₹% / % TDS rows after the retry (want ₹11,800 / 1)', pg_temp.received(v_inv),
      (select count(*) from public.tds_receivable where invoice_id = v_inv); end if;
  raise notice 'PASS C: un-reconcile frees the line; the same line booked again → one receipt';
end $$;

-- ── D. part payment ──────────────────────────────────────────────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zs2'); r record;
begin
  perform public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e2', null, v_inv);
  if (select status::text from public.invoices where id = v_inv) = 'paid' or pg_temp.received(v_inv) <> 500 then
    raise exception 'FAIL D: % with ₹% (want not paid, ₹500)', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv); end if;
  select * into r from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1') o where o.invoice_id = v_inv;
  if not found or r.amount_due <> 680 then raise exception 'FAIL D: still due % (want ₹680)', r.amount_due; end if;
  raise notice 'PASS D: ₹500 on the ₹1,180 Zoho sale → ₹680 still due';
end $$;

-- ── E. more than its due → refused ───────────────────────────────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zs2');
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e3', null, v_inv);
    raise exception 'FAIL E: ₹5,000 on ₹680 due was accepted';
  exception when check_violation then
    if sqlerrm not like '%only ₹680 due%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 500
     or (select matched_to_type from public.bank_transactions where id = 'b2542000-0000-0000-0000-0000000000e3') is not null then
    raise exception 'FAIL E: something was saved'; end if;
  raise notice 'PASS E: more than the Zoho sale''s due → refused, nothing saved';
end $$;

-- ── F. books locked ──────────────────────────────────────────────────────────────────────────
reset role;
update public.tenants set books_locked_until = '2025-12-31' where id = 'b2542000-0000-0000-0000-0000000000f0';
set local role authenticated;
do $$
declare v_inv text := pg_temp.zs('zs2');
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e4', null, v_inv);
    raise exception 'FAIL F: a receipt dated inside locked books was saved';
  exception when others then
    if sqlerrm like 'FAIL F%' then raise; end if;
    if sqlerrm not ilike '%lock%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 500 then raise exception 'FAIL F: something was saved'; end if;
  raise notice 'PASS F: books locked → refused, nothing saved';
end $$;
reset role;
update public.tenants set books_locked_until = null where id = 'b2542000-0000-0000-0000-0000000000f0';
set local role authenticated;

-- ── G. another company's login ───────────────────────────────────────────────────────────────
select pg_temp.as_user('b2542000-0000-0000-0000-0000000000a2');
do $$
declare n int;
begin
  select count(*) into n from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1');
  if n <> 0 then raise exception 'FAIL G: another company sees % open items', n; end if;
  begin
    perform public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e3', null, 'INV-R2542-Q');
    raise exception 'FAIL G: another company booked on this line';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS G: another company — nothing listed, booking refused';
end $$;
select pg_temp.as_user('b2542000-0000-0000-0000-0000000000a1');

-- ── H. the quote-linked path is unchanged ────────────────────────────────────────────────────
do $$
declare r record; res jsonb; p record;
begin
  select * into r from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1') o where o.invoice_id = 'INV-R2542-Q';
  if not found or r.kind <> 'invoice' or r.quote_id <> 'Q-R2542-1' or r.amount_due <> 1180 then
    raise exception 'FAIL H: quote invoice row % (want invoice / Q-R2542-1 / ₹1,180)', to_jsonb(r); end if;
  res := public.reconcile_bank_credit_to_item('b2542000-0000-0000-0000-0000000000e5', null, 'INV-R2542-Q');
  select * into p from public.payments where id = (res->>'payment_id')::uuid;
  if res->>'kind' = 'opening' or p.quote_id is distinct from 'Q-R2542-1' or p.amount <> 1180 then
    raise exception 'FAIL H: kind % / receipt % (want the quote path, the quote on the receipt)', res->>'kind', to_jsonb(p); end if;
  if (select status::text from public.invoices where id = 'INV-R2542-Q') <> 'paid' then
    raise exception 'FAIL H: the quote invoice is not paid'; end if;
  raise notice 'PASS H: a quote-linked invoice still pays through its quote';
end $$;

-- ── I. Record payment (several-invoices sheet) with 2% TDS ───────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zs3'); r jsonb; n int;
begin
  r := public.record_multi_invoice_payment('b2542000-0000-0000-0000-0000000000c1', '2026-01-09', 'bank_transfer',
    'b2542000-0000-0000-0000-0000000000d1', 'R2542UTR0009', 5800,
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 5800, 'tds_amount', 100, 'tds_section', '194J', 'tds_rate_pct', 2)),
    false, null);
  if (select status::text from public.invoices where id = v_inv) <> 'paid' or pg_temp.received(v_inv) <> 5900 then
    raise exception 'FAIL I: % with ₹% (want paid, ₹5,900) — %', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv), r; end if;
  select count(*) into n from public.tds_receivable where invoice_id = v_inv and tds_amount = 100;
  if n <> 1 then raise exception 'FAIL I: % TDS rows of ₹100 (want 1)', n; end if;
  raise notice 'PASS I: Record payment on a Zoho sale with 2%% TDS → paid, ₹0 due';
end $$;

-- ── J. a hand-made quote-less tax invoice still has no path ──────────────────────────────────
do $$
begin
  if exists (select 1 from public.bank_credit_open_items('b2542000-0000-0000-0000-0000000000c1') o where o.invoice_id = 'INV-R2542-NOQ') then
    raise exception 'FAIL J: a tax invoice with no quote / instalment / Zoho id is listed (it cannot take a payment)'; end if;
  raise notice 'PASS J: a hand-made quote-less tax invoice is still left out';
end $$;

rollback;
