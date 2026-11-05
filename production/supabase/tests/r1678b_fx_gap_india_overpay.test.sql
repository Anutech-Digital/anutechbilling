-- R-1678 follow-up (independent review BLOCK, 5 Nov 2026): a ₹ credit settling a foreign-currency
-- invoice with p_rest 'fx' must not hide TDS, a short payment, a gateway fee or an advance as an
-- exchange difference. Migration 20261106030000_r1678_fx_gap_india_overpay.
-- Self-asserting, ONE transaction, rolled back. Local/test DB only. RED without the migration
-- (A: exactly 10% short is accepted by 20261105175200, which refused only ABOVE 10%).
--
--   A. Exactly 10% short on a ₹ credit (₹90,000 for ₹1,00,000 due) → refused (more than 5%); nothing booked.
--   B. 5% short (₹95,000) → settled in full, ₹5,000 exchange loss (the limit itself is allowed).
--   C. A customer in India (USD invoice, NEFT ₹98,000 = 2% short) → 'fx' refused: the gap is TDS, a short
--      payment or an advance, never an exchange difference. Nothing booked.
--   D. Over-payment on a ₹ credit (₹1,03,000 for ₹1,00,000 due) → the invoice is paid in full, the ₹3,000
--      extra is the customer's ADVANCE (bank_credit_book_advance), and NO exchange-gain row.
--   E. An inward remittance in USD still books its gain (R-1678 C path unchanged): $1,000 @ 90 paid by
--      "USD1000.0@95" ₹95,000 → −₹5,000 exchange gain.

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
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000167901','R1678B Export Co','r1678b@example.in','07','R1679');
insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
select 'dddddddd-0000-0000-0000-000000167901'::uuid, g.fy::date, 'AD07TESTLUT' || to_char(g.fy, 'YY'), g.fy::date, (g.fy + interval '1 year' - interval '1 day')::date
  from generate_series('2024-04-01'::date, public.lut_fy_start(public.ist_today()), interval '1 year') as g(fy)
on conflict (tenant_id, fy_start) do nothing;
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000167901','owner1679@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000167901','dddddddd-0000-0000-0000-000000167901','owner1679@example.in','Owner 1679','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000167901','dddddddd-0000-0000-0000-000000167901','Overseas LLC 1679',null,'United States','overseas1679.example'),
  ('cccccccc-0000-0000-0000-000000167902','dddddddd-0000-0000-0000-000000167901','Indian Pvt Ltd 1679','07','India','india1679.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000167901','dddddddd-0000-0000-0000-000000167901','HDFC Current','HDFC');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date, currency, exchange_rate)
select v.id, 'dddddddd-0000-0000-0000-000000167901'::uuid, v.cust, v.cname, v.amt, v.amt, 0, 0, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Services ' || v.id, 'qty', 1, 'rate', v.amt, 'one_time', true)),
       true, '2026-07-01', 'USD', v.rate
  from (values
    ('Q-R1679-A', 'cccccccc-0000-0000-0000-000000167901'::uuid, 'Overseas LLC 1679',   100000, 100::numeric),
    ('Q-R1679-B', 'cccccccc-0000-0000-0000-000000167901'::uuid, 'Overseas LLC 1679',   100000, 100::numeric),
    ('Q-R1679-C', 'cccccccc-0000-0000-0000-000000167902'::uuid, 'Indian Pvt Ltd 1679', 100000, 100::numeric),
    ('Q-R1679-D', 'cccccccc-0000-0000-0000-000000167901'::uuid, 'Overseas LLC 1679',   100000, 100::numeric),
    ('Q-R1679-E', 'cccccccc-0000-0000-0000-000000167901'::uuid, 'Overseas LLC 1679',    90000,  90::numeric)
  ) as v(id, cust, cname, amt, rate);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000167901','dddddddd-0000-0000-0000-000000167901','bbbbbbbb-0000-0000-0000-000000167901','2026-09-01','NEFT CR-OVERSEAS LLC A',0,90000,'UTR1679A','manual'),
  ('11111111-0000-0000-0000-000000167902','dddddddd-0000-0000-0000-000000167901','bbbbbbbb-0000-0000-0000-000000167901','2026-09-02','NEFT CR-OVERSEAS LLC B',0,95000,'UTR1679B','manual'),
  ('11111111-0000-0000-0000-000000167903','dddddddd-0000-0000-0000-000000167901','bbbbbbbb-0000-0000-0000-000000167901','2026-09-03','NEFT CR-INDIAN PVT LTD',0,98000,'UTR1679C','manual'),
  ('11111111-0000-0000-0000-000000167904','dddddddd-0000-0000-0000-000000167901','bbbbbbbb-0000-0000-0000-000000167901','2026-09-04','NEFT CR-OVERSEAS LLC D',0,103000,'UTR1679D','manual'),
  ('11111111-0000-0000-0000-000000167905','dddddddd-0000-0000-0000-000000167901','bbbbbbbb-0000-0000-0000-000000167901','2026-09-05','INW 050926I049900005 USD1000.0@95',0,95000,null,'manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000167901","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R1679-A','Q-R1679-B','Q-R1679-C','Q-R1679-D','Q-R1679-E']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.items(p_quote text, p_amt int) returns jsonb language sql as $f$
  select jsonb_build_array(jsonb_build_object('invoice_id', (select invoice_id from public.quotes where id = p_quote), 'amount', p_amt)) $f$;

do $$
declare
  c_t   constant uuid := 'dddddddd-0000-0000-0000-000000167901';
  c_fx  constant text := 'Exchange gain / loss (realised)';
  r jsonb; ok boolean; v_msg text; n int; e record;
begin
  -- A. exactly 10% short → refused.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167901', 'cccccccc-0000-0000-0000-000000167901', pg_temp.items('Q-R1679-A', 100000), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%more than 5%%';
    if not ok then raise exception 'FAIL A: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL A: exactly 10%% short (TDS-shaped) was booked as an exchange loss'; end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-R1679-A')) <> 'pending' then raise exception 'FAIL A: invoice paid'; end if;
  raise notice 'A PASS: exactly 10%% short on a ₹ credit refused';

  -- B. 5% short → allowed.
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167902', 'cccccccc-0000-0000-0000-000000167901', pg_temp.items('Q-R1679-B', 100000), null, 'fx');
  select amount, category into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167902';
  if e.amount <> 5000 or e.category <> c_fx or (select status from public.invoices where id = pg_temp.inv('Q-R1679-B')) <> 'paid' then
    raise exception 'FAIL B: % ₹%', e.category, e.amount;
  end if;
  raise notice 'B PASS: 5%% short → paid, ₹5,000 exchange loss';

  -- C. customer in India → refused.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167903', 'cccccccc-0000-0000-0000-000000167902', pg_temp.items('Q-R1679-C', 100000), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%in India%TDS%';
    if not ok then raise exception 'FAIL C: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL C: an Indian customer''s gap was booked as an exchange difference'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000167903') is not null then raise exception 'FAIL C: line reconciled'; end if;
  raise notice 'C PASS: Indian customer — no exchange difference';

  -- D. over-payment → advance, never a gain.
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167904', 'cccccccc-0000-0000-0000-000000167901', pg_temp.items('Q-R1679-D', 100000), null, 'fx');
  if (select status from public.invoices where id = pg_temp.inv('Q-R1679-D')) <> 'paid' then raise exception 'FAIL D: invoice not paid'; end if;
  select count(*) into n from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167904';
  if n <> 0 then raise exception 'FAIL D: % expense rows (an over-payment booked as an exchange gain)', n; end if;
  if coalesce((r->>'advance_credit')::int, 0) <> 3000 or coalesce((r->>'forex_difference')::int, 0) <> 0 then raise exception 'FAIL D: result %', r; end if;
  select count(*) into n from public.payments where tenant_id = c_t and bank_txn_id = '11111111-0000-0000-0000-000000167904' and amount = 3000;
  if n <> 1 then raise exception 'FAIL D: no ₹3,000 advance receipt on the line'; end if;
  raise notice 'D PASS: ₹3,000 extra kept as the customer''s advance, no exchange gain';

  -- E. inward remittance in USD: the gain is still an exchange gain.
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167905', 'cccccccc-0000-0000-0000-000000167901', pg_temp.items('Q-R1679-E', 90000), null, 'fx');
  select amount into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167905' and category = c_fx;
  if e.amount <> -5000 then raise exception 'FAIL E: gain row ₹%', e.amount; end if;
  raise notice 'E PASS: USD remittance at a better rate → −₹5,000 exchange gain';
end $$;

select 'R-1678b fx gap 5% / India / over-payment: ALL PASS' as result;

rollback;
