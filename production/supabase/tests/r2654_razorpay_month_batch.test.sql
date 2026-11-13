-- R-2654 (10 Nov 2026): Razorpay settlements month batch — "Reconcile all ready" under a run id + "Undo this run".
-- Migration 20261111161247_r2654_razorpay_month_batch (needs R-2099 20261029060514, R-2535 20261107043907,
-- R-2565 20261107134000). Self-asserting, ONE transaction, rolled back. Local/test DB only.
--
-- Proves:
--   A. One run books TWO settlement lines (each through R-2099's reconcile_razorpay_settlement, unchanged):
--      both lines reconciled, receipts carry bank_txn_id, one EXP-RZPFEE-STL fee expense each, both lines
--      recorded on the run as 'razorpay_settlement'; no invoice / quote / receipt was created.
--   B. D8 (fee GST rounding): line 2's receipt already has its R-2565 fee booked rounded DOWN (₹23, GST ₹4
--      vs Razorpay ₹23.60 / ₹3.60) — the settlement books only the ₹1 remainder, never refuses.
--   C. Booking the same line again (double press / second run) is refused, nothing added; a line another
--      live run holds is refused for a new run.
--   D. Undo this run: both lines free again, the settlement rows and EXP-RZPFEE-STL expenses gone, receipts
--      stay (bank_txn_id null again), R-2565's per-payment fee expense stays; run marked undone; undo again
--      undoes 0.
--   E. A line changed by hand after the run is LEFT by Undo with the reason.
--   G. Books locked over the line's day: the in-run booking is refused, nothing written.
--   F. Gates: billing login refused (owner/accountant only), another company's run / account refused, a
--      Zoho run cannot be used for a Razorpay booking, an undone run cannot book.

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
  ('dddddddd-0000-0000-0000-000000265401','R2654 Co','r2654@example.in','07','R2654'),
  ('dddddddd-0000-0000-0000-000000265402','R2654 Other Co','r2654b@example.in','07','R2655');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000265401','owner2654@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265402','billing2654@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000265403','ownerb2654@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000265401','dddddddd-0000-0000-0000-000000265401','owner2654@example.in','Owner 2654','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265402','dddddddd-0000-0000-0000-000000265401','billing2654@example.in','Billing 2654','billing', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000265403','dddddddd-0000-0000-0000-000000265402','ownerb2654@example.in','Owner B 2654','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000265401','dddddddd-0000-0000-0000-000000265401','Acme 2654','07','acme2654.in');
insert into public.vendors (id, tenant_id, name, gstin) values
  ('eeeeeeee-0000-0000-0000-000000265401','dddddddd-0000-0000-0000-000000265401','Razorpay Software Pvt Ltd','29AAGCR4375J1ZU');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000265401','dddddddd-0000-0000-0000-000000265401','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000265402','dddddddd-0000-0000-0000-000000265402','B Current','HDFC');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000265401', 'cccccccc-0000-0000-0000-000000265401', 'Acme 2654',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-2654A', 1000), ('Q-2654B', 2000), ('Q-2654C', 1000)) as v(id, sub);

-- L1: ₹1,180 + ₹2,360 − fee ₹71 (GST ₹11) = ₹3,469.  L2: ₹1,180 − fee ₹23.60 (GST ₹3.60) = ₹1,156.40 → ₹1,156.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000265401','dddddddd-0000-0000-0000-000000265401','bbbbbbbb-0000-0000-0000-000000265401','2026-10-20','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2654A',0,3469,'UTR2654A','manual'),
  ('11111111-0000-0000-0000-000000265402','dddddddd-0000-0000-0000-000000265401','bbbbbbbb-0000-0000-0000-000000265401','2026-10-22','NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-UTR2654B',0,1156,'UTR2654B','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265401","role":"authenticated"}', true);
select public.record_payment('Q-2654A', 1180, 'razorpay', 'pay_R2654one',   'Razorpay payment.captured');
select public.record_payment('Q-2654B', 2360, 'razorpay', 'pay_R2654two',   'Razorpay payment.captured');
select public.record_payment('Q-2654C', 1180, 'razorpay', 'pay_R2654three', 'Razorpay payment.captured');

create function pg_temp.pid(p_ref text) returns uuid language sql as $f$ select id from public.payments where reference = p_ref $f$;
grant execute on function pg_temp.pid(text) to authenticated;

-- B (D8): pay_R2654three's fee was booked per payment the R-2565 way — rounded DOWN to ₹23, GST ₹4.
select set_config('request.jwt.claims', '', true);
update public.payments set gateway_fee = 23, gateway_fee_gst = 4 where id = pg_temp.pid('pay_R2654three');
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, paid, paid_date, payment_method, description)
values ('EXP-RZPFEE-' || pg_temp.pid('pay_R2654three'), 'dddddddd-0000-0000-0000-000000265401', 'Bank Charges', 'Razorpay', '2026-10-18', 23, 4, 'gst', true, '2026-10-18', 'razorpay', 'Razorpay fee on pay_R2654three');

create function pg_temp.setl1() returns jsonb language sql as $f$
  select jsonb_build_object('id', 'setl_R2654A', 'utr', 'UTR2654A', 'fee_paise', 7100, 'tax_paise', 1100,
    'payments', jsonb_build_array(
      jsonb_build_object('rzp_id', 'pay_R2654one', 'amount_paise', 118000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2654one'))),
      jsonb_build_object('rzp_id', 'pay_R2654two', 'amount_paise', 236000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2654two')))),
    'refunds', '[]'::jsonb) $f$;
create function pg_temp.setl2() returns jsonb language sql as $f$
  select jsonb_build_object('id', 'setl_R2654B', 'utr', 'UTR2654B', 'fee_paise', 2360, 'tax_paise', 360,
    'payments', jsonb_build_array(
      jsonb_build_object('rzp_id', 'pay_R2654three', 'amount_paise', 118000, 'payment_ids', jsonb_build_array(pg_temp.pid('pay_R2654three')))),
    'refunds', '[]'::jsonb) $f$;
grant execute on function pg_temp.setl1(), pg_temp.setl2() to authenticated;
create temp table r2654_ids (k text primary key, v uuid);
create temp table r2654_counts (k text primary key, v bigint);
grant all on r2654_ids, r2654_counts to authenticated;
insert into r2654_counts
select 'invoices', count(*) from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000265401'
union all select 'quotes', count(*) from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000265401'
union all select 'payments', count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265401';

-- ── F. Gates ────────────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265402","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  raise exception 'FAIL F1: billing login started a run';
exception when insufficient_privilege then null;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265401","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_zoho uuid; v_msg text;
begin
  -- another company's account
  begin
    perform public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265402');
    raise exception 'FAIL F2: run on another company''s account';
  exception when no_data_found then null;
  end;
  -- a Zoho run cannot carry a Razorpay booking
  v_zoho := public.bank_recon_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  begin
    perform public.reconcile_razorpay_settlement_in_run(v_zoho, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
    raise exception 'FAIL F3: Zoho run booked a Razorpay settlement';
  exception when invalid_parameter_value then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%not a Razorpay settlements run%' then raise exception 'FAIL F3: message %', v_msg; end if;
  end;
  if exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000265401' and matched_to_type is not null) then
    raise exception 'FAIL F3: refused call wrote the line';
  end if;
end $$;

-- ── A. One run, two lines ──────────────────────────────────────────────────────────────────
do $$
declare v_run uuid; v_r1 jsonb; v_r2 jsonb;
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  insert into r2654_ids values ('run', v_run);
  if (select source from public.bank_recon_runs where id = v_run) <> 'razorpay_batch' then raise exception 'FAIL A0: run source'; end if;
  v_r1 := public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
  v_r2 := public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265402', pg_temp.setl2());
  if (v_r1->>'fee')::int <> 71 or (v_r1->>'fee_booked_now')::int <> 71 or (v_r1->>'run_id')::uuid <> v_run then
    raise exception 'FAIL A1: line 1 result %', v_r1;
  end if;
  -- B (D8): ₹1,180 − ₹1,156 = ₹24 fee, ₹23 already booked → ₹1 remainder, never refused
  if (v_r2->>'fee')::int <> 24 or (v_r2->>'fee_booked_now')::int <> 1 then
    raise exception 'FAIL B1: line 2 result %', v_r2;
  end if;
end $$;

do $$
begin
  if (select count(*) from public.bank_transactions
       where id in ('11111111-0000-0000-0000-000000265401','11111111-0000-0000-0000-000000265402') and matched_to_type = 'payment') <> 2 then
    raise exception 'FAIL A2: both lines should be reconciled';
  end if;
  if (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265401' and bank_txn_id is not null) <> 3 then
    raise exception 'FAIL A3: the 3 receipts should carry bank_txn_id';
  end if;
  if (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000265401' and id like 'EXP-RZPFEE-STL-%') <> 2 then
    raise exception 'FAIL A4: one settlement fee expense per line';
  end if;
  if (select amount from public.expenses where id = 'EXP-RZPFEE-STL-setl_R2654B') <> 1 then
    raise exception 'FAIL B2: line 2 fee remainder should be ₹1';
  end if;
  if (select count(*) from public.bank_recon_run_lines where run_id = (select v from r2654_ids where k = 'run') and kind = 'razorpay_settlement') <> 2 then
    raise exception 'FAIL A5: both lines recorded on the run';
  end if;
  if (select count(*) from public.invoices where tenant_id = 'dddddddd-0000-0000-0000-000000265401') <> (select v from r2654_counts where k = 'invoices')
     or (select count(*) from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000265401') <> (select v from r2654_counts where k = 'quotes')
     or (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265401') <> (select v from r2654_counts where k = 'payments') then
    raise exception 'FAIL A6: the batch created an invoice, quote or receipt';
  end if;
end $$;

-- ── C. Twice / another run ─────────────────────────────────────────────────────────────────
do $$
declare v_run uuid := (select v from r2654_ids where k = 'run'); v_run2 uuid; v_msg text;
begin
  begin
    perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
    raise exception 'FAIL C1: same line booked twice';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%already reconciled%' then raise exception 'FAIL C1: message %', v_msg; end if;
  end;
  v_run2 := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  begin
    perform public.reconcile_razorpay_settlement_in_run(v_run2, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
    raise exception 'FAIL C2: a line held by another run was booked again';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%Another run already booked this bank line%' then raise exception 'FAIL C2: message %', v_msg; end if;
  end;
  if (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000265401' and id like 'EXP-RZPFEE-STL-%') <> 2
     or (select count(*) from public.bank_recon_run_lines where tenant_id = 'dddddddd-0000-0000-0000-000000265401') <> 2 then
    raise exception 'FAIL C3: a refused call wrote something';
  end if;
end $$;

-- ── F2. Another company cannot see or undo the run ─────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265403","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.undo_bank_recon_run((select v from r2654_ids where k = 'run'));
  raise exception 'FAIL F4: another company undid the run';
exception when no_data_found then null;
end $$;
reset role;

-- ── D. Undo this run ───────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265401","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := public.undo_bank_recon_run((select v from r2654_ids where k = 'run'));
  if (v_res->>'undone')::int <> 2 or jsonb_array_length(v_res->'left') <> 0 then
    raise exception 'FAIL D1: undo result %', v_res;
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from public.bank_transactions
              where id in ('11111111-0000-0000-0000-000000265401','11111111-0000-0000-0000-000000265402') and matched_to_type is not null) then
    raise exception 'FAIL D2: lines should be free again';
  end if;
  if exists (select 1 from public.razorpay_settlement_recons where tenant_id = 'dddddddd-0000-0000-0000-000000265401')
     or exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000265401' and id like 'EXP-RZPFEE-STL-%') then
    raise exception 'FAIL D3: settlement rows / fee expenses should be gone';
  end if;
  if (select count(*) from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000265401' and status = 'received' and bank_txn_id is null)
     <> (select v from r2654_counts where k = 'payments') then
    raise exception 'FAIL D4: receipts should stay, waiting for their bank line';
  end if;
  if not exists (select 1 from public.expenses where id = 'EXP-RZPFEE-' || pg_temp.pid('pay_R2654three')) then
    raise exception 'FAIL D5: R-2565 per-payment fee expense must stay';
  end if;
  if (select undone_at from public.bank_recon_runs where id = (select v from r2654_ids where k = 'run')) is null then
    raise exception 'FAIL D6: run should be marked undone';
  end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265401","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_res jsonb; v_msg text;
begin
  v_res := public.undo_bank_recon_run((select v from r2654_ids where k = 'run'));
  if (v_res->>'undone')::int <> 0 then raise exception 'FAIL D7: undo again should undo 0 (%)', v_res; end if;
  -- an undone run books nothing
  begin
    perform public.reconcile_razorpay_settlement_in_run((select v from r2654_ids where k = 'run'), '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
    raise exception 'FAIL F5: undone run booked';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%This run was undone%' then raise exception 'FAIL F5: message %', v_msg; end if;
  end;
end $$;

-- ── E. A line changed by hand after the run is left ────────────────────────────────────────
do $$
declare v_run uuid; v_res jsonb;
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  insert into r2654_ids values ('run3', v_run);
  perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
  perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265402', pg_temp.setl2());
  -- by hand: line 2 un-reconciled from the sheet
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000265402', false);
  v_res := public.undo_bank_recon_run(v_run);
  if (v_res->>'undone')::int <> 1 or jsonb_array_length(v_res->'left') <> 1
     or (v_res->'left'->0->>'reason') not like 'Changed since the run%' then
    raise exception 'FAIL E1: undo result %', v_res;
  end if;
  if (select undone_at from public.bank_recon_runs where id = v_run) is not null then
    raise exception 'FAIL E2: a run with a line left is not marked undone';
  end if;
end $$;

-- ── H. That hand-freed line is not stuck: a new run books it (the stale record is released) and the
--      old run's Undo no longer touches it ──────────────────────────────────────────────────────────
do $$
declare v_old uuid := (select v from r2654_ids where k = 'run3'); v_new uuid; v_res jsonb;
begin
  v_new := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  perform public.reconcile_razorpay_settlement_in_run(v_new, '11111111-0000-0000-0000-000000265402', pg_temp.setl2());
  if not exists (select 1 from public.bank_recon_run_lines where run_id = v_new and txn_id = '11111111-0000-0000-0000-000000265402' and undone_at is null) then
    raise exception 'FAIL H1: new run did not record the line';
  end if;
  v_res := public.undo_bank_recon_run(v_old);
  if (v_res->>'undone')::int <> 0 or jsonb_array_length(v_res->'left') <> 0 then
    raise exception 'FAIL H2: old run undo should find nothing of its own now (%)', v_res;
  end if;
  if not exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000265402' and matched_to_type = 'payment') then
    raise exception 'FAIL H3: the old run undid the new run''s booking';
  end if;
  v_res := public.undo_bank_recon_run(v_new);
  if (v_res->>'undone')::int <> 1 then raise exception 'FAIL H4: new run undo %', v_res; end if;
end $$;
reset role;

-- ── G. Books locked over the line's day: the run refuses the line, nothing written ────────────
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = '2026-10-31' where id = 'dddddddd-0000-0000-0000-000000265401';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000265401","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_run uuid; v_ok boolean := false; v_msg text;
begin
  v_run := public.razorpay_batch_run_start('bbbbbbbb-0000-0000-0000-000000265401');
  begin
    perform public.reconcile_razorpay_settlement_in_run(v_run, '11111111-0000-0000-0000-000000265401', pg_temp.setl1());
  exception when others then
    v_ok := true;
    /* R-2745 (R-2654 checker gap): the refusal IS the books lock, not some other error. */
    get stacked diagnostics v_msg = message_text;
    if v_msg not ilike '%lock%' then raise exception 'FAIL G1: refused for another reason: %', v_msg; end if;
  end;
  if not v_ok then raise exception 'FAIL G1: a line inside locked books was booked'; end if;
  if exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000265401' and matched_to_type is not null)
     or exists (select 1 from public.bank_recon_run_lines where run_id = v_run) then
    raise exception 'FAIL G2: refused booking wrote something';
  end if;
end $$;
reset role;

select 'r2654_razorpay_month_batch: ALL PASS' as result;

rollback;
