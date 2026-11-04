-- R-2466 (4 Nov 2026, p1 money): Banking → Reconcile sheet → "An open quote / invoice" said
-- "<customer> has nothing open" for a customer whose only open invoices have no quote. Migration
-- 20261104045700_r2466_quoteless_invoice_bank_credit (bank_credit_open_items + bank_credit_pay_item).
-- Self-asserting, ONE transaction, rolled back. Local/test DB only.
-- RED without the migration (A: the Zoho opening invoice is not listed).
--
-- Why a quote-less invoice was left out (R-1838): a payment is keyed by its quote; only an imported
-- Zoho opening invoice (R-1739) may take a payment without one (trg_payments_opening_invoice), and
-- "This money is for" had no path for it. The real quote-less open invoices are those opening
-- invoices and subscription instalments (already listed). A tax invoice with no quote, no
-- instalment and no project link has no payment path anywhere in the app, so it stays out.
--
--   A. bank_credit_open_items lists the opening invoice — kind 'opening', its due, no quote; the
--      sheet's currency + rate columns: ₹ for it, USD @ 83 for an export invoice from a USD quote.
--   B. "This money is for" (reconcile_bank_credit_to_item) on it: two ₹5,000 lines with the SAME
--      placeholder reference → two receipts on the invoice (quote_id null, R-2430 BANK-<line id>),
--      ₹10,000 paid, each line matched to its own receipt.
--   C. The same line booked again (un-reconciled keeping the receipt) → the same receipt, booked once.
--   D. More than its due → refused, nothing saved.
--   E. TDS: ₹5,310 + ₹590 TDS settles a ₹5,900 opening invoice → paid, one TDS receivable row.
--   F. Split (reconcile_bank_credit_split): ₹2,360 on an opening invoice + ₹640 advance.
--   G. Books locked up to the line's date → refused, nothing saved.
--   H. Another company's login: nothing listed, booking refused.
--   I. A tax invoice with no quote / instalment / project link is still not listed (no path).

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code, lut_number, lut_valid_upto) values
  ('dddddddd-0000-0000-0000-000000246601','R2466 Co','r2466@example.in','07','R2466','AD070426000166X','2027-03-31'),
  ('dddddddd-0000-0000-0000-000000246602','R2466 Other Co','r2466b@example.in','07','XQ66',null,null);
insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
select 'dddddddd-0000-0000-0000-000000246601'::uuid, g.fy::date, 'AD07TESTLUT' || to_char(g.fy, 'YY'), g.fy::date, (g.fy + interval '1 year' - interval '1 day')::date
  from generate_series('2024-04-01'::date, public.lut_fy_start(public.ist_today()), interval '1 year') as g(fy)
on conflict (tenant_id, fy_start) do nothing;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000246601','owner2466@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000246602','owner2466b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000246601','dddddddd-0000-0000-0000-000000246601','owner2466@example.in','Owner 2466','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000246602','dddddddd-0000-0000-0000-000000246602','owner2466b@example.in','Owner 2466B','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000246601','dddddddd-0000-0000-0000-000000246601','Zoho Old 2466','07','India','zohoold2466.in'),
  ('cccccccc-0000-0000-0000-000000246602','dddddddd-0000-0000-0000-000000246601','Timber 2466 Inc',null,'United States','timber2466.example');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000246601','dddddddd-0000-0000-0000-000000246601','HDFC Current','HDFC');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000246601','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-20','NEFT ZOHO OLD PART 1',0,5000,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000246602','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-21','NEFT ZOHO OLD PART 2',0,5000,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000246603','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-22','NEFT ZOHO OLD TOO MUCH',0,5000,'R2466UTR000003','manual'),
  ('11111111-0000-0000-0000-000000246604','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-23','NEFT ZOHO OLD TDS',0,5310,'R2466UTR000004','manual'),
  ('11111111-0000-0000-0000-000000246605','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-24','NEFT ZOHO OLD SPLIT',0,3000,'R2466UTR000005','manual'),
  ('11111111-0000-0000-0000-000000246606','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-03-10','NEFT ZOHO OLD LOCKED',0,1000,'R2466UTR000006','manual');

-- A USD export sale (quote $2,000 @ ₹84 = ₹1,68,000, 0% under LUT) and a quote-less tax invoice (I).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date, currency, exchange_rate)
values ('Q-R2466-USD', 'dddddddd-0000-0000-0000-000000246601', 'cccccccc-0000-0000-0000-000000246602', 'Timber 2466 Inc',
        168000, 168000, 0, 0, 'accepted', 'awaiting', 'yearly',
        '[{"name": "Export services", "qty": 1, "rate": 168000, "one_time": true}]'::jsonb, true, '2026-09-20', 'USD', 84);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
  ('INV-R2466-NOQ', 'dddddddd-0000-0000-0000-000000246601', 'cccccccc-0000-0000-0000-000000246601', 'Zoho Old 2466', 1180, 'pending',
   '2026-09-25', '2026-10-25', 1000, 180, 18, false, 0, 'tax_invoice', '[{"name": "x", "qty": 1, "rate": 1000}]'::jsonb);

-- J (coordinator, 4 Nov): a subscription billed quarterly — raise_subscription_billing raises each
-- part's invoice with quote_id NULL on purpose; it is listed through its subscription_billings row.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R2466-SUB', 'dddddddd-0000-0000-0000-000000246601', 'cccccccc-0000-0000-0000-000000246601', 'Zoho Old 2466', 9440, 8000, 18, 'accepted', 'none', '[]'::jsonb, null);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id) values
  ('eeeeeeee-0000-0000-0000-000000246601', 'dddddddd-0000-0000-0000-000000246601', 'cccccccc-0000-0000-0000-000000246601', 'Zoho Old 2466',
   'Workspace Starter', 'google'::vendor, 2, 667, 'quarterly'::billing_cycle, 'Q-R2466-SUB');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate) values
  ('eeeeeeee-0000-0000-0000-000000246611', 'dddddddd-0000-0000-0000-000000246601', 'eeeeeeee-0000-0000-0000-000000246601',
   '2026-07-01', 1, '2026-07-01', '2026-07-01', '2026-09-28', 2000, 18);
create temp table r2466_inst (id text) on commit drop;
insert into r2466_inst select invoice_id from public.raise_subscription_billing('eeeeeeee-0000-0000-0000-000000246611');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000246607','dddddddd-0000-0000-0000-000000246601','bbbbbbbb-0000-0000-0000-000000246601','2026-10-25','NEFT ZOHO OLD QUARTER',0,2360,'R2466UTR000007','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000246601","role":"authenticated"}', true);
select public.generate_invoice('Q-R2466-USD');

-- Three Zoho opening invoices (R-1739 import): ₹11,800, ₹5,900 and ₹2,360, nothing paid.
select public.import_opening_invoices(
  '[{"number":"ZB-R2466-1","invoice_date":"2026-02-10","due_date":"2026-03-12","customer_id":"cccccccc-0000-0000-0000-000000246601","total":11800,"balance":11800},
    {"number":"ZB-R2466-2","invoice_date":"2026-02-11","due_date":"2026-03-13","customer_id":"cccccccc-0000-0000-0000-000000246601","total":5900,"balance":5900},
    {"number":"ZB-R2466-3","invoice_date":"2026-02-12","due_date":"2026-03-14","customer_id":"cccccccc-0000-0000-0000-000000246601","total":2360,"balance":2360}]'::jsonb,
  'Invoice.csv');

create function pg_temp.opn(p_no text) returns text language sql as $f$
  select id from public.invoices where upper(external_number) = upper(p_no) and document_kind = 'opening_invoice' $f$;
create function pg_temp.received(p_inv text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where invoice_id = p_inv and status = 'received' $f$;

-- ── A. listed ────────────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int;
begin
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246601') o where o.invoice_id = pg_temp.opn('ZB-R2466-1');
  if not found then raise exception 'FAIL A: the Zoho opening invoice is not in the open items — "has nothing open"'; end if;
  if r.kind <> 'opening' or r.amount_due <> 11800 or r.quote_id is not null then
    raise exception 'FAIL A: opening row kind % due % quote % (want opening / 11800 / null)', r.kind, r.amount_due, r.quote_id; end if;
  if r.currency <> 'INR' then raise exception 'FAIL A: opening row currency % (want INR)', r.currency; end if;
  select count(*) into n from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246601') o where o.kind = 'opening';
  if n <> 3 then raise exception 'FAIL A: % opening rows (want 3)', n; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246602') o where o.quote_id = 'Q-R2466-USD';
  if not found or r.invoice_id is null or r.currency <> 'USD' or r.fx_rate <> 84 or r.amount_due <> 168000 then
    raise exception 'FAIL A: USD invoice row % (want invoice, USD @ 84, ₹1,68,000 due)', to_jsonb(r); end if;
  raise notice 'PASS A: opening invoices listed (kind opening, due, ₹); the USD invoice carries USD @ 84';
end $$;

-- ── B. two zero-ref lines → two receipts on the opening invoice ──────────────────────────────
do $$
declare r1 jsonb; r2 jsonb; v_inv text := pg_temp.opn('ZB-R2466-1'); p record;
begin
  r1 := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246601', null, v_inv);
  r2 := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246602', null, v_inv);
  if r1->>'payment_id' = r2->>'payment_id' then raise exception 'FAIL B: the second line was a replay of the first'; end if;
  if pg_temp.received(v_inv) <> 10000 then raise exception 'FAIL B: ₹% received (want 10,000)', pg_temp.received(v_inv); end if;
  if (select paid_amount from public.invoices where id = v_inv) <> 10000
     or (select status::text from public.invoices where id = v_inv) = 'paid' then
    raise exception 'FAIL B: invoice paid_amount % status % (want 10000, not paid)',
      (select paid_amount from public.invoices where id = v_inv), (select status from public.invoices where id = v_inv); end if;
  select * into p from public.payments where id = (r2->>'payment_id')::uuid;
  if p.quote_id is not null or p.invoice_id <> v_inv or p.reference <> 'BANK-11111111-0000-0000-0000-000000246602'
     or p.bank_account_id <> 'bbbbbbbb-0000-0000-0000-000000246601' or p.receipt_voucher_no is null
     or (p.received_at at time zone 'UTC')::date <> '2026-10-21' then
    raise exception 'FAIL B: receipt % (want no quote, the invoice, BANK-<line id>, the bank account, a voucher, the bank date)', to_jsonb(p); end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000246602') <> r2->>'payment_id' then
    raise exception 'FAIL B: line 2 not matched to its own receipt'; end if;
  if r2->>'kind' <> 'opening' or r2->>'invoice_id' <> v_inv or (r2->>'amount')::int <> 5000 then
    raise exception 'FAIL B: result %', r2; end if;
  raise notice 'PASS B: two ₹5,000 zero-ref lines → two receipts on the opening invoice, ₹10,000 paid';
end $$;

-- ── C. the same line again → the same receipt ────────────────────────────────────────────────
do $$
declare v_pay text; r jsonb; v_inv text := pg_temp.opn('ZB-R2466-1');
begin
  v_pay := (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000246602');
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000246602', false);   -- keep the receipt
  if pg_temp.received(v_inv) <> 10000 then raise exception 'FAIL C: un-reconcile (keep) changed the receipts: ₹%', pg_temp.received(v_inv); end if;
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246602', null, v_inv);
  if r->>'payment_id' <> v_pay or not (r->>'already_recorded')::boolean then
    raise exception 'FAIL C: re-reconciling made receipt % (want the same %, already_recorded)', r->>'payment_id', v_pay; end if;
  if pg_temp.received(v_inv) <> 10000 then raise exception 'FAIL C: ₹% after the retry (want 10,000)', pg_temp.received(v_inv); end if;
  raise notice 'PASS C: the same line booked twice → one receipt';
end $$;

-- ── D. more than its due → refused ───────────────────────────────────────────────────────────
do $$
declare v_inv text := pg_temp.opn('ZB-R2466-1');
begin
  begin
    perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246603', null, v_inv);
    raise exception 'FAIL D: ₹5,000 on ₹1,800 due was accepted';
  exception when check_violation then
    if sqlerrm not like '%only ₹1800 due%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 10000
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000246603') is not null then
    raise exception 'FAIL D: something was saved'; end if;
  raise notice 'PASS D: more than the opening invoice''s due → refused, nothing saved';
end $$;

-- ── E. TDS ───────────────────────────────────────────────────────────────────────────────────
do $$
declare r jsonb; v_inv text := pg_temp.opn('ZB-R2466-2'); n int;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246604', null, v_inv, 590, 10, '194J');
  if (select status::text from public.invoices where id = v_inv) <> 'paid' or pg_temp.received(v_inv) <> 5900 then
    raise exception 'FAIL E: invoice % with ₹% received (want paid, 5,900)', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv); end if;
  select count(*) into n from public.tds_receivable where invoice_id = v_inv and tds_amount = 590 and net_paid = 5310 and payment_id = (r->>'payment_id')::uuid;
  if n <> 1 then raise exception 'FAIL E: % TDS rows of ₹590 / net ₹5,310 (want 1)', n; end if;
  if (select paid_date from public.invoices where id = v_inv) <> '2026-10-23' then
    raise exception 'FAIL E: paid on % (want the bank date 2026-10-23)', (select paid_date from public.invoices where id = v_inv); end if;
  raise notice 'PASS E: ₹5,310 + ₹590 TDS settles the ₹5,900 opening invoice';
end $$;

-- ── F. split: opening invoice + advance ──────────────────────────────────────────────────────
do $$
declare r jsonb; v_inv text := pg_temp.opn('ZB-R2466-3');
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000246605', 'cccccccc-0000-0000-0000-000000246601',
         jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 2360)), null, 'advance');
  if (select status::text from public.invoices where id = v_inv) <> 'paid' or pg_temp.received(v_inv) <> 2360 then
    raise exception 'FAIL F: opening invoice % / ₹% (want paid / 2,360) — %', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv), r; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000246605') is null then
    raise exception 'FAIL F: the split line is not reconciled'; end if;
  raise notice 'PASS F: split — ₹2,360 on the opening invoice + ₹640 advance';
end $$;

-- ── G. books locked ──────────────────────────────────────────────────────────────────────────
do $$
declare v_inv text := pg_temp.opn('ZB-R2466-1');
begin
  update public.tenants set books_locked_until = '2026-03-31' where id = 'dddddddd-0000-0000-0000-000000246601';
  begin
    perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246606', null, v_inv);
    raise exception 'FAIL G: a receipt dated inside locked books was saved';
  exception when others then
    if sqlerrm like 'FAIL G%' then raise; end if;
    if sqlerrm not ilike '%lock%' then raise exception 'FAIL G: wrong refusal: %', sqlerrm; end if;
  end;
  update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000246601';
  if pg_temp.received(v_inv) <> 10000 then raise exception 'FAIL G: something was saved'; end if;
  raise notice 'PASS G: books locked → refused, nothing saved';
end $$;

-- ── H. another company's login ───────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000246602","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246601');
  if n <> 0 then raise exception 'FAIL H: another company sees % open items', n; end if;
  begin
    perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246603', null, pg_temp.opn('ZB-R2466-1'));
    raise exception 'FAIL H: another company booked on this line';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS H: another company — nothing listed, booking refused';
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000246601","role":"authenticated"}', true);

-- ── I. a quote-less tax invoice with no payment path stays out ───────────────────────────────
do $$
begin
  if exists (select 1 from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246601') o where o.invoice_id = 'INV-R2466-NOQ') then
    raise exception 'FAIL I: a tax invoice with no quote / instalment / project link is listed (it cannot take a payment)'; end if;
  raise notice 'PASS I: a quote-less tax invoice with no payment path is still left out';
end $$;

-- ── J. a subscription-billing (instalment) invoice — quote_id NULL — is listed and paid ─────
do $$
declare r record; v_inv text := (select id from r2466_inst limit 1); res jsonb;
begin
  if v_inv is null or (select quote_id from public.invoices where id = v_inv) is not null then
    raise exception 'FAIL J: setup — raise_subscription_billing gave % (want an invoice with quote_id NULL)', v_inv; end if;
  select * into r from public.bank_credit_open_items('cccccccc-0000-0000-0000-000000246601') o where o.invoice_id = v_inv;
  if not found or r.kind <> 'instalment' or r.amount_due <> 2360 or r.quote_id is not null
     or r.subscription_id <> 'eeeeeeee-0000-0000-0000-000000246601' then
    raise exception 'FAIL J: instalment row % (want instalment, ₹2,360 due, its subscription)', to_jsonb(r); end if;
  res := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000246607', null, v_inv);
  if (select status::text from public.invoices where id = v_inv) <> 'paid' then
    raise exception 'FAIL J: instalment invoice % after ₹2,360 (want paid) — %', (select status from public.invoices where id = v_inv), res; end if;
  raise notice 'PASS J: a quote-less subscription-billing invoice is listed (instalment) and paid from the line';
end $$;

rollback;
