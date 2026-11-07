-- R-2546 (7 Nov 2026, p0 money — R-2542 review note): reconcile_bank_credit_to_item refused a second
-- bank line carrying a receipt's reference with "… already recorded on % …" filled from the QUOTE id —
-- for a quote-less receipt (an FY sale imported from Zoho, R-2542) that printed "<NULL>". Migration
-- 20261107041320_r2546_reconcile_msg_invoice: the quote, else the invoice. Self-asserting, ONE
-- transaction, rolled back. RED without the migration (A: the message says <NULL>).
--
--   A. Zoho sale (no quote) paid from one bank line (₹6,600 + ₹200 TDS on ₹6,800 — the owner's case);
--      a second line with the same UTR → refused, the message names the invoice, nothing saved.
--   B. Quote-linked invoice, part-paid (₹500 of ₹1,180): the same refusal still names the quote.

begin;

insert into auth.users (id, email) values
  ('b2546000-0000-0000-0000-0000000000a1', 'r2546-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2546000-0000-0000-0000-0000000000f0', 'R2546 T', 'r2546@example.test', '07', '07AAACR2546A1Z5', 'R2546', 'Test street, Delhi');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2546000-0000-0000-0000-0000000000a1', 'b2546000-0000-0000-0000-0000000000f0', 'r2546-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2546000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2546000-0000-0000-0000-0000000000c1', 'b2546000-0000-0000-0000-0000000000f0', 'R2546 KA Buyer', '29AAACR2546B1Z5', '29', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2546000-0000-0000-0000-0000000000d1', 'b2546000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '4523', '2025-04-01'),
  ('b2546000-0000-0000-0000-0000000000d2', 'b2546000-0000-0000-0000-0000000000f0', 'Second', 'ICICI', '7788', '2025-04-01');

-- The same UTR on two bank lines (two accounts): the first pays, the second is the duplicate.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2546000-0000-0000-0000-0000000000e1', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000d1', '2026-01-05',
   'NEFT CR-R2546UTR0001-KA BUYER', 0, 6600, 'R2546UTR0001', 'manual'),
  ('b2546000-0000-0000-0000-0000000000e2', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000d2', '2026-01-05',
   'NEFT CR-R2546UTR0001-KA BUYER AGAIN', 0, 6600, 'R2546UTR0001', 'manual'),
  ('b2546000-0000-0000-0000-0000000000e3', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000d1', '2026-01-08',
   'NEFT CR-R2546UTR0003-KA BUYER QUOTE', 0, 500, 'R2546UTR0003', 'manual'),
  ('b2546000-0000-0000-0000-0000000000e4', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000d2', '2026-01-08',
   'NEFT CR-R2546UTR0003-KA BUYER QUOTE AGAIN', 0, 500, 'R2546UTR0003', 'manual');

-- The FY sale read from Zoho (₹6,800 = ₹5,763 taxable + ₹1,037 IGST), imported through R-2499's import.
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2546000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zs46', 'INV/25-26/R2546-01', '2025-11-10', 'sent',
   jsonb_build_object('number', 'INV/25-26/R2546-01', 'date', '2025-11-10', 'dueDate', '2025-11-10', 'status', 'sent', 'customerName', 'Buyer',
     'gstin', '', 'posStateCode', '29', 'head', 'igst', 'currency', 'INR', 'fxRate', null, 'taxable', 5763, 'tax', 1037, 'amount', 6800,
     'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
     'lines', jsonb_build_array(jsonb_build_object('name', 'R2546 Seat', 'hsn', '998315', 'qty', 1, 'rate', 5763, 'taxable', 5763))),
   now());

-- B: a quote-linked invoice (the old path).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           line_items, is_one_off, created_date)
values ('Q-R2546-1', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000c1', 'R2546 KA Buyer',
        1180, 1000, 18, 'accepted', 'awaiting', '[{"name": "Setup", "qty": 1, "rate": 1000, "one_time": true}]'::jsonb, true, '2025-12-01');
insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2546-Q', 'b2546000-0000-0000-0000-0000000000f0', 'b2546000-0000-0000-0000-0000000000c1', 'R2546 KA Buyer', 'Q-R2546-1',
   1180, 1180, 'pending', '2025-12-01', '2026-02-01', 1000, 180, 18, true, 0, 'tax_invoice', '[{"name": "Setup", "qty": 1, "rate": 1000}]'::jsonb);
update public.quotes set invoice_id = 'INV-R2546-Q' where id = 'Q-R2546-1';

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.zs(p text) returns text language sql as $f$
  select id from public.invoices where zoho_invoice_id = p and tenant_id = 'b2546000-0000-0000-0000-0000000000f0' $f$;
create function pg_temp.received(p_inv text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where invoice_id = p_inv and status = 'received' $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.zs(text), pg_temp.received(text) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2546000-0000-0000-0000-0000000000a1');

do $$
declare r jsonb;
begin
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'zs46', 'customer_id', 'b2546000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 1 then raise exception 'SETUP: sales import %', r; end if;
  if (select quote_id from public.invoices where id = pg_temp.zs('zs46')) is not null then
    raise exception 'SETUP: the imported sale has a quote'; end if;
end $$;

-- ── A. Zoho sale: the duplicate line's refusal names the invoice ─────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zs46'); v_msg text;
begin
  perform public.reconcile_bank_credit_to_item('b2546000-0000-0000-0000-0000000000e1', null, v_inv, 200, null, '194J');
  if (select status::text from public.invoices where id = v_inv) <> 'paid' or pg_temp.received(v_inv) <> 6800 then
    raise exception 'SETUP A: % with ₹% (want paid, ₹6,800)', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv); end if;
  begin
    perform public.reconcile_bank_credit_to_item('b2546000-0000-0000-0000-0000000000e2', null, v_inv, 200, null, '194J');
    raise exception 'FAIL A: the second line with the same UTR was accepted';
  exception when unique_violation then
    v_msg := sqlerrm;
  end;
  if v_msg like '%NULL%' or v_msg not like '%already recorded on ' || v_inv || ' and reconciled to another bank line%' then
    raise exception 'FAIL A: message "%" (want it to name invoice %)', v_msg, v_inv; end if;
  if pg_temp.received(v_inv) <> 6800
     or (select matched_to_type from public.bank_transactions where id = 'b2546000-0000-0000-0000-0000000000e2') is not null then
    raise exception 'FAIL A: something was saved'; end if;
  raise notice 'PASS A: duplicate UTR on a Zoho sale → refused, the message names %', v_inv;
end $$;

-- ── B. quote-linked: the refusal still names the quote ──────────────────────────────────────
do $$
declare v_msg text;
begin
  perform public.reconcile_bank_credit_to_item('b2546000-0000-0000-0000-0000000000e3', null, 'INV-R2546-Q');
  begin
    perform public.reconcile_bank_credit_to_item('b2546000-0000-0000-0000-0000000000e4', null, 'INV-R2546-Q');
    raise exception 'FAIL B: the second line with the same UTR was accepted';
  exception when unique_violation then
    v_msg := sqlerrm;
  end;
  if v_msg not like '%already recorded on Q-R2546-1 and reconciled to another bank line%' then
    raise exception 'FAIL B: message "%" (want it to name quote Q-R2546-1)', v_msg; end if;
  raise notice 'PASS B: duplicate UTR on a quote''s invoice → the message names the quote';
end $$;

rollback;
