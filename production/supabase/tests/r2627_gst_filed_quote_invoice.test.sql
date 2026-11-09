-- R-2627 (9 Nov 2026, p1 money, fix card from R-2621's review): paying an accepted QUOTE that has no
-- invoice yet from a bank line of a GST-filed month must not raise a new tax invoice dated in that month.
-- Migration 20261109112645_r2627_gst_filed_quote_invoice. Self-asserting, ONE transaction, rolled back.
-- RED without the migration (A: the quote is paid and invoiced on 20 Sep 2026).
--
--   GST filed up to Sep 2026 (owner, R-2621's setting).
--   A. Reconcile → An open quote / invoice (reconcile_bank_credit_to_item) on 20 Sep 2026 → refused with
--      "GST for Sep 2026 is already filed …"; no receipt, no invoice, the line unmatched; a retry the same.
--   B. "Several quotes / invoices" (reconcile_bank_credit_split): an existing invoice + the quote → refused,
--      the existing invoice is not half-paid.
--   C. relink_bank_one_off_sale path 'item' → refused; the old one-off sale is NOT undone.
--   D. An invoice that already exists (quote with its invoice) is still paid from a filed-month line.
--   E. 5 Oct 2026 (open month): the quote is paid and invoiced on 5 Oct as before.
--   F. GSTR-1 for Oct 2026 marked filed (compliance_log) → a 7 Oct line on a quote → refused the same.
--   H. A part payment (no invoice raised now) on a filed day → recorded, nothing refused.
--   I. A part payment that DOES raise the invoice (invoice_on_receipt quote, R-2095) on a filed day → refused.
--   G. Books lock only (setting cleared, no marks): the receipt is refused by the books-lock rule as before — not by R-2627.

begin;

insert into auth.users (id, email) values
  ('b2627000-0000-0000-0000-0000000000a1', 'r2627-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2627000-0000-0000-0000-0000000000f0', 'R2627 T', 'r2627@example.test', '07', '07AAACR2627A1Z5', 'R2627', 'Test street, Delhi');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2627000-0000-0000-0000-0000000000a1', 'b2627000-0000-0000-0000-0000000000f0', 'r2627-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2627000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('b2627000-0000-0000-0000-0000000000c1', 'b2627000-0000-0000-0000-0000000000f0', 'R2627 Buyer', '07', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('b2627000-0000-0000-0000-0000000000d1', 'b2627000-0000-0000-0000-0000000000f0', 'Current', 'HDFC');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2627000-0000-0000-0000-0000000000e1', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-20', 'NEFT CR R2627 A', 0, 1180, 'R2627UTRA', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e2', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-21', 'NEFT CR R2627 B', 0, 2360, 'R2627UTRB', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e3', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-10', 'NEFT CR R2627 OLD', 0, 5900, 'R2627UTRC', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e4', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-22', 'NEFT CR R2627 D', 0, 1180, 'R2627UTRD', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e5', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-10-05', 'NEFT CR R2627 E', 0, 1180, 'R2627UTRE', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e6', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-10-07', 'NEFT CR R2627 F', 0, 1180, 'R2627UTRF', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e7', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-08-20', 'NEFT CR R2627 G', 0, 1180, 'R2627UTRG', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e8', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-23', 'NEFT CR R2627 H', 0, 500, 'R2627UTRH', 'manual'),
  ('b2627000-0000-0000-0000-0000000000e9', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000d1', '2026-09-24', 'NEFT CR R2627 I', 0, 500, 'R2627UTRI', 'manual');

-- Accepted one-off quotes, no invoice yet (₹1,000 + 18% = ₹1,180; C's ₹5,000 + 18% = ₹5,900).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           billing_cycle, line_items, is_one_off, created_date) values
  ('Q-R2627-A',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup A","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01'),
  ('Q-R2627-B',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup B","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01'),
  ('Q-R2627-C',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 5900, 5000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup C","qty":1,"rate":5000,"one_time":true}]'::jsonb, true, '2026-09-01'),
  ('Q-R2627-E',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup E","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01'),
  ('Q-R2627-F',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup F","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01'),
  ('Q-R2627-G',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup G","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-08-01'),
  ('Q-R2627-H',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup H","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-09-01');

-- I: a sale booked from a bank receipt (invoice_on_receipt, R-2095) is invoiced on its FIRST receipt, part-paid or not.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           billing_cycle, line_items, is_one_off, created_date, invoice_on_receipt) values
  ('Q-R2627-I',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup I","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-08-15', true);

-- Quotes that already have their invoice (B's other item, D).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           billing_cycle, line_items, is_one_off, created_date) values
  ('Q-R2627-BI', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup BI","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-08-01'),
  ('Q-R2627-D',  'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 1180, 1000, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup D","qty":1,"rate":1000,"one_time":true}]'::jsonb, true, '2026-08-01');
insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2627-BI', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 'Q-R2627-BI',
   1180, 1180, 'pending', '2026-08-01', '2026-08-31', 1000, 180, 18, false, 0, 'tax_invoice', '[{"name":"Setup BI","qty":1,"rate":1000}]'::jsonb),
  ('INV-R2627-D', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 'Q-R2627-D',
   1180, 1180, 'pending', '2026-08-01', '2026-08-31', 1000, 180, 18, false, 0, 'tax_invoice', '[{"name":"Setup D","qty":1,"rate":1000}]'::jsonb);
update public.quotes set invoice_id = 'INV-R2627-BI' where id = 'Q-R2627-BI';
update public.quotes set invoice_id = 'INV-R2627-D' where id = 'Q-R2627-D';

-- C: an OLD one-off bank sale (pre-R-1838 shape) on the 10 Sep line, to relink.
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date, notes) values
  ('Q-R2627-OLD', 'b2627000-0000-0000-0000-0000000000f0', 'b2627000-0000-0000-0000-0000000000c1', 'R2627 Buyer', 'Setup',
   5900, 5000, 0, 18, 'accepted', 'awaiting', 'yearly', '[{"name":"Setup","qty":1,"rate":5000,"one_time":true}]'::jsonb, true,
   '2026-09-10', 'Raised from a bank receipt (reconcile)');

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.received(p_quote text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where quote_id = p_quote and status = 'received' $f$;
create function pg_temp.inv_of(p_quote text) returns text language sql as $f$
  select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.matched(p_txn uuid) returns text language sql as $f$
  select matched_to_type from public.bank_transactions where id = p_txn $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.received(text), pg_temp.inv_of(text), pg_temp.matched(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2627000-0000-0000-0000-0000000000a1');

do $$
declare r jsonb;
begin
  r := public.record_desk_payment('Q-R2627-OLD', 5900, 'bank_transfer', 'R2627UTRC', 'Reconciled from bank receipt',
         null, 0, '2026-09-10', 'b2627000-0000-0000-0000-0000000000d1');
  perform public.generate_invoice('Q-R2627-OLD');
  perform public.reconcile_bank_txn('b2627000-0000-0000-0000-0000000000e3', 'payment', r->>'payment_id', 'manual');
  if pg_temp.inv_of('Q-R2627-OLD') is null then raise exception 'SETUP C: the old sale has no invoice'; end if;
  if public.set_gst_filed_through('2026-09-15') <> '2026-09-30' then raise exception 'SETUP: GST filed month not stored'; end if;
end $$;

-- ── A. An open quote, paid by hand from a filed-month line → refused, nothing saved ──────────────
do $$
declare v_msg text; ok boolean; i int;
begin
  for i in 1 .. 2 loop   -- a retry is refused the same
    ok := false;
    begin
      perform public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e1', 'Q-R2627-A', null);
    exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
    end;
    if not ok or v_msg not like 'GST for Sep 2026 is already filed (GST returns are filed up to September 2026 %), so quote Q-R2627-A cannot get a new tax invoice dated 20 Sep 2026%Nothing was saved.%Advance — nothing to invoice yet%' then
      raise exception 'FAIL A: paying an open quote on a filed day was not refused (try %: %)', i, v_msg; end if;
  end loop;
  if pg_temp.received('Q-R2627-A') <> 0 or pg_temp.inv_of('Q-R2627-A') is not null
     or exists (select 1 from public.invoices where quote_id = 'Q-R2627-A')
     or pg_temp.matched('b2627000-0000-0000-0000-0000000000e1') is not null then
    raise exception 'FAIL A: something was saved (received %, invoice %)', pg_temp.received('Q-R2627-A'), pg_temp.inv_of('Q-R2627-A'); end if;
  raise notice 'PASS A: open quote on 20 Sep 2026 (filed) refused twice, nothing saved — %', v_msg;
end $$;

-- ── B. Several quotes / invoices: an existing invoice + the quote → refused as a whole ───────────
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_split('b2627000-0000-0000-0000-0000000000e2', 'b2627000-0000-0000-0000-0000000000c1',
              '[{"invoice_id":"INV-R2627-BI","amount":1180},{"quote_id":"Q-R2627-B","amount":1180}]'::jsonb, null, null);
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Sep 2026 is already filed%quote Q-R2627-B cannot get a new tax invoice dated 21 Sep 2026%' then
    raise exception 'FAIL B: split with an open quote on a filed day was not refused (%)', v_msg; end if;
  if (select coalesce(paid_amount, 0) from public.invoices where id = 'INV-R2627-BI') <> 0
     or pg_temp.received('Q-R2627-B') <> 0 or pg_temp.inv_of('Q-R2627-B') is not null
     or pg_temp.matched('b2627000-0000-0000-0000-0000000000e2') is not null then
    raise exception 'FAIL B: the split was half-booked'; end if;
  raise notice 'PASS B: split (existing invoice + open quote) on 21 Sep 2026 refused, nothing half-booked';
end $$;

-- ── C. Relink an old one-off sale to the open quote → refused, the old sale stays ────────────────
do $$
declare v_msg text; ok boolean := false; v_old text := pg_temp.inv_of('Q-R2627-OLD');
begin
  begin
    perform public.relink_bank_one_off_sale('b2627000-0000-0000-0000-0000000000e3',
              jsonb_build_object('path', 'item', 'quote_id', 'Q-R2627-C'));
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Sep 2026 is already filed%quote Q-R2627-C cannot get a new tax invoice dated 10 Sep 2026%' then
    raise exception 'FAIL C: relink to an open quote on a filed day was not refused (%)', v_msg; end if;
  if pg_temp.received('Q-R2627-OLD') <> 5900 or (select status::text from public.invoices where id = v_old) <> 'paid'
     or pg_temp.matched('b2627000-0000-0000-0000-0000000000e3') is distinct from 'payment'
     or pg_temp.received('Q-R2627-C') <> 0 or pg_temp.inv_of('Q-R2627-C') is not null then
    raise exception 'FAIL C: the old sale was undone or the quote was paid'; end if;
  raise notice 'PASS C: relink (path item) on 10 Sep 2026 refused, the old one-off sale % stays', v_old;
end $$;

-- ── D. An existing invoice is still paid from a filed-month line ─────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e4', null, 'INV-R2627-D');
  if (select status::text from public.invoices where id = 'INV-R2627-D') <> 'paid'
     or (select count(*) from public.invoices where quote_id = 'Q-R2627-D') <> 1
     or pg_temp.matched('b2627000-0000-0000-0000-0000000000e4') is distinct from 'payment' then
    raise exception 'FAIL D: the existing invoice was not paid (%)', r; end if;
  raise notice 'PASS D: existing INV-R2627-D paid from the 22 Sep 2026 line, no new invoice';
end $$;

-- ── H. A part payment raises no invoice → recorded on a filed day ────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e8', 'Q-R2627-H', null);
  if pg_temp.received('Q-R2627-H') <> 500 or pg_temp.inv_of('Q-R2627-H') is not null
     or pg_temp.matched('b2627000-0000-0000-0000-0000000000e8') is distinct from 'payment' then
    raise exception 'FAIL H: part payment (no invoice) on a filed day not recorded (%)', r; end if;
  raise notice 'PASS H: ₹500 part payment on 23 Sep 2026 recorded, no invoice, not refused';
end $$;

-- ── I. Part payment on an invoice-on-receipt quote raises the invoice → refused ──────────────────
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e9', 'Q-R2627-I', null);
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Sep 2026 is already filed%quote Q-R2627-I cannot get a new tax invoice dated 24 Sep 2026%' then
    raise exception 'FAIL I: part payment that raises the invoice on a filed day was not refused (%)', v_msg; end if;
  if pg_temp.received('Q-R2627-I') <> 0 or pg_temp.inv_of('Q-R2627-I') is not null then raise exception 'FAIL I: something was saved'; end if;
  raise notice 'PASS I: ₹500 of an invoice-on-receipt quote on 24 Sep 2026 (would invoice) refused';
end $$;

-- ── E. Open month: as before ─────────────────────────────────────────────────────────────────────
do $$
declare r jsonb; v_inv text;
begin
  r := public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e5', 'Q-R2627-E', null);
  v_inv := pg_temp.inv_of('Q-R2627-E');
  if v_inv is null or (select invoice_date from public.invoices where id = v_inv) <> '2026-10-05' then
    raise exception 'FAIL E: open-month quote not invoiced on the bank date (%)', r; end if;
  raise notice 'PASS E: 5 Oct 2026 (open) → quote paid, invoice % dated 5 Oct as before', v_inv;
end $$;

-- ── F. GSTR-1 for Oct 2026 marked filed → refused the same ──────────────────────────────────────
reset role;
insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date) values
  ('b2627000-0000-0000-0000-0000000000f0', 'gst_gstr1', '2026-10', '2026-11-08');
set local role authenticated;
select pg_temp.as_user('b2627000-0000-0000-0000-0000000000a1');
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e6', 'Q-R2627-F', null);
  exception when check_violation then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg not like 'GST for Oct 2026 is already filed (GSTR-1 for Oct 2026 is marked filed%' then
    raise exception 'FAIL F: GSTR-1 mark did not refuse (%)', v_msg; end if;
  if pg_temp.received('Q-R2627-F') <> 0 or pg_temp.inv_of('Q-R2627-F') is not null then raise exception 'FAIL F: something was saved'; end if;
  raise notice 'PASS F: GSTR-1 Oct 2026 marked filed → 7 Oct quote payment refused';
end $$;

-- ── G. Books lock only: the receipt is refused by the books-lock rule itself, never by R-2627 ──────
do $$
begin
  if public.set_gst_filed_through(null) is not null then raise exception 'SETUP G: the setting did not clear'; end if;
end $$;
reset role;
update public.tenants set books_locked_until = '2026-08-31' where id = 'b2627000-0000-0000-0000-0000000000f0';
set local role authenticated;
select pg_temp.as_user('b2627000-0000-0000-0000-0000000000a1');
do $$
declare v_msg text; ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2627000-0000-0000-0000-0000000000e7', 'Q-R2627-G', null);
  exception when others then ok := true; get stacked diagnostics v_msg = message_text;
  end;
  if not ok or v_msg like 'GST for%' or v_msg not like '%31 Aug 2026%lock%' then
    raise exception 'FAIL G: books-lock-only line not refused by the lock rule (%)', v_msg; end if;
  raise notice 'PASS G: books locked to 31 Aug 2026 → the 20 Aug receipt is refused by the lock rule (unchanged), not R-2627';
end $$;

rollback;
