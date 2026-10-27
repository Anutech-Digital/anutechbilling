-- R-1952 (26 Oct 2026, goal G-RECON — R-1913 / R-1915 follow-up): every place that pays or shows
-- an expense (vendor) bill uses   still due = amount − tds_amount − advance_applied − paid_amount
-- never the full bill.
-- Migration: 2026102*_r1952_vendor_bill_still_due.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Owner's path (card howToCheck): Verma's ₹5,000 bill, ₹3,000 of his advance applied on 10 Oct.
--   B. Balance Sheet as of 5 Oct (before the advance was applied, before the bank part) shows
--      each bill's FULL payable and the advance still as prepaid; as of today the rest only.
--   D. Deleting a part-paid bill gives a sentence ("un-reconcile its bank parts first"), not a
--      raw foreign-key error.
--   P. Payment run: Verma's bill is owed ₹2,000 (not ₹5,000); Sharma's part-paid ₹10,000 bill
--      ₹6,000; Kapoor's ₹10,000 bill with ₹1,000 TDS ₹9,000. More than the rest is refused, less
--      than the rest is refused (an expense bill in a run pays its whole rest); the run pays
--      exactly the rest. A bill whose rest changed after the run was made cannot be approved.

begin;

create function pg_temp.r1952_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1952_supplier before insert on public.tenants for each row execute function pg_temp.r1952_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000195201','R1952 Co','r1952@example.in','07','R1952');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000195201','owner1952@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000195201','dddddddd-0000-0000-0000-000000195201','owner1952@example.in','Owner 1952','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000195201','dddddddd-0000-0000-0000-000000195201','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000195201','dddddddd-0000-0000-0000-000000195201','Verma Contractors','07AAKFV1952A1Z5','AAKFV1952A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000195202','dddddddd-0000-0000-0000-000000195201','Sharma Associates','07AAKFS1952A1Z5','AAKFS1952A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000195203','dddddddd-0000-0000-0000-000000195201','Kapoor CA','07AAKFK1952A1Z5','AAKFK1952A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000195204','dddddddd-0000-0000-0000-000000195201','Gupta Printers','07AAKFG1952A1Z5','AAKFG1952A','Printing & Stationery');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000195201','dddddddd-0000-0000-0000-000000195201','bbbbbbbb-0000-0000-0000-000000195201','2026-10-01','IMPS VERMA CONTRACTORS ADV',8000,0,'I1','csv_upload'),
  ('11111111-0000-0000-0000-000000195202','dddddddd-0000-0000-0000-000000195201','bbbbbbbb-0000-0000-0000-000000195201','2026-10-12','UPI SHARMA ASSOCIATES PART',4000,0,'U1','csv_upload');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_section, tds_amount) values
  ('EXP-R1952-VB1','dddddddd-0000-0000-0000-000000195201','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000195201','2026-10-01',5000,0,'none','VB-1',false,null,null,0),
  ('EXP-R1952-VB2','dddddddd-0000-0000-0000-000000195201','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000195201','2026-10-01',4000,0,'none','VB-2',false,null,null,0),
  ('EXP-R1952-SB1','dddddddd-0000-0000-0000-000000195201','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000195202','2026-10-01',10000,0,'none','SB-1',false,null,null,0),
  ('EXP-R1952-KB1','dddddddd-0000-0000-0000-000000195201','Professional Services','Kapoor CA','eeeeeeee-0000-0000-0000-000000195203','2026-10-01',10000,0,'none','KB-1',false,null,'194J',1000),
  ('EXP-R1952-GB1','dddddddd-0000-0000-0000-000000195201','Printing & Stationery','Gupta Printers','eeeeeeee-0000-0000-0000-000000195204','2026-10-01',3000,0,'none','GB-1',false,null,null,0);

-- Owner 1952 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000195201","role":"authenticated"}', true);

-- Verma: ₹8,000 advance from the bank on 1 Oct; on 10 Oct ₹3,000 of it goes on VB-1 and the
-- whole ₹4,000 VB-2 is settled from it. Sharma: ₹4,000 bank part on SB-1 on 12 Oct.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000195201','eeeeeeee-0000-0000-0000-000000195201', null, '[]'::jsonb, null, 8000, 'Repairs & Maintenance');
select public.apply_vendor_advance('expense', 'EXP-R1952-VB1', 3000, '2026-10-10');
select public.apply_vendor_advance('expense', 'EXP-R1952-VB2', null, '2026-10-10');
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000195202','eeeeeeee-0000-0000-0000-000000195202', null,
  '[{"source":"expense","doc_id":"EXP-R1952-SB1","amount":4000,"tds_amount":0}]'::jsonb);

do $$
declare e public.expenses;
begin
  select * into e from public.expenses where id = 'EXP-R1952-VB1';
  if e.advance_applied <> 3000 or e.paid then raise exception 'setup FAIL VB-1: advance % paid %', e.advance_applied, e.paid; end if;
  select * into e from public.expenses where id = 'EXP-R1952-VB2';
  if e.advance_applied <> 4000 or not e.paid or e.payment_method <> 'advance' then raise exception 'setup FAIL VB-2: advance % paid % method %', e.advance_applied, e.paid, e.payment_method; end if;
  select * into e from public.expenses where id = 'EXP-R1952-SB1';
  if e.paid_amount <> 4000 or e.paid then raise exception 'setup FAIL SB-1: paid_amount % paid %', e.paid_amount, e.paid; end if;
end $$;

-- ── B. Balance Sheet as of a date before the advance and the bank part ───────────────────────
do $$
declare v_pay bigint; v_pre bigint;
begin
  -- Today: rest only. VB-1 2,000 + VB-2 0 + SB-1 6,000 + KB-1 9,000 + GB-1 3,000 = 20,000; advance left 1,000.
  select expenses_payable, prepaid_advances into v_pay, v_pre from public.report_balance_sheet();
  if v_pay <> 20000 or v_pre <> 1000 then raise exception 'B FAIL today: payable % (want 20000) prepaid % (want 1000)', v_pay, v_pre; end if;

  -- 5 Oct: nothing applied, nothing paid yet. 5,000 + 4,000 + 10,000 + 9,000 + 3,000 = 31,000;
  -- the whole ₹8,000 advance is still prepaid.
  select expenses_payable, prepaid_advances into v_pay, v_pre from public.report_balance_sheet('2026-10-05');
  if v_pay <> 31000 then raise exception 'B FAIL 5 Oct: expenses payable % (want 31000 — the full bills)', v_pay; end if;
  if v_pre <> 8000 then raise exception 'B FAIL 5 Oct: prepaid % (want 8000 — the advance was applied on 10 Oct)', v_pre; end if;

  -- 11 Oct: advance applied (10 Oct), Sharma's bank part (12 Oct) not yet → 2,000 + 0 + 10,000 + 9,000 + 3,000.
  select expenses_payable, prepaid_advances into v_pay, v_pre from public.report_balance_sheet('2026-10-11');
  if v_pay <> 24000 or v_pre <> 1000 then raise exception 'B FAIL 11 Oct: payable % (want 24000) prepaid % (want 1000)', v_pay, v_pre; end if;
  raise notice 'B ok: Balance Sheet 5 Oct = full bills ₹31,000 + ₹8,000 prepaid; 11 Oct ₹24,000; today ₹20,000 + ₹1,000';
end $$;

-- ── D. Deleting a part-paid bill ─────────────────────────────────────────────────────────────
do $$
declare msg text;
begin
  begin
    perform public.delete_expense('EXP-R1952-SB1');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'D FAIL: a part-paid bill was deleted'; end if;
  if msg not like '%un-reconcile its bank parts first%' then
    raise exception 'D FAIL: deleting a part-paid bill said: %', msg;
  end if;
  if not exists (select 1 from public.expenses where id = 'EXP-R1952-SB1') then raise exception 'D FAIL: bill gone'; end if;
  raise notice 'D ok: part-paid bill delete refused with a sentence: %', msg;
end $$;

-- A plain delete from the app (signed-in user) used to stop on the raw foreign-key error.
set local role authenticated;
do $$
declare msg text;
begin
  begin
    delete from public.expenses where id = 'EXP-R1952-SB1';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%un-reconcile its bank parts first%' then
    raise exception 'D FAIL: plain delete of a part-paid bill said: %', coalesce(msg, 'deleted');
  end if;
  raise notice 'D ok: plain delete refused with the same sentence';
end $$;
reset role;

-- ── P. Payment runs pay the rest, never the whole bill ───────────────────────────────────────
do $$
declare msg text; v_run uuid; r public.payment_runs; e public.expenses; n int; v_debits int;
begin
  if public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-VB1') is distinct from 2000
     or public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-SB1') is distinct from 6000
     or public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-KB1') is distinct from 9000 then
    raise exception 'P FAIL: outstanding VB-1 % (want 2000) SB-1 % (want 6000) KB-1 % (want 9000)',
      public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-VB1'),
      public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-SB1'),
      public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-KB1');
  end if;
  if public.payment_run_outstanding('dddddddd-0000-0000-0000-000000195201', 'expense', 'EXP-R1952-VB2') is not null then
    raise exception 'P FAIL: VB-2 (settled from the advance) still offered';
  end if;

  -- The whole ₹5,000 for VB-1: refused.
  begin
    perform public.create_payment_run('[{"source":"expense","doc_id":"EXP-R1952-VB1","amount":5000}]'::jsonb, 'bbbbbbbb-0000-0000-0000-000000195201', '2026-10-20');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%more than the ₹2000 still owed%' then raise exception 'P FAIL: ₹5,000 on a ₹2,000 rest: %', coalesce(msg, 'accepted'); end if;

  -- Less than the rest: refused (marking it paid would settle the whole bill on ₹1,500).
  begin
    perform public.create_payment_run('[{"source":"expense","doc_id":"EXP-R1952-VB1","amount":1500}]'::jsonb, 'bbbbbbbb-0000-0000-0000-000000195201', '2026-10-20');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%pays its whole rest of ₹2000%' then raise exception 'P FAIL: ₹1,500 on a ₹2,000 rest: %', coalesce(msg, 'accepted'); end if;

  v_run := public.create_payment_run(
    '[{"source":"expense","doc_id":"EXP-R1952-VB1","amount":2000},{"source":"expense","doc_id":"EXP-R1952-SB1","amount":6000},{"source":"expense","doc_id":"EXP-R1952-KB1","amount":9000}]'::jsonb,
    'bbbbbbbb-0000-0000-0000-000000195201', '2026-10-20');
  select * into r from public.payment_runs where id = v_run;
  if r.total <> 17000 then raise exception 'P FAIL: run total % (want 17000)', r.total; end if;
  perform public.approve_payment_run(v_run);
  perform public.mark_payment_run_paid(v_run, '2026-10-20');

  select count(*), sum(debit) into n, v_debits from public.bank_transactions
   where tenant_id = 'dddddddd-0000-0000-0000-000000195201' and reference = r.run_no;
  if n <> 3 or v_debits <> 17000 then raise exception 'P FAIL: run wrote % bank lines for ₹% (want 3 for 17000)', n, v_debits; end if;
  select count(*) into n from public.expenses
   where id in ('EXP-R1952-VB1','EXP-R1952-SB1','EXP-R1952-KB1') and paid and reconciled_txn_id is not null;
  if n <> 3 then raise exception 'P FAIL: % of 3 bills marked paid', n; end if;
  raise notice 'P ok: run pays ₹2,000 + ₹6,000 + ₹9,000 = ₹17,000 (rests), not ₹25,000 of bills';
end $$;

-- A rest that changed after the run was made: approval refused.
do $$
declare msg text; v_run uuid;
begin
  v_run := public.create_payment_run('[{"source":"expense","doc_id":"EXP-R1952-GB1","amount":3000}]'::jsonb, 'bbbbbbbb-0000-0000-0000-000000195201', '2026-10-21');
  update public.expenses set amount = 3500 where id = 'EXP-R1952-GB1';
  begin
    perform public.approve_payment_run(v_run);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%no longer%' then raise exception 'P FAIL: run for ₹3,000 approved on a ₹3,500 rest: %', coalesce(msg, 'approved'); end if;
  raise notice 'P ok: a run whose bill changed cannot be approved';
end $$;

rollback;
