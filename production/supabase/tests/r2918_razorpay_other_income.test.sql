-- R-2918 (18 Nov 2026): a Razorpay payment inside a settlement that is in NO app payment (a ₹1 / ₹100 / ₹125
-- test payment) may be booked as Other income — by the owner's / accountant's pick only — so the settlement
-- reconciles: customer receipts as before + the picked payment's gross as Other income + the fee as before.
-- Migration 20261118070909_r2918_razorpay_other_income (needs R-2095 20261030153511, R-2099 20261029060514,
-- R-2535 20261107043907, R-2654 20261111161247, R-2745 20261116125550). Self-asserting, ONE transaction,
-- rolled back. Local/test DB only.
--
-- Proves:
--   A. Refusals — nothing is booked as Other income without the pick or by the wrong person:
--      A1 the unmatched payment sent the old way (no app payment, no pick) is refused as before;
--      A2 a manager's pick is refused (owner / accountant only);
--      A3 a pick naming a payment the app HAS is refused; A4 ₹0; A5 the same Razorpay id twice;
--      A9 a payment made on a quote's Razorpay order (quotes.payment_reference).
--      After all of them: no other_incomes row, no settlement row, the line is open.
--   B. Pick (owner, one-line): ₹1,180 receipt + ₹1 test payment − fee ₹24 (GST ₹4) = bank ₹1,157. The line is
--      matched to the receipt, the receipt carries bank_txn_id, ONE other_incomes row (₹1, head 'other', the
--      line's day), the fee expense is ₹24 / GST ₹4 as before, the settlement row says other_income 1 and the
--      item is kind 'other_income'; the P&L's Other income shows ₹1. A second click is refused.
--   C. Un-reconcile by hand: the Other income row, the fee expense and the settlement rows go, the receipt is
--      free again. The same payment can then be picked again (and not in a second settlement meanwhile — C2).
--   D. Month batch (accountant): reconcile_razorpay_settlement_in_run books ₹2,360 + ₹125 Other income − fee
--      ₹50; "Undo this run" (undo_bank_recon_run) takes all of it back.
--   E. R-2745 kept: the line's month is GST-filed → the fee expense goes on the first open day, the Other
--      income stays on the line's day; when GST of the fee's day is filed later, un-reconcile is refused and
--      the Other income stays too; once cleared, it goes.
--   F. A settlement with no app payment at all (one ₹100 test payment, fee ₹2, bank ₹98): the line is matched
--      to the Other income row; un-reconcile removes it and the fee expense.

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
  ('dddddddd-0000-0000-0000-000000291801','R2918 Co','r2918@example.in','07','R2918');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000291801','owner2918@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000291802','manager2918@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000291803','accountant2918@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000291801','dddddddd-0000-0000-0000-000000291801','owner2918@example.in','Owner 2918','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000291802','dddddddd-0000-0000-0000-000000291801','manager2918@example.in','Manager 2918','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000291803','dddddddd-0000-0000-0000-000000291801','accountant2918@example.in','Accountant 2918','accountant', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000291801','dddddddd-0000-0000-0000-000000291801','Acme 2918','07','acme2918.in');
-- Razorpay vendor in Karnataka (29) vs our 07 → the fee GST is IGST.
insert into public.vendors (id, tenant_id, name, gstin) values
  ('eeeeeeee-0000-0000-0000-000000291801','dddddddd-0000-0000-0000-000000291801','Razorpay Software Pvt Ltd','29AAGCR4375J1ZU');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000291801','dddddddd-0000-0000-0000-000000291801','HDFC Current','HDFC');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000291801', 'cccccccc-0000-0000-0000-000000291801', 'Acme 2918',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-2918A', 1000), ('Q-2918B', 2000), ('Q-2918C', 1000)) as v(id, sub);

-- L1 (5 Nov):  ₹1,180 + ₹1 test − fee ₹24 (GST ₹4)  = ₹1,157.
-- L2 (6 Nov):  ₹2,360 + ₹125 test − fee ₹50 (GST ₹8) = ₹2,435.
-- L3 (7 Nov):  ₹100 test only − fee ₹2               = ₹98.
-- L4 (20 Oct): ₹1,180 + ₹1 test − fee ₹24 (GST ₹4)  = ₹1,157 (a month that gets GST-filed).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000291801','dddddddd-0000-0000-0000-000000291801','bbbbbbbb-0000-0000-0000-000000291801','2026-11-05','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2918A',0,1157,'UTR2918A','manual'),
  ('11111111-0000-0000-0000-000000291802','dddddddd-0000-0000-0000-000000291801','bbbbbbbb-0000-0000-0000-000000291801','2026-11-06','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2918B',0,2435,'UTR2918B','manual'),
  ('11111111-0000-0000-0000-000000291803','dddddddd-0000-0000-0000-000000291801','bbbbbbbb-0000-0000-0000-000000291801','2026-11-07','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2918C',0,98,'UTR2918C','manual'),
  ('11111111-0000-0000-0000-000000291804','dddddddd-0000-0000-0000-000000291801','bbbbbbbb-0000-0000-0000-000000291801','2026-10-20','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2918D',0,1157,'UTR2918D','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000291801","role":"authenticated"}', true);
select public.record_payment('Q-2918A', 1180, 'razorpay', 'pay_R2918one',   'Razorpay payment.captured');
select public.record_payment('Q-2918B', 2360, 'razorpay', 'pay_R2918two',   'Razorpay payment.captured');
select public.record_payment('Q-2918C', 1180, 'razorpay', 'pay_R2918three', 'Razorpay payment.captured');
select set_config('request.jwt.claims', '', true);
-- a quote with a Razorpay order (payment link) and no payment yet — A9
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date, payment_reference)
values ('Q-2918D', 'dddddddd-0000-0000-0000-000000291801', 'cccccccc-0000-0000-0000-000000291801', 'Acme 2918',
        1180, 1000, 0, 18, 'accepted', 'awaiting', 'yearly',
        jsonb_build_array(jsonb_build_object('name', 'Service Q-2918D', 'qty', 1, 'rate', 1000, 'one_time', true)),
        true, '2026-10-10', 'order_R2918D');

create function pg_temp.pid(p_ref text) returns uuid language sql as $f$ select id from public.payments where reference = p_ref $f$;
-- one app payment (or none when p_ref is null) + the list picked as Other income
create function pg_temp.setl(p_sid text, p_utr text, p_ref text, p_amt int, p_oi jsonb, p_fee_paise int, p_tax_paise int) returns jsonb language sql as $f$
  select jsonb_build_object('id', p_sid, 'utr', p_utr, 'fee_paise', p_fee_paise, 'tax_paise', p_tax_paise,
    'payments', case when p_ref is null then '[]'::jsonb
                     else jsonb_build_array(jsonb_build_object('rzp_id', p_ref, 'amount_paise', p_amt * 100, 'payment_ids', jsonb_build_array(pg_temp.pid(p_ref)))) end,
    'refunds', '[]'::jsonb)
    || case when p_oi is null then '{}'::jsonb else jsonb_build_object('other_income', p_oi) end $f$;
create function pg_temp.oi(p_rzp text, p_paise int) returns jsonb language sql as $f$
  select jsonb_build_array(jsonb_build_object('rzp_id', p_rzp, 'amount_paise', p_paise)) $f$;
create function pg_temp.s1() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2918A', 'UTR2918A', 'pay_R2918one',   1180, pg_temp.oi('pay_R2918test1', 100),   2402, 400) $f$;
create function pg_temp.s2() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2918B', 'UTR2918B', 'pay_R2918two',   2360, pg_temp.oi('pay_R2918t125', 12500),  5000, 800) $f$;
create function pg_temp.s3() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2918C', 'UTR2918C', null,             0,    pg_temp.oi('pay_R2918t100', 10000),  236,  36)  $f$;
create function pg_temp.s4() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2918D', 'UTR2918D', 'pay_R2918three', 1180, pg_temp.oi('pay_R2918test4', 100),   2402, 400) $f$;
grant execute on function pg_temp.pid(text), pg_temp.setl(text, text, text, int, jsonb, int, int), pg_temp.oi(text, int),
  pg_temp.s1(), pg_temp.s2(), pg_temp.s3(), pg_temp.s4() to authenticated;
create temp table r2918_ids (k text primary key, v uuid);
grant all on r2918_ids to authenticated;

create function pg_temp.as_user(p_n int) returns void language sql as $f$
  select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000029180' || p_n || '","role":"authenticated"}', true) $f$;
create function pg_temp.as_db() returns void language sql as $f$ select set_config('request.jwt.claims', '', true) $f$;
-- must be refused with a message containing p_like; anything else fails the test
create function pg_temp.refused(p_what text, p_txn uuid, p_settlement jsonb, p_like text) returns void language plpgsql as $f$
begin
  begin
    perform public.reconcile_razorpay_settlement(p_txn, p_settlement);
  exception when others then
    if sqlerrm not like '%' || p_like || '%' then raise exception 'FAIL %: wrong refusal: %', p_what, sqlerrm; end if;
    return;
  end;
  raise exception 'FAIL %: should have been refused', p_what;
end $f$;
grant execute on function pg_temp.as_user(int), pg_temp.as_db(), pg_temp.refused(text, uuid, jsonb, text) to authenticated;

-- ── A. Refusals: nothing becomes Other income without the pick, or by the wrong person ───────────
select pg_temp.as_user(1);
set local role authenticated;
do $$
declare v_l1 uuid := '11111111-0000-0000-0000-000000291801';
begin
  -- A1. the old way: the test payment listed as a payment with no app payment and NO pick → refused as before
  perform pg_temp.refused('A1', v_l1,
    jsonb_set(pg_temp.s1() - 'other_income', '{payments}', (pg_temp.s1()->'payments')
      || jsonb_build_array(jsonb_build_object('rzp_id', 'pay_R2918test1', 'amount_paise', 100, 'payment_ids', '[]'::jsonb))),
    'pay_R2918test1 has no app payment');
  -- A3. a payment the app HAS can never be Other income
  perform pg_temp.refused('A3', v_l1,
    jsonb_set(pg_temp.s1(), '{other_income}', pg_temp.oi('pay_R2918two', 100)), 'pay_R2918two is in the app');
  -- A4. ₹0
  perform pg_temp.refused('A4', v_l1, jsonb_set(pg_temp.s1(), '{other_income}', pg_temp.oi('pay_R2918test1', 0)), 'has no amount');
  -- A5. the same Razorpay id twice (as a payment and as Other income; and twice in the list)
  perform pg_temp.refused('A5a', v_l1, jsonb_set(pg_temp.s1(), '{other_income}', pg_temp.oi('pay_R2918one', 100)), 'pay_R2918one is listed twice');
  perform pg_temp.refused('A5b', v_l1,
    jsonb_set(pg_temp.s1(), '{other_income}', pg_temp.oi('pay_R2918test1', 100) || pg_temp.oi('pay_R2918test1', 100)), 'pay_R2918test1 is listed twice');
  -- A9. paid on a quote's Razorpay order in the app → that customer's money, never Other income
  perform pg_temp.refused('A9', v_l1,
    jsonb_set(pg_temp.s1(), '{other_income}', jsonb_build_array(jsonb_build_object('rzp_id', 'pay_R2918test1', 'amount_paise', 100, 'order_id', 'order_R2918D'))),
    'was paid on a quote''s payment link');
  -- A6. not a list / not a Razorpay payment id
  perform pg_temp.refused('A6a', v_l1, jsonb_set(pg_temp.s1(), '{other_income}', '"pay_R2918test1"'::jsonb), 'Other income list is not valid');
  perform pg_temp.refused('A6b', v_l1, jsonb_set(pg_temp.s1(), '{other_income}', pg_temp.oi('setl_x', 100)), 'has no Razorpay payment id');
end $$;
reset role;

-- A2. a manager may reconcile settlements, but not book a payment as Other income
select pg_temp.as_user(2);
set local role authenticated;
do $$
begin
  perform pg_temp.refused('A2', '11111111-0000-0000-0000-000000291801', pg_temp.s1(), 'Only the Owner or Accountant can book a Razorpay payment as Other income');
end $$;
reset role;

select pg_temp.as_db();
do $$
begin
  if exists (select 1 from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000291801') then
    raise exception 'FAIL A7: a refused call left an Other income row';
  end if;
  if exists (select 1 from public.razorpay_settlement_recons where tenant_id = 'dddddddd-0000-0000-0000-000000291801')
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000291801') is not null then
    raise exception 'FAIL A8: a refused call left a settlement row / matched the line';
  end if;
end $$;

-- ── B. The owner's pick, one line ────────────────────────────────────────────────────────────────
select pg_temp.as_user(1);
set local role authenticated;
do $$
declare v_res jsonb; v_o record; v_e record; v_bt record; v_r record; v_l1 uuid := '11111111-0000-0000-0000-000000291801';
begin
  v_res := public.reconcile_razorpay_settlement(v_l1, pg_temp.s1());
  if (v_res->>'other_income')::int <> 1 or (v_res->>'other_income_payments')::int <> 1 or (v_res->>'payments')::int <> 1
     or (v_res->>'gross')::int <> 1181 or (v_res->>'fee')::int <> 24 or (v_res->>'fee_booked_now')::int <> 24 or (v_res->>'fee_gst_now')::int <> 4 then
    raise exception 'FAIL B1: result %', v_res;
  end if;
  select * into v_bt from public.bank_transactions where id = v_l1;
  if v_bt.matched_to_type <> 'payment' or v_bt.matched_to_id <> pg_temp.pid('pay_R2918one')::text then
    raise exception 'FAIL B2: the line must be matched to the customer receipt (% %)', v_bt.matched_to_type, v_bt.matched_to_id;
  end if;
  if (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2918one')) is distinct from v_l1 then
    raise exception 'FAIL B3: the receipt must carry bank_txn_id';
  end if;
  if (select count(*) from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000291801') <> 1 then
    raise exception 'FAIL B4: exactly one Other income row expected';
  end if;
  select * into v_o from public.other_incomes where bank_txn_id = v_l1;
  if v_o.amount <> 1 or v_o.head <> 'other' or v_o.income_date <> date '2026-11-05' or v_o.id <> (v_res->>'other_income_id')::uuid
     or v_o.description not like '%pay_R2918test1%' or v_o.description not like '%setl_R2918A%' then
    raise exception 'FAIL B5: Other income row: amount % head % date % desc %', v_o.amount, v_o.head, v_o.income_date, v_o.description;
  end if;
  select * into v_e from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918A';
  if not found or v_e.amount <> 24 or v_e.gst_paid <> 4 or v_e.igst <> 4 or v_e.category <> 'Bank Charges' or v_e.expense_date <> date '2026-11-05' then
    raise exception 'FAIL B6: fee expense must be as before (₹24, GST ₹4 IGST, the line day): % % % %', v_e.amount, v_e.gst_paid, v_e.igst, v_e.expense_date;
  end if;
  select * into v_r from public.razorpay_settlement_recons where bank_txn_id = v_l1;
  if v_r.gross <> 1181 or v_r.other_income <> 1 or v_r.other_income_id <> v_o.id or v_r.fee <> 24 then
    raise exception 'FAIL B7: settlement row gross % other_income % fee %', v_r.gross, v_r.other_income, v_r.fee;
  end if;
  if (select count(*) from public.razorpay_settlement_items where recon_id = v_r.id and kind = 'other_income' and rzp_id = 'pay_R2918test1' and amount = 1 and payment_ids = '{}') <> 1
     or (select count(*) from public.razorpay_settlement_items where recon_id = v_r.id and kind = 'payment') <> 1 then
    raise exception 'FAIL B8: settlement items (one payment, one other_income)';
  end if;
  -- the P&L's Other income
  if (select amount from public.report_pnl_other_income(date '2026-11-01', date '2026-11-30') where head = 'other') is distinct from 1::bigint then
    raise exception 'FAIL B9: the P&L Other income for November should be ₹1';
  end if;
  -- a second click
  perform pg_temp.refused('B10', v_l1, pg_temp.s1(), 'already reconciled');
  -- C2. the same Razorpay payment cannot be Other income of a second settlement meanwhile
  perform pg_temp.refused('C2', '11111111-0000-0000-0000-000000291803',
    jsonb_set(pg_temp.s3(), '{other_income}', pg_temp.oi('pay_R2918test1', 10000)), 'already booked in another reconciled settlement');
end $$;

-- ── C. Un-reconcile by hand reverses all of it; then the pick works again ────────────────────────
do $$
declare v_res jsonb; v_l1 uuid := '11111111-0000-0000-0000-000000291801';
begin
  perform public.unreconcile_bank_receipt(v_l1, false);
  if exists (select 1 from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000291801') then
    raise exception 'FAIL C1: un-reconcile must remove the Other income row';
  end if;
  if exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918A')
     or exists (select 1 from public.razorpay_settlement_recons where bank_txn_id = v_l1)
     or exists (select 1 from public.razorpay_settlement_items where rzp_id in ('pay_R2918test1', 'pay_R2918one')) then
    raise exception 'FAIL C3: un-reconcile must remove the fee expense and the settlement rows';
  end if;
  if (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2918one')) is not null
     or (select matched_to_type from public.bank_transactions where id = v_l1) is not null then
    raise exception 'FAIL C4: the receipt and the line must be free again';
  end if;
  if exists (select 1 from public.report_pnl_other_income(date '2026-11-01', date '2026-11-30')) then
    raise exception 'FAIL C5: the P&L Other income must be empty again';
  end if;
  v_res := public.reconcile_razorpay_settlement(v_l1, pg_temp.s1());
  if (v_res->>'other_income')::int <> 1 then raise exception 'FAIL C6: the pick must work again after un-reconcile: %', v_res; end if;
end $$;
reset role;

-- ── D. Month batch (accountant): Reconcile all ready + Undo this run ──────────────────────────────
select pg_temp.as_user(3);
set local role authenticated;
do $$
declare v_run uuid; v_res jsonb; v_undo jsonb; v_l2 uuid := '11111111-0000-0000-0000-000000291802';
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000291801');
  v_res := public.reconcile_razorpay_settlement_in_run(v_run, v_l2, pg_temp.s2());
  if (v_res->>'run_id')::uuid <> v_run or (v_res->>'other_income')::int <> 125 or (v_res->>'fee')::int <> 50 or (v_res->>'gross')::int <> 2485 then
    raise exception 'FAIL D1: batch result %', v_res;
  end if;
  if (select amount from public.other_incomes where bank_txn_id = v_l2) <> 125
     or (select amount from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918B') <> 50
     or (select gst_paid from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918B') <> 8
     or (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2918two')) is distinct from v_l2 then
    raise exception 'FAIL D2: batch booking (Other income ₹125, fee ₹50 / GST ₹8, receipt linked)';
  end if;
  if (select sum(amount) from public.report_pnl_other_income(date '2026-11-01', date '2026-11-30')) <> 126 then
    raise exception 'FAIL D3: the P&L Other income for November should be ₹126 (₹1 + ₹125)';
  end if;
  v_undo := public.undo_bank_recon_run(v_run);
  if (v_undo->>'undone')::int <> 1 or jsonb_array_length(v_undo->'left') <> 0 then raise exception 'FAIL D4: undo %', v_undo; end if;
  if exists (select 1 from public.other_incomes where bank_txn_id = v_l2)
     or exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918B')
     or exists (select 1 from public.razorpay_settlement_recons where bank_txn_id = v_l2)
     or (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2918two')) is not null
     or (select matched_to_type from public.bank_transactions where id = v_l2) is not null then
    raise exception 'FAIL D5: Undo this run must reverse the Other income, the fee, the settlement and free the receipt + line';
  end if;
  -- the other line's Other income (B/C) is untouched by this run's undo
  if (select amount from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000291801') <> 1 then
    raise exception 'FAIL D6: Undo this run touched another line''s Other income';
  end if;
end $$;
reset role;

-- ── E. R-2745 kept: GST-filed month → fee on the first open day, Other income on the line's day ───
select pg_temp.as_db();
update public.tenants set gst_filed_through = '2026-10-31' where id = 'dddddddd-0000-0000-0000-000000291801';
select pg_temp.as_user(1);
set local role authenticated;
do $$
declare v_res jsonb; v_l4 uuid := '11111111-0000-0000-0000-000000291804';
begin
  v_res := public.reconcile_razorpay_settlement(v_l4, pg_temp.s4());
  if (v_res->>'fee_expense_date')::date is distinct from date '2026-11-01' or v_res->>'fee_date_why' is null or (v_res->>'other_income')::int <> 1 then
    raise exception 'FAIL E1: result %', v_res;
  end if;
  if (select expense_date from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918D') <> date '2026-11-01'
     or (select gst_paid from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918D') <> 4 then
    raise exception 'FAIL E2: the fee expense must be on the first open day with its GST';
  end if;
  if (select income_date from public.other_incomes where bank_txn_id = v_l4) <> date '2026-10-20' then
    raise exception 'FAIL E3: the Other income stays on the line''s day';
  end if;
end $$;
reset role;
-- GST of the fee's day (1 Nov) is filed later → the un-reconcile is refused and nothing goes
select pg_temp.as_db();
update public.tenants set gst_filed_through = '2026-11-30' where id = 'dddddddd-0000-0000-0000-000000291801';
select pg_temp.as_user(1);
set local role authenticated;
do $$
declare v_l4 uuid := '11111111-0000-0000-0000-000000291804';
begin
  begin
    perform public.unreconcile_bank_receipt(v_l4, false);
    raise exception 'FAIL E4: un-reconcile of a line whose fee is in a filed return must be refused';
  exception when others then
    if sqlerrm like 'FAIL %' then raise; end if;
    if sqlerrm not like '%EXP-RZPFEE-STL-setl_R2918D%' or sqlerrm not like '%cannot be deleted%' then
      raise exception 'FAIL E5: wrong refusal: %', sqlerrm;
    end if;
  end;
  if (select amount from public.other_incomes where bank_txn_id = v_l4) is distinct from 1
     or not exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918D')
     or (select matched_to_type from public.bank_transactions where id = v_l4) is distinct from 'payment' then
    raise exception 'FAIL E6: after the refusal the Other income, the fee and the match must all stay';
  end if;
end $$;
reset role;
select pg_temp.as_db();
update public.tenants set gst_filed_through = null where id = 'dddddddd-0000-0000-0000-000000291801';
select pg_temp.as_user(1);
set local role authenticated;
do $$
declare v_l4 uuid := '11111111-0000-0000-0000-000000291804';
begin
  perform public.unreconcile_bank_receipt(v_l4, false);
  if exists (select 1 from public.other_incomes where bank_txn_id = v_l4) or exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918D') then
    raise exception 'FAIL E7: once nothing is filed the un-reconcile removes the Other income and the fee';
  end if;
end $$;

-- ── F. A settlement with no app payment at all ───────────────────────────────────────────────────
do $$
declare v_res jsonb; v_bt record; v_l3 uuid := '11111111-0000-0000-0000-000000291803';
begin
  v_res := public.reconcile_razorpay_settlement(v_l3, pg_temp.s3());
  if (v_res->>'other_income')::int <> 100 or (v_res->>'payments')::int <> 0 or (v_res->>'fee')::int <> 2 or v_res->>'payment_id' is not null then
    raise exception 'FAIL F1: result %', v_res;
  end if;
  select * into v_bt from public.bank_transactions where id = v_l3;
  if v_bt.matched_to_type <> 'other_income' or v_bt.matched_to_id <> (v_res->>'other_income_id') then
    raise exception 'FAIL F2: the line must be matched to the Other income row (% %)', v_bt.matched_to_type, v_bt.matched_to_id;
  end if;
  if (select amount from public.other_incomes where bank_txn_id = v_l3) <> 100
     or (select amount from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918C') <> 2
     or (select gst_paid from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918C') <> 0 then
    raise exception 'FAIL F3: Other income ₹100 + fee ₹2 expected';
  end if;
  perform public.unreconcile_bank_receipt(v_l3, false);
  if exists (select 1 from public.other_incomes where bank_txn_id = v_l3)
     or exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2918C')
     or exists (select 1 from public.razorpay_settlement_recons where bank_txn_id = v_l3)
     or (select matched_to_type from public.bank_transactions where id = v_l3) is not null then
    raise exception 'FAIL F4: un-reconcile must remove the Other income, the fee and the settlement';
  end if;
end $$;
reset role;

rollback;
