-- R-2099 (29 Oct 2026): one Razorpay settlement bank credit → its app payments + Razorpay's fee
-- and GST on it + refunds, in one click. Migration 20261029060514_r2099_razorpay_settlement
-- (needs R-2098's payments.bank_txn_id + balance-sheet change, 20261029054707).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migrations without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. 3 Razorpay payments (₹1,180 + ₹2,360 + ₹5,900) − fee ₹189 (GST ₹29) = bank ₹9,251; one
--      payment already had its fee booked by the webhook (₹24, GST ₹4). Result: line reconciled to
--      a payment, all 3 carry bank_txn_id, ONE fee expense EXP-RZPFEE-STL-setl_… of ₹165 with GST
--      ₹25 (Razorpay vendor GSTIN state 29 ≠ ours 07 → IGST), undeposited funds fall by exactly
--      the ₹9,416 the three were waiting with, settlement row + 3 items.
--   B. A refund in the settlement: payment ₹2,360 (fee ₹47, GST ₹7) − refund ₹1,180 of a payment
--      the app already refunded = bank ₹1,133 → reconciled, fee ₹47.
--   C. Refused, nothing written: app amount ≠ Razorpay's, a refund the app has not booked, a fee
--      far from Razorpay's, a payment already on another line, the same settlement on a second
--      line, a second click on the same line, a sales login (42501), a no-company login (28000).
--   D. Un-reconcile line A: the settlement rows and the fee expense go, the payments lose
--      bank_txn_id (undeposited again).

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
  ('dddddddd-0000-0000-0000-000000209901','R2099 Co','r2099@example.in','07','R2099');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000209901','owner2099@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000209902','sales2099@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000209903','nocompany2099@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209901','dddddddd-0000-0000-0000-000000209901','owner2099@example.in','Owner 2099','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000209902','dddddddd-0000-0000-0000-000000209901','sales2099@example.in','Sales 2099','sales', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209901','dddddddd-0000-0000-0000-000000209901','Acme 2099','07','acme2099.in');
insert into public.vendors (id, tenant_id, name, gstin) values
  ('eeeeeeee-0000-0000-0000-000000209901','dddddddd-0000-0000-0000-000000209901','Razorpay Software Pvt Ltd','29AAGCR4375J1ZU');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209901','dddddddd-0000-0000-0000-000000209901','Axis Current','Axis');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000209901', 'cccccccc-0000-0000-0000-000000209901', 'Acme 2099',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-R1', 1000), ('Q-R2', 2000), ('Q-R3', 5000), ('Q-R4', 1000), ('Q-R5', 2000), ('Q-R6', 1000)) as v(id, sub);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209901','dddddddd-0000-0000-0000-000000209901','bbbbbbbb-0000-0000-0000-000000209901','2026-10-20','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-R2099 A',0,9251,'AXISCN2099A','manual'),
  ('11111111-0000-0000-0000-000000209902','dddddddd-0000-0000-0000-000000209901','bbbbbbbb-0000-0000-0000-000000209901','2026-10-21','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-R2099 B',0,1133,'AXISCN2099B','manual'),
  ('11111111-0000-0000-0000-000000209903','dddddddd-0000-0000-0000-000000209901','bbbbbbbb-0000-0000-0000-000000209901','2026-10-22','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-R2099 C',0,1157,'AXISCN2099C','manual');

-- Razorpay payments as the webhook records them (reference = pay_…).
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209901","role":"authenticated"}', true);
select public.record_payment('Q-R1', 1180, 'razorpay', 'pay_R2099one',   'Razorpay payment.captured');
select public.record_payment('Q-R2', 2360, 'razorpay', 'pay_R2099two',   'Razorpay payment.captured');
select public.record_payment('Q-R3', 5900, 'razorpay', 'pay_R2099three', 'Razorpay payment.captured');
select public.record_payment('Q-R4', 1180, 'razorpay', 'pay_R2099four',  'Razorpay payment.captured');
select public.record_payment('Q-R5', 2360, 'razorpay', 'pay_R2099five',  'Razorpay payment.captured');
select public.record_payment('Q-R6', 1180, 'razorpay', 'pay_R2099six',   'Razorpay payment.captured');
select public.refund_payment((select id from public.payments where reference = 'pay_R2099four'), 'Customer cancelled');

create function pg_temp.pid(p_ref text) returns uuid language sql as $f$ select id from public.payments where reference = p_ref $f$;
create function pg_temp.undeposited() returns bigint language sql as $f$ select undeposited_funds from public.report_balance_sheet('2026-10-31') $f$;
create temp table r2099_bs (k text primary key, v bigint);
grant all on r2099_bs to authenticated;

-- The webhook already booked pay_R2099one's fee (R-045): ₹24 incl. GST ₹4.
select set_config('request.jwt.claims', '', true);
update public.payments set gateway_fee = 24, gateway_fee_gst = 4 where id = pg_temp.pid('pay_R2099one');
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, paid, paid_date, payment_method, description)
values ('EXP-RZPFEE-' || pg_temp.pid('pay_R2099one'), 'dddddddd-0000-0000-0000-000000209901', 'Bank Charges', 'Razorpay', '2026-10-18', 24, 4, 'gst', true, '2026-10-18', 'razorpay', 'Razorpay fee on pay_R2099one');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209901","role":"authenticated"}', true);

create function pg_temp.setl_a(p_id text default 'setl_R2099A', p_fee int default 18900) returns jsonb language sql as $f$
  select jsonb_build_object('id', p_id, 'utr', 'AXISCN2099A', 'fee_paise', p_fee, 'tax_paise', 2900,
    'payments', jsonb_build_array(
      jsonb_build_object('rzp_id', 'pay_R2099one',   'amount_paise', 118000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099one'))),
      jsonb_build_object('rzp_id', 'pay_R2099two',   'amount_paise', 236000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099two'))),
      jsonb_build_object('rzp_id', 'pay_R2099three', 'amount_paise', 590000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099three')))),
    'refunds', '[]'::jsonb) $f$;
grant execute on function pg_temp.setl_a(text, int), pg_temp.pid(text) to authenticated;

-- ── C (before A). Refusals on a fresh line — nothing written ───────────────────────────────
do $$
declare v_msg text;
begin
  -- app amount ≠ Razorpay's
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901',
      jsonb_set(pg_temp.setl_a(), '{payments,0,amount_paise}', '120000'));
    raise exception 'FAIL C1: amount mismatch was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%Razorpay says ₹1200 for pay_R2099one but the app recorded ₹1180%' then raise exception 'FAIL C1: message %', v_msg; end if;
  end;
  -- fee far from Razorpay's
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901', pg_temp.setl_a('setl_R2099A', 9900));
    raise exception 'FAIL C2: fee mismatch was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%leaves ₹189 of fee, but Razorpay says its fee is ₹99%' then raise exception 'FAIL C2: message %', v_msg; end if;
  end;
  -- a refund the app has not booked (pay_R2099six is still received)
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901',
      jsonb_set(pg_temp.setl_a(), '{refunds}', jsonb_build_array(jsonb_build_object('rzp_id', 'rfnd_R2099x', 'amount_paise', 118000,
        'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099six'))))));
    raise exception 'FAIL C3: unbooked refund was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%does not show as refunded. Use Refund on that payment%' then raise exception 'FAIL C3: message %', v_msg; end if;
  end;
  if exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000209901' and matched_to_type is not null)
     or exists (select 1 from public.razorpay_settlement_recons where tenant_id = 'dddddddd-0000-0000-0000-000000209901')
     or exists (select 1 from public.expenses where id like 'EXP-RZPFEE-STL-%' and tenant_id = 'dddddddd-0000-0000-0000-000000209901')
     or exists (select 1 from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000209901' and bank_txn_id is not null) then
    raise exception 'FAIL C: a refused call wrote something';
  end if;
end $$;

-- roles: sales 42501, no company 28000
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209902","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901', pg_temp.setl_a());
  raise exception 'FAIL C4: sales login reconciled';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209903","role":"authenticated"}', true);
do $$
begin
  perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901', pg_temp.setl_a());
  raise exception 'FAIL C5: no-company login reconciled';
exception when sqlstate '28000' then null;
end $$;
reset role;

-- ── A. three payments, one already had its fee booked ─────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209901","role":"authenticated"}', true);
insert into r2099_bs values ('undep0', pg_temp.undeposited());
do $$
declare r jsonb; n int; e record; t record;
begin
  r := public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901', pg_temp.setl_a());
  if r->>'kind' <> 'razorpay_settlement' or (r->>'gross')::int <> 9440 or (r->>'fee')::int <> 189
     or (r->>'fee_booked_now')::int <> 165 or (r->>'fee_gst_now')::int <> 25 or (r->>'payments')::int <> 3 then
    raise exception 'FAIL A: result %', r; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000209901';
  if t.matched_to_type <> 'payment' or t.matched_to_id::uuid not in (pg_temp.pid('pay_R2099one'), pg_temp.pid('pay_R2099two'), pg_temp.pid('pay_R2099three')) then
    raise exception 'FAIL A: line matched to % %', t.matched_to_type, t.matched_to_id; end if;
  select count(*) into n from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209901';
  if n <> 3 then raise exception 'FAIL A: % of 3 payments banked on the line', n; end if;
  select * into e from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2099A';
  if not found or e.amount <> 165 or e.gst_paid <> 25 or e.igst <> 25 or e.cgst <> 0 or e.category <> 'Bank Charges'
     or e.vendor_id <> 'eeeeeeee-0000-0000-0000-000000209901' or e.expense_date <> '2026-10-20' or not e.paid then
    raise exception 'FAIL A: fee expense %', row_to_json(e); end if;
  select count(*) into n from public.razorpay_settlement_items i join public.razorpay_settlement_recons s on s.id = i.recon_id
   where s.settlement_id = 'setl_R2099A' and s.fee = 189 and s.gross = 9440;
  if n <> 3 then raise exception 'FAIL A: % settlement items', n; end if;
end $$;
do $$
declare v_before bigint; v_after bigint;
begin
  select v into v_before from r2099_bs where k = 'undep0';
  v_after := pg_temp.undeposited();
  -- 1180 − 24 (fee booked) + 2360 + 5900 = 9416 left undeposited funds
  if v_before - v_after <> 9416 then raise exception 'FAIL A: undeposited fell by % (want 9416)', v_before - v_after; end if;
end $$;

-- ── C (after A). second click, same settlement elsewhere, payment already banked ──────────
do $$
declare v_msg text;
begin
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209901', pg_temp.setl_a());
    raise exception 'FAIL C6: second click accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This bank line is already reconciled%' then raise exception 'FAIL C6: message %', v_msg; end if;
  end;
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209903', pg_temp.setl_a());
    raise exception 'FAIL C7: same settlement on a second line accepted';
  exception when unique_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'Razorpay settlement setl_R2099A is already reconciled%' then raise exception 'FAIL C7: message %', v_msg; end if;
  end;
  begin
    perform public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209903', jsonb_build_object(
      'id', 'setl_R2099C', 'fee_paise', 2300, 'tax_paise', 300, 'refunds', '[]'::jsonb,
      'payments', jsonb_build_array(jsonb_build_object('rzp_id', 'pay_R2099one', 'amount_paise', 118000,
                                                       'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099one'))))));
    raise exception 'FAIL C8: banked payment accepted again';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%already reconciled to another bank line%' then raise exception 'FAIL C8: message %', v_msg; end if;
  end;
end $$;

-- ── B. a refund inside the settlement ──────────────────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000209902', jsonb_build_object(
    'id', 'setl_R2099B', 'utr', 'AXISCN2099B', 'fee_paise', 4700, 'tax_paise', 700,
    'payments', jsonb_build_array(jsonb_build_object('rzp_id', 'pay_R2099five', 'amount_paise', 236000,
                                                     'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099five')))),
    'refunds', jsonb_build_array(jsonb_build_object('rzp_id', 'rfnd_R2099four', 'amount_paise', 118000,
                                                    'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2099four'))))));
  if (r->>'refunds')::int <> 1180 or (r->>'fee')::int <> 47 or (r->>'fee_booked_now')::int <> 47 or (r->>'fee_gst_now')::int <> 7 then
    raise exception 'FAIL B: result %', r; end if;
  if not exists (select 1 from public.razorpay_settlement_items where rzp_id = 'rfnd_R2099four' and kind = 'refund') then
    raise exception 'FAIL B: refund item missing'; end if;
end $$;

-- ── D. un-reconcile line A ─────────────────────────────────────────────────────────────────
do $$
declare n int; v_before bigint;
begin
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000209901', null, null, null);
  if exists (select 1 from public.razorpay_settlement_recons where settlement_id = 'setl_R2099A') then raise exception 'FAIL D: settlement row left'; end if;
  if exists (select 1 from public.razorpay_settlement_items where rzp_id = 'pay_R2099two') then raise exception 'FAIL D: items left'; end if;
  if exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2099A') then raise exception 'FAIL D: fee expense left'; end if;
  if not exists (select 1 from public.expenses where id = 'EXP-RZPFEE-' || pg_temp.pid('pay_R2099one')) then raise exception 'FAIL D: webhook fee expense removed'; end if;
  select count(*) into n from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209901';
  if n <> 0 then raise exception 'FAIL D: % payments still banked', n; end if;
  select v into v_before from r2099_bs where k = 'undep0';
  -- back to before A, less pay_R2099five (₹2,360, banked on line B)
  if pg_temp.undeposited() <> v_before - 2360 then raise exception 'FAIL D: undeposited % (want %)', pg_temp.undeposited(), v_before - 2360; end if;
  -- line B untouched
  if not exists (select 1 from public.razorpay_settlement_recons where settlement_id = 'setl_R2099B') then raise exception 'FAIL D: line B lost'; end if;
end $$;

select 'R-2099 razorpay settlement: ALL PASS' as result;

rollback;
