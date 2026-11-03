-- R-2427 (3 Nov 2026, p1 money): export receipts — an inward remittance that pays an EXISTING
-- foreign-currency invoice at another rate (forex gain / loss), and a short remittance where the
-- remitting bank kept charges abroad (Bank Charges, not TDS). Migration
-- 20261103223644_r2427_export_receipt_fx (reconcile_bank_credit_fx_invoice, the 12-argument
-- reconcile_bank_credit_new_sale_fx, tg_bank_fx_line_unmatched).
-- Self-asserting, ONE transaction, rolled back. Local/test DB only.
-- RED without the migration (A: reconcile_bank_credit_fx_invoice does not exist).
--
--   A. USD invoice $1,000 at ₹83 (₹83,000 due), the bank credits "USD1000.0@84.5" = ₹84,500 →
--      ONE receipt of ₹83,000 settles the invoice in full (paid), the line is matched to it, and
--      the ₹1,500 difference is a "Foreign Exchange Gain / Loss" line of −₹1,500 (a gain) on the
--      bank line's date; no Bank Charges; no settlement shortfall for that receipt.
--   B. USD invoice $1,024 at ₹93.60 (₹95,846 due), the bank credits "USD1000.0@93.6" = ₹93,600 →
--      the invoice is paid in full; the $24 short × ₹93.60 = ₹2,246 is a Bank Charges line; no
--      forex line (same rate); no TDS.
--   C. Refused, nothing booked: a narration that is not the call's figures; a ₹ invoice; a
--      remittance 12% short (a part payment, not charges); an invoice of another company; a
--      reconciled line again.
--   D. New sale short (12-argument reconcile_bank_credit_new_sale_fx): Zoho billed $1,024, the bank
--      got $1,000 @ 93.6 → the sale of ₹95,846 is paid in full, its invoice is USD @ 93.6, and
--      ₹2,246 is a Bank Charges line.
--   E. Un-reconciling A's line removes its forex line (and the receipt is no longer on the line).

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
  ('dddddddd-0000-0000-0000-000000242701','R2427 Export Co','r2427@example.in','07','R2427','AD070426000127X','2027-03-31'),
  ('dddddddd-0000-0000-0000-000000242702','R2427 Other Co','r2427b@example.in','07','XQ27',null,null);
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000242701','owner2427@example.in'), ('aaaaaaaa-0000-0000-0000-000000242702','owner2427b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000242701','dddddddd-0000-0000-0000-000000242701','owner2427@example.in','Owner 2427','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000242702','dddddddd-0000-0000-0000-000000242702','owner2427b@example.in','Owner 2427B','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000242701','dddddddd-0000-0000-0000-000000242701','Design Box LLC',null,'United States','designbox2427.example'),
  ('cccccccc-0000-0000-0000-000000242702','dddddddd-0000-0000-0000-000000242701','Acme India 2427','07','India','acme2427.in'),
  ('cccccccc-0000-0000-0000-000000242703','dddddddd-0000-0000-0000-000000242702','Other LLC',null,'United States','other2427.example');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000242701','dddddddd-0000-0000-0000-000000242701','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000242702','dddddddd-0000-0000-0000-000000242702','HDFC Current','HDFC');

-- One-off quotes: Q-A $1,000 @ 83, Q-B $1,024 @ 93.6, Q-C $1,000 @ 90 (refusals), Q-INR ₹10,000,
-- Q-OTHER another company's.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date,
                           currency, exchange_rate)
select v.id, v.tenant, v.cust, v.cname, v.amt, v.amt, 0, 0, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Website ' || v.id, 'qty', 1, 'rate', v.amt, 'one_time', true)),
       true, '2026-07-01', v.cur, v.rate
  from (values
    ('Q-R2427-A',     'dddddddd-0000-0000-0000-000000242701'::uuid, 'cccccccc-0000-0000-0000-000000242701'::uuid, 'Design Box LLC',  83000, 'USD', 83::numeric),
    ('Q-R2427-B',     'dddddddd-0000-0000-0000-000000242701'::uuid, 'cccccccc-0000-0000-0000-000000242701'::uuid, 'Design Box LLC',  95846, 'USD', 93.6::numeric),
    ('Q-R2427-C',     'dddddddd-0000-0000-0000-000000242701'::uuid, 'cccccccc-0000-0000-0000-000000242701'::uuid, 'Design Box LLC',  90000, 'USD', 90::numeric),
    ('Q-R2427-INR',   'dddddddd-0000-0000-0000-000000242701'::uuid, 'cccccccc-0000-0000-0000-000000242702'::uuid, 'Acme India 2427', 10000, 'INR', 1::numeric),
    ('Q-R2427-OTHER', 'dddddddd-0000-0000-0000-000000242702'::uuid, 'cccccccc-0000-0000-0000-000000242703'::uuid, 'Other LLC',       83000, 'USD', 83::numeric)
  ) as v(id, tenant, cust, cname, amt, cur, rate);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000242701','dddddddd-0000-0000-0000-000000242701','bbbbbbbb-0000-0000-0000-000000242701','2026-08-07','INW 070826I049900001 USD1000.0@84.5',0,84500,'INW070826I049900001','manual'),
  ('11111111-0000-0000-0000-000000242702','dddddddd-0000-0000-0000-000000242701','bbbbbbbb-0000-0000-0000-000000242701','2026-08-08','INW 080826I049900002 USD1000.0@93.6',0,93600,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000242703','dddddddd-0000-0000-0000-000000242701','bbbbbbbb-0000-0000-0000-000000242701','2026-08-09','INW 090826I049900003 USD880.0@90',0,79200,null,'manual'),
  ('11111111-0000-0000-0000-000000242704','dddddddd-0000-0000-0000-000000242701','bbbbbbbb-0000-0000-0000-000000242701','2026-08-10','INW 100826I049900004 USD1000.0@93.6',0,93600,'INW100826I049900004','manual'),
  ('11111111-0000-0000-0000-000000242705','dddddddd-0000-0000-0000-000000242702','bbbbbbbb-0000-0000-0000-000000242702','2026-08-11','INW 110826I049900005 USD1000.0@84.5',0,84500,null,'manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000242701","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R2427-A','Q-R2427-B','Q-R2427-C','Q-R2427-INR']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;

do $$
declare
  c_t   constant uuid := 'dddddddd-0000-0000-0000-000000242701';
  r jsonb; ok boolean; v_msg text; n int; i record; p record; e record; v_inv text;
begin
  -- The fixture: the invoices carry the quote's currency and rate (trg_invoice_fx_snapshot).
  select currency, fx_rate, amount into i from public.invoices where id = pg_temp.inv('Q-R2427-A');
  if i.currency is distinct from 'USD' or i.fx_rate is distinct from 83 or i.amount <> 83000 then
    raise exception 'FIXTURE: invoice A is % % ₹%', i.currency, i.fx_rate, i.amount;
  end if;

  -- ── A. paid at another rate → forex gain ───────────────────────────────────────────────
  v_inv := pg_temp.inv('Q-R2427-A');
  r := public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242701', v_inv, 'USD', 84.5, 1000);
  select status, paid_amount into i from public.invoices where id = v_inv;
  if i.status <> 'paid' or i.paid_amount <> 83000 then raise exception 'FAIL A: invoice is % with ₹% paid', i.status, i.paid_amount; end if;
  select id, amount, bank_txn_id into p from public.payments where quote_id = 'Q-R2427-A' and status = 'received';
  if p.amount <> 83000 then raise exception 'FAIL A: receipt is ₹%, not the ₹83,000 due', p.amount; end if;
  if p.bank_txn_id is distinct from '11111111-0000-0000-0000-000000242701'::uuid then raise exception 'FAIL A: receipt not tied to the bank line'; end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000242701') is distinct from p.id::text then
    raise exception 'FAIL A: line not matched to the receipt';
  end if;
  select category, amount, expense_date, reconciled_txn_id, paid into e from public.expenses
   where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000242701' and category = 'Foreign Exchange Gain / Loss';
  if not found or e.amount <> -1500 or e.expense_date <> '2026-08-07' or not e.paid then
    raise exception 'FAIL A: forex line is % % % %', e.category, e.amount, e.expense_date, e.paid;
  end if;
  select count(*) into n from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000242701' and category = 'Bank Charges';
  if n <> 0 then raise exception 'FAIL A: % bank charges lines on a full remittance', n; end if;
  if (r->>'forex_difference')::int <> -1500 or (r->>'bank_charges')::int <> 0 or not (r->>'is_fully_paid')::boolean then
    raise exception 'FAIL A: result %', r;
  end if;
  select count(*) into n from public.report_settlement_shortfalls('2026-04-01', '2027-03-31') s where s.payment_id = p.id;
  if n <> 0 then raise exception 'FAIL A: the receipt also shows as a settlement shortfall'; end if;
  raise notice 'A PASS: $1,000 @ 83 paid at 84.5 → invoice paid, receipt ₹83,000, forex gain ₹1,500';

  -- ── B. short remittance → Bank Charges ────────────────────────────────────────────────
  v_inv := pg_temp.inv('Q-R2427-B');
  r := public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242702', v_inv, 'USD', 93.6, 1000);
  select status, paid_amount into i from public.invoices where id = v_inv;
  if i.status <> 'paid' or i.paid_amount <> 95846 then raise exception 'FAIL B: invoice is % with ₹% paid', i.status, i.paid_amount; end if;
  select amount, reference into p from public.payments where quote_id = 'Q-R2427-B' and status = 'received';
  if p.reference <> 'BANK-11111111-0000-0000-0000-000000242702' then raise exception 'FAIL B: placeholder ref kept as %', p.reference; end if;
  select amount into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000242702' and category = 'Bank Charges';
  if not found or e.amount <> 2246 then raise exception 'FAIL B: bank charges line %', e.amount; end if;
  select count(*) into n from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000242702' and category = 'Foreign Exchange Gain / Loss';
  if n <> 0 then raise exception 'FAIL B: a forex line at the same rate'; end if;
  select count(*) into n from public.tds_receivable where tenant_id = c_t;
  if n <> 0 then raise exception 'FAIL B: the short part was booked as TDS'; end if;
  raise notice 'B PASS: $1,000 received on $1,024 due → invoice paid, Bank Charges ₹2,246';

  -- ── C. refusals ───────────────────────────────────────────────────────────────────────
  v_inv := pg_temp.inv('Q-R2427-C');
  ok := false;
  begin
    perform public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242703', v_inv, 'USD', 90, 1000);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'The bank narration says USD 880 @ ₹90%';
    if not ok then raise exception 'FAIL C1: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL C1: figures that are not the narration were booked'; end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242703', v_inv, 'USD', 90, 880);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%part payment%';
    if not ok then raise exception 'FAIL C2: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL C2: a 12%% short remittance was booked as bank charges'; end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242704', pg_temp.inv('Q-R2427-INR'), 'USD', 93.6, 1000);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%is in ₹%';
    if not ok then raise exception 'FAIL C3: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL C3: a ₹ invoice was paid as a USD remittance'; end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242701', pg_temp.inv('Q-R2427-C'), 'USD', 84.5, 1000);
  exception when check_violation then
    ok := true;
  end;
  if not ok then raise exception 'FAIL C4: a reconciled line was booked again'; end if;
  if (select status from public.invoices where id = v_inv) <> 'pending' then raise exception 'FAIL C: invoice C changed'; end if;
  if exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000242703','11111111-0000-0000-0000-000000242704') and matched_to_type is not null) then
    raise exception 'FAIL C: a refused line was reconciled';
  end if;
  raise notice 'C PASS: wrong figures, part payment, ₹ invoice and a reconciled line refused';

  -- ── D. new sale, short remittance ─────────────────────────────────────────────────────
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000242704', 'cccccccc-0000-0000-0000-000000242701',
         '[{"item_id":null,"name":"Website design","qty":1,"rate":95846,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 'yearly', 'INV-ZB-2427', 'USD', 93.6, 1000, 1024);
  select status, currency, fx_rate, amount into i from public.invoices where id = r->>'invoice_id';
  if i.status <> 'paid' or i.currency is distinct from 'USD' or i.fx_rate is distinct from 93.6 or i.amount <> 95846 then
    raise exception 'FAIL D: invoice % % % ₹%', i.status, i.currency, i.fx_rate, i.amount;
  end if;
  if (select sum(amount) from public.payments where quote_id = r->>'quote_id' and status = 'received') <> 95846 then
    raise exception 'FAIL D: the receipt is not the whole ₹95,846 sale';
  end if;
  select amount into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000242704' and category = 'Bank Charges';
  if not found or e.amount <> 2246 then raise exception 'FAIL D: bank charges line %', e.amount; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000242704') is distinct from 'payment' then
    raise exception 'FAIL D: line not reconciled';
  end if;
  raise notice 'D PASS: new sale of $1,024 with $1,000 received → paid in USD @ 93.6, Bank Charges ₹2,246';

  -- ── E. un-reconcile removes the forex line ────────────────────────────────────────────
  perform set_config('request.jwt.claims', '', true);
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000242701';
  select count(*) into n from public.expenses where reconciled_txn_id = '11111111-0000-0000-0000-000000242701';
  if n <> 0 then raise exception 'FAIL E: % forex / charges lines left on an un-reconciled line', n; end if;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000242701","role":"authenticated"}', true);
  raise notice 'E PASS: un-reconciling the line removes its forex line';
end $$;

-- ── F. another company's invoice ───────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000242702","role":"authenticated"}', true);
select public.generate_invoice('Q-R2427-OTHER');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000242701","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000242703',
              (select invoice_id from public.quotes where id = 'Q-R2427-OTHER'), 'USD', 90, 880);
  exception when sqlstate '42501' or no_data_found then ok := true;
  end;
  if not ok then raise exception 'FAIL F: another company''s invoice was paid'; end if;
  raise notice 'F PASS: another company''s invoice refused';
end $$;

select 'R-2427 export receipts (forex gain / loss + bank charges): ALL PASS' as result;

rollback;
