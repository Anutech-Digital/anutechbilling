-- R-2745 (13 Nov 2026): the Razorpay settlement fee expense (+ its input GST) is dated on the FIRST OPEN
-- (not GST-filed) day, not the bank line's day — one-line reconcile AND the month batch; Undo this run /
-- un-reconcile never deletes a fee expense whose day's GST is now filed.
-- Migration 20261113161800_r2745_razorpay_fee_first_open_day (needs R-2099 20261029060514, R-2535 20261107043907,
-- R-2621 20261109071722, R-2631 20261109200130, R-2654 20261111161247). Self-asserting, ONE transaction, rolled
-- back. Local/test DB only.
--
-- Proves:
--   A. GST returns filed up to Oct 2026; a 20 Oct settlement line reconciled ONE-LINE: the bank line is matched
--      on 20 Oct, the receipts carry bank_txn_id, but EXP-RZPFEE-STL is dated 1 Nov 2026 (first open day) with
--      the same amount / GST / IGST split; paid_date = 20 Oct; the notes say why; the result carries
--      fee_expense_date + fee_date_why. GSTR-1 mark instead of the setting → the same (one rule).
--   A2. The same through the MONTH BATCH (reconcile_razorpay_settlement_in_run): 22 Oct line → fee on 1 Nov.
--   B. Open month (5 Nov line, nothing filed over it): the fee expense stays on the line's day, fee_date_why null —
--      as before R-2745.
--   C. GST filed AFTER the booking (the common real case): Undo this run leaves the filed-month lines (reason names
--      the expense, the day and why), the lines stay reconciled, expenses + settlement rows stay, the run is not
--      marked undone; an open-month line of the same run IS undone; un-reconcile by hand of a filed line is refused
--      with the same reason. Once the setting is cleared the undo works.
--   D. R-2654 gap: a settlement booked again by hand LATER than the run (recons.created_at > booked_at) is left by
--      Undo as "Changed since the run" (distinct timestamps).
--   E. R-2654 edge case 9: Undo of a line inside the books lock is left with the lock's reason.
--   F. R-2654 gap: a line re-booked under the SAME run id after a partial undo is recorded again and undone by
--      that run's next Undo.

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
  ('dddddddd-0000-0000-0000-000000274501','R2745 Co','r2745@example.in','07','R2745');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000274501','owner2745@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000274501','dddddddd-0000-0000-0000-000000274501','owner2745@example.in','Owner 2745','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000274501','dddddddd-0000-0000-0000-000000274501','Acme 2745','07','acme2745.in');
-- Razorpay vendor in Karnataka (29) vs our 07 → the fee GST is IGST.
insert into public.vendors (id, tenant_id, name, gstin) values
  ('eeeeeeee-0000-0000-0000-000000274501','dddddddd-0000-0000-0000-000000274501','Razorpay Software Pvt Ltd','29AAGCR4375J1ZU');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000274501','dddddddd-0000-0000-0000-000000274501','HDFC Current','HDFC');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000274501', 'cccccccc-0000-0000-0000-000000274501', 'Acme 2745',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-2745A', 1000), ('Q-2745B', 2000), ('Q-2745C', 1000)) as v(id, sub);

-- L1 (20 Oct): ₹1,180 − fee ₹24 (GST ₹4) = ₹1,156.  L2 (22 Oct): ₹2,360 − fee ₹47 (GST ₹7) = ₹2,313.
-- L3 (5 Nov): ₹1,180 − fee ₹24 (GST ₹4) = ₹1,156.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000274501','dddddddd-0000-0000-0000-000000274501','bbbbbbbb-0000-0000-0000-000000274501','2026-10-20','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2745A',0,1156,'UTR2745A','manual'),
  ('11111111-0000-0000-0000-000000274502','dddddddd-0000-0000-0000-000000274501','bbbbbbbb-0000-0000-0000-000000274501','2026-10-22','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2745B',0,2313,'UTR2745B','manual'),
  ('11111111-0000-0000-0000-000000274503','dddddddd-0000-0000-0000-000000274501','bbbbbbbb-0000-0000-0000-000000274501','2026-11-05','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2745C',0,1156,'UTR2745C','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000274501","role":"authenticated"}', true);
select public.record_payment('Q-2745A', 1180, 'razorpay', 'pay_R2745one',   'Razorpay payment.captured');
select public.record_payment('Q-2745B', 2360, 'razorpay', 'pay_R2745two',   'Razorpay payment.captured');
select public.record_payment('Q-2745C', 1180, 'razorpay', 'pay_R2745three', 'Razorpay payment.captured');
select set_config('request.jwt.claims', '', true);

create function pg_temp.pid(p_ref text) returns uuid language sql as $f$ select id from public.payments where reference = p_ref $f$;
create function pg_temp.setl(p_sid text, p_utr text, p_ref text, p_amt int, p_fee int, p_tax int) returns jsonb language sql as $f$
  select jsonb_build_object('id', p_sid, 'utr', p_utr, 'fee_paise', p_fee * 100, 'tax_paise', p_tax * 100,
    'payments', jsonb_build_array(jsonb_build_object('rzp_id', p_ref, 'amount_paise', p_amt * 100, 'payment_ids', jsonb_build_array(pg_temp.pid(p_ref)))),
    'refunds', '[]'::jsonb) $f$;
create function pg_temp.s1() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2745A', 'UTR2745A', 'pay_R2745one',   1180, 24, 4) $f$;
create function pg_temp.s2() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2745B', 'UTR2745B', 'pay_R2745two',   2360, 47, 7) $f$;
create function pg_temp.s3() returns jsonb language sql as $f$ select pg_temp.setl('setl_R2745C', 'UTR2745C', 'pay_R2745three', 1180, 24, 4) $f$;
grant execute on function pg_temp.pid(text), pg_temp.setl(text, text, text, int, int, int), pg_temp.s1(), pg_temp.s2(), pg_temp.s3() to authenticated;
create temp table r2745_ids (k text primary key, v uuid);
grant all on r2745_ids to authenticated;

create function pg_temp.as_owner() returns void language sql as $f$
  select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000274501","role":"authenticated"}', true) $f$;
create function pg_temp.as_db() returns void language sql as $f$ select set_config('request.jwt.claims', '', true) $f$;

-- ── A. One-line reconcile with GST filed up to Oct 2026: fee on 1 Nov, line on 20 Oct ─────────────
update public.tenants set gst_filed_through = '2026-10-31' where id = 'dddddddd-0000-0000-0000-000000274501';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb; v_e record; v_bt record;
begin
  v_res := public.reconcile_razorpay_settlement('11111111-0000-0000-0000-000000274501', pg_temp.s1());
  if (v_res->>'fee')::int <> 24 or (v_res->>'fee_booked_now')::int <> 24 or (v_res->>'fee_gst_now')::int <> 4 then
    raise exception 'FAIL A1: result %', v_res;
  end if;
  if (v_res->>'fee_expense_date')::date is distinct from date '2026-11-01' then
    raise exception 'FAIL A2: fee expense should be dated 2026-11-01 (first open day), result %', v_res;
  end if;
  if coalesce(v_res->>'fee_date_why', '') not like 'GST returns are filed up to October 2026%' then
    raise exception 'FAIL A3: fee_date_why %', v_res->>'fee_date_why';
  end if;
  select * into v_bt from public.bank_transactions where id = '11111111-0000-0000-0000-000000274501';
  if v_bt.matched_to_type <> 'payment' or v_bt.txn_date <> date '2026-10-20' then
    raise exception 'FAIL A4: the bank line must stay reconciled on its own day (% %)', v_bt.matched_to_type, v_bt.txn_date;
  end if;
  if (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2745one')) <> '11111111-0000-0000-0000-000000274501' then
    raise exception 'FAIL A5: the receipt must carry bank_txn_id';
  end if;
  select * into v_e from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745A';
  if not found then raise exception 'FAIL A6: fee expense missing'; end if;
  if v_e.expense_date <> date '2026-11-01' then raise exception 'FAIL A7: expense_date % (want 2026-11-01)', v_e.expense_date; end if;
  if v_e.paid_date <> date '2026-10-20' then raise exception 'FAIL A8: paid_date % (want the line day 2026-10-20)', v_e.paid_date; end if;
  if v_e.amount <> 24 or v_e.gst_paid <> 4 or v_e.igst <> 4 or v_e.cgst <> 0 or v_e.sgst <> 0 or v_e.category <> 'Bank Charges' or v_e.paid is not true then
    raise exception 'FAIL A9: amount/GST split changed: % % igst % cgst % sgst %', v_e.amount, v_e.gst_paid, v_e.igst, v_e.cgst, v_e.sgst;
  end if;
  if v_e.notes not like '%first open day%' or v_e.notes not like '%20 Oct 2026%' or v_e.notes not like '%R-2745%' then
    raise exception 'FAIL A10: notes should say the day moved and why: %', v_e.notes;
  end if;
  if (select fee_expense_id from public.razorpay_settlement_recons where bank_txn_id = '11111111-0000-0000-0000-000000274501') <> 'EXP-RZPFEE-STL-setl_R2745A' then
    raise exception 'FAIL A11: settlement row must point at the fee expense';
  end if;
end $$;
reset role;

-- A (one rule): a GSTR-1 mark for Oct instead of the setting gives the same day.
select pg_temp.as_db();
update public.tenants set gst_filed_through = null where id = 'dddddddd-0000-0000-0000-000000274501';
insert into public.compliance_log (tenant_id, obligation_key, period_key, filed_date)
values ('dddddddd-0000-0000-0000-000000274501', 'gst_gstr1', '2026-10', '2026-11-11');
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_run uuid; v_res jsonb;
begin
  -- A2. the same through the month batch (22 Oct line)
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000274501');
  insert into r2745_ids values ('runA', v_run);
  v_res := public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274502', pg_temp.s2());
  if (v_res->>'run_id')::uuid <> v_run or (v_res->>'fee')::int <> 47 then raise exception 'FAIL A2a: result %', v_res; end if;
  if (v_res->>'fee_expense_date')::date is distinct from date '2026-11-01' or coalesce(v_res->>'fee_date_why', '') not like 'GSTR-1 for Oct 2026 is marked filed%' then
    raise exception 'FAIL A2b: batch fee day / why: %', v_res;
  end if;
  if (select expense_date from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745B') <> date '2026-11-01'
     or (select igst from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745B') <> 7 then
    raise exception 'FAIL A2c: batch fee expense day / GST';
  end if;
  if (select txn_date from public.bank_transactions where id = '11111111-0000-0000-0000-000000274502' and matched_to_type = 'payment') <> date '2026-10-22' then
    raise exception 'FAIL A2d: batch line must stay on 22 Oct';
  end if;
  if (select count(*) from public.bank_recon_run_lines where run_id = v_run and kind = 'razorpay_settlement' and undone_at is null) <> 1 then
    raise exception 'FAIL A2e: line recorded on the run';
  end if;
  -- B. open month: 5 Nov line → fee on 5 Nov, nothing moved
  v_res := public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274503', pg_temp.s3());
  if (v_res->>'fee_expense_date')::date is distinct from date '2026-11-05' or v_res->>'fee_date_why' is not null then
    raise exception 'FAIL B1: open-month fee should stay on the line day: %', v_res;
  end if;
  if (select expense_date from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745C') <> date '2026-11-05'
     or (select notes from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745C') like '%first open day%' then
    raise exception 'FAIL B2: open-month expense day / notes';
  end if;
end $$;
reset role;

-- ── C. Filed AFTER the booking: Undo leaves the filed lines, undoes the open one ─────────────────
-- Run A holds L2 (fee on 1 Nov) and L3 (fee on 5 Nov). Now the owner files up to Nov 2026 — both fee days are inside
-- a filed return; L1 (one-line, fee 1 Nov) too.
select pg_temp.as_db();
delete from public.compliance_log where tenant_id = 'dddddddd-0000-0000-0000-000000274501';
update public.tenants set gst_filed_through = '2026-11-30' where id = 'dddddddd-0000-0000-0000-000000274501';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb; v_msg text; v_ok boolean := false;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runA'));
  if (v_res->>'undone')::int <> 0 or jsonb_array_length(v_res->'left') <> 2 then
    raise exception 'FAIL C1: filed-month lines must be left, result %', v_res;
  end if;
  if (v_res->'left'->0->>'reason') not like '%EXP-RZPFEE-STL-setl_R2745B%'
     or (v_res->'left'->0->>'reason') not like '%1 Nov 2026%'
     or (v_res->'left'->0->>'reason') not like '%GST returns are filed up to November 2026%'
     or (v_res->'left'->0->>'reason') not like '%stays reconciled%' then
    raise exception 'FAIL C2: reason should name the expense, its day and why: %', v_res->'left'->0->>'reason';
  end if;
  if (select count(*) from public.bank_transactions where id in ('11111111-0000-0000-0000-000000274502','11111111-0000-0000-0000-000000274503') and matched_to_type = 'payment') <> 2
     or (select count(*) from public.expenses where id in ('EXP-RZPFEE-STL-setl_R2745B','EXP-RZPFEE-STL-setl_R2745C')) <> 2
     or (select count(*) from public.razorpay_settlement_recons where bank_txn_id in ('11111111-0000-0000-0000-000000274502','11111111-0000-0000-0000-000000274503')) <> 2
     or (select count(*) from public.payments where id in (pg_temp.pid('pay_R2745two'), pg_temp.pid('pay_R2745three')) and bank_txn_id is not null) <> 2 then
    raise exception 'FAIL C3: a filed-month line / its fee expense / settlement row / receipt link was touched';
  end if;
  if (select undone_at from public.bank_recon_runs where id = (select v from r2745_ids where k = 'runA')) is not null then
    raise exception 'FAIL C4: run with lines left is not marked undone';
  end if;
  -- by hand: the Reconcile sheet's plain un-reconcile of L1 is refused the same way, nothing changes
  begin
    perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000274501', false);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    v_ok := v_msg like '%EXP-RZPFEE-STL-setl_R2745A%' and v_msg like '%already filed%';
    if not v_ok then raise exception 'FAIL C5: message %', v_msg; end if;
  end;
  if not v_ok then raise exception 'FAIL C5: un-reconcile of a filed-month fee line was not refused'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000274501') is distinct from 'payment'
     or not exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745A')
     or (select bank_txn_id from public.payments where id = pg_temp.pid('pay_R2745one')) is null then
    raise exception 'FAIL C6: refused un-reconcile changed something';
  end if;
end $$;
reset role;

-- Filed only up to Oct again: L3's fee (5 Nov) is open → undone; L2's (1 Nov) still open too → undone. Run undone.
select pg_temp.as_db();
update public.tenants set gst_filed_through = '2026-10-31' where id = 'dddddddd-0000-0000-0000-000000274501';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runA'));
  if (v_res->>'undone')::int <> 2 or jsonb_array_length(v_res->'left') <> 0 then
    raise exception 'FAIL C7: once the fee days are open the undo works: %', v_res;
  end if;
  if exists (select 1 from public.expenses where id in ('EXP-RZPFEE-STL-setl_R2745B','EXP-RZPFEE-STL-setl_R2745C'))
     or exists (select 1 from public.bank_transactions where id in ('11111111-0000-0000-0000-000000274502','11111111-0000-0000-0000-000000274503') and matched_to_type is not null) then
    raise exception 'FAIL C8: undo should free the lines and remove the fee expenses';
  end if;
  if (select undone_at from public.bank_recon_runs where id = (select v from r2745_ids where k = 'runA')) is null then
    raise exception 'FAIL C9: run marked undone';
  end if;
  -- the one-line L1 (fee 1 Nov) can be un-reconciled by hand again now
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000274501', false);
  if exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745A')
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000274501') is not null then
    raise exception 'FAIL C10: hand un-reconcile should work once the fee day is open';
  end if;
end $$;
reset role;

-- ── D. R-2654 gap: a settlement re-booked by hand LATER than the run is not this run's to undo ────
-- Nothing filed over Nov from here on (L3's fee lands on 5 Nov; L1/L2 fees on 1 Nov).
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_run uuid; v_res jsonb;
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000274501');
  insert into r2745_ids values ('runD', v_run);
  perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274503', pg_temp.s3());
end $$;
reset role;
-- simulate: un-reconciled and booked again by hand one second AFTER the run (distinct timestamps)
select pg_temp.as_db();
update public.razorpay_settlement_recons set created_at = (select booked_at from public.bank_recon_run_lines where run_id = (select v from r2745_ids where k = 'runD')) + interval '1 second'
 where bank_txn_id = '11111111-0000-0000-0000-000000274503';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runD'));
  if (v_res->>'undone')::int <> 0 or jsonb_array_length(v_res->'left') <> 1 or (v_res->'left'->0->>'reason') not like 'Changed since the run%' then
    raise exception 'FAIL D1: a settlement booked after the run must be left: %', v_res;
  end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000274503') is distinct from 'payment' then
    raise exception 'FAIL D2: the later booking was undone';
  end if;
end $$;
reset role;
select pg_temp.as_db();
update public.razorpay_settlement_recons set created_at = (select booked_at from public.bank_recon_run_lines where run_id = (select v from r2745_ids where k = 'runD'))
 where bank_txn_id = '11111111-0000-0000-0000-000000274503';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runD'));
  if (v_res->>'undone')::int <> 1 then raise exception 'FAIL D3: with the run''s own booking time the undo works: %', v_res; end if;
end $$;
reset role;

-- ── E. R-2654 edge case 9: Undo of a line inside the books lock is left with the lock's reason ──────
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_run uuid;
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000274501');
  insert into r2745_ids values ('runE', v_run);
  perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274501', pg_temp.s1());   -- L1, 20 Oct
  perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274503', pg_temp.s3());   -- L3, 5 Nov
end $$;
reset role;
select pg_temp.as_db();
update public.tenants set books_locked_until = '2026-10-31' where id = 'dddddddd-0000-0000-0000-000000274501';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runE'));
  if (v_res->>'undone')::int <> 1 or jsonb_array_length(v_res->'left') <> 1
     or (v_res->'left'->0->>'txn_id')::uuid <> '11111111-0000-0000-0000-000000274501'
     or (v_res->'left'->0->>'reason') not ilike '%lock%' then
    raise exception 'FAIL E1: locked line left with the lock reason, open line undone: %', v_res;
  end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000274501') is distinct from 'payment'
     or not exists (select 1 from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2745A') then
    raise exception 'FAIL E2: the locked line / its fee expense was touched';
  end if;
  if (select undone_at from public.bank_recon_runs where id = (select v from r2745_ids where k = 'runE')) is not null then
    raise exception 'FAIL E3: run with a line left is not marked undone';
  end if;
end $$;
reset role;

-- ── F. R-2654 gap: re-booked under the SAME run id after a partial undo → recorded again, undoable ─
-- runE: L1 left (locked), L3 undone. Book L3 again under runE (API path), then unlock and undo runE.
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_run uuid := (select v from r2745_ids where k = 'runE'); v_res jsonb; v_l record;
begin
  v_res := public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000274503', pg_temp.s3());
  if (v_res->>'run_id')::uuid <> v_run then raise exception 'FAIL F1: %', v_res; end if;
  select * into v_l from public.bank_recon_run_lines where run_id = v_run and txn_id = '11111111-0000-0000-0000-000000274503';
  if not found or v_l.undone_at is not null or v_l.matched_to_id is distinct from (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000274503') then
    raise exception 'FAIL F2: the re-booked line must be recorded on the run again (undone_at %, matched %)', v_l.undone_at, v_l.matched_to_id;
  end if;
  if (select count(*) from public.bank_recon_run_lines where run_id = v_run) <> 2 then
    raise exception 'FAIL F3: still one record per line on the run';
  end if;
end $$;
reset role;
select pg_temp.as_db();
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000274501';
select pg_temp.as_owner();
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2745_ids where k = 'runE'));
  if (v_res->>'undone')::int <> 2 or jsonb_array_length(v_res->'left') <> 0 then
    raise exception 'FAIL F4: unlocked, the run undoes both the left line and the re-booked line: %', v_res;
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000274501' and matched_to_type is not null)
     or exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000274501' and id like 'EXP-RZPFEE-STL-%')
     or exists (select 1 from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000274501' and bank_txn_id is not null) then
    raise exception 'FAIL F5: everything free again at the end';
  end if;
  if (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000274501' and status = 'received') <> 3 then
    raise exception 'FAIL F6: the receipts stay';
  end if;
end $$;
reset role;

select 'r2745_razorpay_fee_first_open_day: ALL PASS' as result;

rollback;
