-- R-1864 (24 Oct 2026): an asset bought on EMI / loan — purchase → asset + loan + schedule in one
-- step; imported bank debits reconciled to the down payment and to each EMI, split into principal
-- (reduces the loan) and interest (P&L); late fee as an expense; prepayment recomputes the rest;
-- undo / un-reconcile put everything back. Migration 20261024200500_r1864_emi_asset_loan.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The laptop: ₹1,20,000, ₹20,000 down + ₹500 processing fee from HDFC, ₹1,00,000 at 14% for 12
-- months (EMI ₹8,979; the 12th ₹8,977 absorbs the rounding), first EMI 5 Nov 2026.
--
-- Proves:
--   A. One step: emi purchase (financed 1,00,000), the asset in the register at 1,20,000, 12 schedule
--      rows summing to 1,00,000, the fee as a Bank Charges expense, ONE ₹20,500 manual line.
--   B. Refused, nothing written: a schedule that does not repay the loan, an EMI ≠ principal + interest,
--      a no-cost EMI with interest, a sales login (42501), a no-company login (28000).
--   C. The imported ₹20,500 down-payment line is suggested and replaces the manual line: the
--      account's money out stays ₹20,500 (never twice).
--   D. Auto-reconcile matches the ₹8,979 EMI-1 line on its own: principal 7,812, interest 1,167.
--   E. EMI 2 cannot be skipped; the ₹9,029 line = EMI 2 (7,903 + 1,076) + ₹50 late fee (expense).
--   F. Loan = 84,285 on the Balance Sheet (principal only); P&L: interest 2,243, charges 550; no
--      expense of a principal amount.
--   G. ₹20,000 prepayment on 10 Jan 2027 (EMI 3 of 5 Jan still unpaid — overdue keeps its date): loan
--      64,285, rows 3..12 replaced by the recomputed schedule (₹6,848).
--   H. Undo the prepayment (schedule back to ₹8,979 rows), un-reconcile EMI 2 (payment + interest +
--      late fee gone), un-reconcile the down payment (a manual line comes back — cash stays right).
--   I. Paid by hand (pay_next_emi) then the statement arrives: the statement line replaces it.
--   J. Foreclosure closes the loan.


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
  ('dddddddd-0000-0000-0000-000000186401','R1864 Co','r1864@example.in','07','R1864'),
  ('dddddddd-0000-0000-0000-000000186402','R1864 Other','r1864b@example.in','07','R1864B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000186401','owner1864@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186402','sales1864@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000186403','nocompany1864@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000186401','dddddddd-0000-0000-0000-000000186401','owner1864@example.in','Owner 1864','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000186402','dddddddd-0000-0000-0000-000000186401','sales1864@example.in','Sales 1864','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000186401','dddddddd-0000-0000-0000-000000186401','HDFC Current','HDFC', 500000),
  ('bbbbbbbb-0000-0000-0000-000000186402','dddddddd-0000-0000-0000-000000186402','Other bank','SBI', 0);

create temp table r1864_sched as select '[
 {"seq":1,"due_on":"2026-11-05","emi":8979,"principal":7812,"interest":1167,"balance_after":92188},
 {"seq":2,"due_on":"2026-12-05","emi":8979,"principal":7903,"interest":1076,"balance_after":84285},
 {"seq":3,"due_on":"2027-01-05","emi":8979,"principal":7996,"interest":983,"balance_after":76289},
 {"seq":4,"due_on":"2027-02-05","emi":8979,"principal":8089,"interest":890,"balance_after":68200},
 {"seq":5,"due_on":"2027-03-05","emi":8979,"principal":8183,"interest":796,"balance_after":60017},
 {"seq":6,"due_on":"2027-04-05","emi":8979,"principal":8279,"interest":700,"balance_after":51738},
 {"seq":7,"due_on":"2027-05-05","emi":8979,"principal":8375,"interest":604,"balance_after":43363},
 {"seq":8,"due_on":"2027-06-05","emi":8979,"principal":8473,"interest":506,"balance_after":34890},
 {"seq":9,"due_on":"2027-07-05","emi":8979,"principal":8572,"interest":407,"balance_after":26318},
 {"seq":10,"due_on":"2027-08-05","emi":8979,"principal":8672,"interest":307,"balance_after":17646},
 {"seq":11,"due_on":"2027-09-05","emi":8979,"principal":8773,"interest":206,"balance_after":8873},
 {"seq":12,"due_on":"2027-10-05","emi":8977,"principal":8873,"interest":104,"balance_after":0}]'::jsonb as s;
grant select on r1864_sched to public;

create function pg_temp.r1864_input(p_sched jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('name','Dell laptop','block','computers','cost',120000,'down_payment',20000,
    'processing_fee',500,'processing_fee_gst',0,'purchased_on','2026-10-05','lender','Bajaj Finance',
    'lender_ref','LAN4455','interest_rate',14,'no_cost',false,
    'account_id','bbbbbbbb-0000-0000-0000-000000186401','schedule',p_sched) || p_extra;
$f$;
create function pg_temp.r1864_out() returns integer language sql as $f$
  select coalesce(sum(debit),0)::integer from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000186401';
$f$;

-- ── B (part 1). Guards: a sales login and a no-company login ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000186402","role":"authenticated"}', true);
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r1864_input((select s from r1864_sched)));
  raise exception 'FAIL B: a sales login recorded an EMI purchase';
exception when insufficient_privilege then
  if sqlerrm not like 'Only an owner, manager or accountant%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000186403","role":"authenticated"}', true);
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r1864_input((select s from r1864_sched)));
  raise exception 'FAIL B: a no-company login recorded an EMI purchase';
exception when sqlstate '28000' then null;
end $$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000186401","role":"authenticated"}', true);

-- B (part 2). Bad schedules refused.
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r1864_input(
    jsonb_set((select s from r1864_sched), '{11,principal}', '8000')));
  raise exception 'FAIL B: a schedule that does not repay the loan was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'EMI 12 is ₹8977 but principal + interest%' and sqlerrm not like '%owed%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r1864_input(
    jsonb_set(jsonb_set(jsonb_set((select s from r1864_sched), '{11,principal}', '8000'), '{11,emi}', '8104'), '{11,balance_after}', '873')));
  raise exception 'FAIL B: a schedule that leaves ₹873 unpaid was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'EMI 12: balance after should be%' and sqlerrm not like 'The schedule repays%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r1864_input((select s from r1864_sched), '{"no_cost":true}'));
  raise exception 'FAIL B: a no-cost EMI with interest was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'A no-cost EMI has no interest%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if exists (select 1 from public.emi_purchases where tenant_id = 'dddddddd-0000-0000-0000-000000186401')
     or exists (select 1 from public.fixed_assets where tenant_id = 'dddddddd-0000-0000-0000-000000186401')
     or exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000186401') then
    raise exception 'FAIL B: a refused purchase left rows behind';
  end if;
end $$;

-- A. The purchase.
create temp table r1864_ids (k text primary key, v uuid);
grant all on r1864_ids to public;
insert into r1864_ids values ('p', public.record_emi_asset_purchase(pg_temp.r1864_input((select s from r1864_sched))));

do $$
declare v_p public.emi_purchases; v_n integer; v_sum integer; v_fa public.fixed_assets; v_e public.expenses; v_line public.bank_transactions;
begin
  select * into v_p from public.emi_purchases where id = (select v from r1864_ids where k = 'p');
  if v_p.financed <> 100000 or v_p.total_cost <> 120000 or v_p.emi_amount <> 8979 or v_p.emi_count <> 12
     or v_p.first_emi_on <> '2026-11-05' or v_p.interest_rate <> 14 or v_p.status <> 'active' then
    raise exception 'FAIL A: purchase row %', row_to_json(v_p);
  end if;
  select count(*), sum(principal) into v_n, v_sum from public.emi_schedule where purchase_id = v_p.id;
  if v_n <> 12 or v_sum <> 100000 then raise exception 'FAIL A: schedule % rows, principal %', v_n, v_sum; end if;
  select * into v_fa from public.fixed_assets where emi_purchase_id = v_p.id;
  if v_fa.cost <> 120000 or v_fa.block <> 'computers' or v_fa.put_to_use <> '2026-10-05' then
    raise exception 'FAIL A: asset %', row_to_json(v_fa);
  end if;
  select * into v_e from public.expenses where id = v_p.fee_expense_id;
  if v_e.amount <> 500 or v_e.category <> 'Bank Charges' or v_e.payment_method <> 'emi' then
    raise exception 'FAIL A: fee expense %', row_to_json(v_e);
  end if;
  select * into v_line from public.bank_transactions where id = v_p.down_bank_txn_id;
  if v_line.debit <> 20500 or v_line.source <> 'manual' or v_line.matched_to_type <> 'emi' then
    raise exception 'FAIL A: down-payment line %', row_to_json(v_line);
  end if;
  if pg_temp.r1864_out() <> 20500 then raise exception 'FAIL A: money out % (want 20500)', pg_temp.r1864_out(); end if;
end $$;

-- The statement arrives (imported lines).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000186401','dddddddd-0000-0000-0000-000000186401','bbbbbbbb-0000-0000-0000-000000186401','2026-10-05','POS CROMA RETAIL DELL',20500,0,'C1','csv_upload'),
  ('11111111-0000-0000-0000-000000186402','dddddddd-0000-0000-0000-000000186401','bbbbbbbb-0000-0000-0000-000000186401','2026-11-05','NACH DR BAJAJ FINANCE LAN4455',8979,0,'N1','csv_upload'),
  ('11111111-0000-0000-0000-000000186403','dddddddd-0000-0000-0000-000000186401','bbbbbbbb-0000-0000-0000-000000186401','2026-12-07','NACH DR BAJAJ FINANCE EMI',9029,0,'N2','csv_upload'),
  ('11111111-0000-0000-0000-000000186409','dddddddd-0000-0000-0000-000000186402','bbbbbbbb-0000-0000-0000-000000186402','2026-11-05','BAJAJ FINANCE EMI',8979,0,'X','csv_upload');

-- C. Down payment.
do $$
declare v_kind text; v_conf text; v_old uuid;
begin
  select m.kind, m.confidence into v_kind, v_conf from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000186401') m limit 1;
  if v_kind is distinct from 'down_payment' or v_conf not in ('exact', 'high') then
    raise exception 'FAIL C: suggestion % / %', v_kind, v_conf;
  end if;
  select down_bank_txn_id into v_old from public.emi_purchases where id = (select v from r1864_ids where k = 'p');
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186401', (select v from r1864_ids where k = 'p'), 0);
  if exists (select 1 from public.bank_transactions where id = v_old) then raise exception 'FAIL C: manual line still there'; end if;
  if (select down_bank_txn_id from public.emi_purchases where id = (select v from r1864_ids where k = 'p')) <> '11111111-0000-0000-0000-000000186401' then
    raise exception 'FAIL C: purchase not on the imported line';
  end if;
  -- out = 20,500 (down) + 8,979 + 9,029 imported but not yet booked
  if pg_temp.r1864_out() <> 20500 + 8979 + 9029 then raise exception 'FAIL C: money out %', pg_temp.r1864_out(); end if;
end $$;

-- Another company's line is never offered or taken.
do $$ begin
  if exists (select 1 from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000186409')) then
    raise exception 'FAIL C: another company''s line got suggestions';
  end if;
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186409', (select v from r1864_ids where k = 'p'), 1);
  raise exception 'FAIL C: another company''s line was reconciled';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Bank line not found in your company%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
end $$;

-- E (part 1). EMI 2 cannot go before EMI 1.
do $$ begin
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186403', (select v from r1864_ids where k = 'p'), 2, null, null, 50);
  raise exception 'FAIL E: EMI 2 paid before EMI 1';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Pay EMI 1 first%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
end $$;

-- D. Auto-reconcile.
do $$
declare v_r jsonb; v_pay public.emi_payments; v_line public.bank_transactions;
begin
  v_r := public.auto_reconcile_bank_account('bbbbbbbb-0000-0000-0000-000000186401');
  select * into v_line from public.bank_transactions where id = '11111111-0000-0000-0000-000000186402';
  if v_line.matched_to_type is distinct from 'emi' then raise exception 'FAIL D: EMI 1 not auto-matched (%)', v_r; end if;
  select * into v_pay from public.emi_payments where bank_txn_id = v_line.id;
  if v_pay.principal_part <> 7812 or v_pay.interest_part <> 1167 or v_pay.charges <> 0 or v_pay.schedule_seq <> 1 then
    raise exception 'FAIL D: split %', row_to_json(v_pay);
  end if;
  if (select amount from public.expenses where id = v_pay.expense_id) <> 1167
     or (select category from public.expenses where id = v_pay.expense_id) <> 'Interest' then
    raise exception 'FAIL D: interest expense';
  end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000186403') is not null then
    raise exception 'FAIL D: the ₹9,029 line (not the EMI amount) was auto-matched';
  end if;
  -- …and it is reported as "weak match — open and confirm", not "no record in the books".
  if (v_r ->> 'low_confidence')::integer <> 1 or (v_r ->> 'no_match')::integer <> 0 then
    raise exception 'FAIL D: the ₹9,029 EMI line should count as a weak match (%)', v_r;
  end if;
end $$;

-- E (part 2). ₹9,029 = EMI 2 + ₹50 late fee.
do $$
declare v_r jsonb; v_pay public.emi_payments; v_diff integer;
begin
  select m.difference into v_diff from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000186403') m where m.seq = 2;
  if v_diff is distinct from 50 then raise exception 'FAIL E: difference % (want 50)', v_diff; end if;
  v_r := public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186403', (select v from r1864_ids where k = 'p'), 2, null, null, 50);
  select * into v_pay from public.emi_payments where id = (v_r ->> 'payment_id')::uuid;
  if v_pay.principal_part <> 7903 or v_pay.interest_part <> 1076 or v_pay.charges <> 50 or v_pay.amount <> 9029 then
    raise exception 'FAIL E: split %', row_to_json(v_pay);
  end if;
  if (select amount from public.expenses where id = v_pay.charges_expense_id) <> 50 then raise exception 'FAIL E: late fee expense'; end if;
end $$;

-- F. Reports.
do $$
declare v_bs record; v_int integer; v_chg integer;
begin
  select * into v_bs from public.report_balance_sheet('2026-12-31');
  if v_bs.emi_loans_payable <> 84285 then raise exception 'FAIL F: loan on the Balance Sheet % (want 84285)', v_bs.emi_loans_payable; end if;
  if v_bs.emi_unregistered_cost <> 0 then raise exception 'FAIL F: asset counted at cost outside the register'; end if;
  if v_bs.expenses_payable <> 0 or v_bs.expenses_paid_unbanked <> 0 then
    raise exception 'FAIL F: EMI expenses counted as payable / unbanked (% / %)', v_bs.expenses_payable, v_bs.expenses_paid_unbanked;
  end if;
  select coalesce(sum(amount) filter (where category = 'Interest'), 0), coalesce(sum(amount) filter (where category = 'Bank Charges'), 0)
    into v_int, v_chg from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000186401';
  if v_int <> 2243 or v_chg <> 550 then raise exception 'FAIL F: interest % charges %', v_int, v_chg; end if;
  if exists (select 1 from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000186401' and amount in (7812, 7903, 8979, 9029)) then
    raise exception 'FAIL F: a principal / whole EMI went to expense';
  end if;
end $$;

-- G. Prepayment ₹20,000 (keep tenure).
do $$
declare v_r jsonb; v_n integer; v_sum integer; v_emi integer;
begin
  v_r := public.prepay_emi_loan((select v from r1864_ids where k = 'p'), 20000, 0, 0, '2027-01-10',
    'bbbbbbbb-0000-0000-0000-000000186401', null, false, '[
 {"seq":3,"due_on":"2027-01-05","emi":6848,"principal":6098,"interest":750,"balance_after":58187},
 {"seq":4,"due_on":"2027-02-05","emi":6848,"principal":6169,"interest":679,"balance_after":52018},
 {"seq":5,"due_on":"2027-03-05","emi":6848,"principal":6241,"interest":607,"balance_after":45777},
 {"seq":6,"due_on":"2027-04-05","emi":6848,"principal":6314,"interest":534,"balance_after":39463},
 {"seq":7,"due_on":"2027-05-05","emi":6848,"principal":6388,"interest":460,"balance_after":33075},
 {"seq":8,"due_on":"2027-06-05","emi":6848,"principal":6462,"interest":386,"balance_after":26613},
 {"seq":9,"due_on":"2027-07-05","emi":6848,"principal":6538,"interest":310,"balance_after":20075},
 {"seq":10,"due_on":"2027-08-05","emi":6848,"principal":6614,"interest":234,"balance_after":13461},
 {"seq":11,"due_on":"2027-09-05","emi":6848,"principal":6691,"interest":157,"balance_after":6770},
 {"seq":12,"due_on":"2027-10-05","emi":6849,"principal":6770,"interest":79,"balance_after":0}]'::jsonb);
  insert into r1864_ids values ('prepay', (v_r ->> 'payment_id')::uuid);
  if (v_r ->> 'outstanding')::integer <> 64285 then raise exception 'FAIL G: outstanding %', v_r; end if;
  select count(*), sum(principal), max(emi) filter (where seq = 3) into v_n, v_sum, v_emi
    from public.emi_schedule where purchase_id = (select v from r1864_ids where k = 'p') and emi_payment_id is null;
  if v_n <> 10 or v_sum <> 64285 or v_emi <> 6848 then raise exception 'FAIL G: schedule % rows % principal EMI %', v_n, v_sum, v_emi; end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 64285 then raise exception 'FAIL G: Balance Sheet'; end if;
end $$;

-- A prepayment more than owed, and a schedule that doesn't fit, are refused.
do $$ begin
  perform public.prepay_emi_loan((select v from r1864_ids where k = 'p'), 70000, 0, 0, '2026-12-21',
    'bbbbbbbb-0000-0000-0000-000000186401', null, false, '[]'::jsonb);
  raise exception 'FAIL G: prepaid more than owed';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Prepayment ₹70000 is more than%' then raise exception 'FAIL G: wrong refusal: %', sqlerrm; end if;
end $$;

-- H. Undo.
do $$
declare v_emi integer; v_out integer;
begin
  -- EMI 2 cannot be un-reconciled while the later prepayment stands.
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000186403';
    raise exception 'FAIL H: EMI 2 freed before the later prepayment was undone';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Undo the later EMI payments%' then raise exception 'FAIL H: wrong refusal: %', sqlerrm; end if;
  end;
  v_out := pg_temp.r1864_out();
  perform public.undo_emi_payment((select v from r1864_ids where k = 'prepay'));
  if pg_temp.r1864_out() <> v_out - 20000 then raise exception 'FAIL H: prepayment manual line not removed'; end if;
  select emi into v_emi from public.emi_schedule where purchase_id = (select v from r1864_ids where k = 'p') and seq = 3;
  if v_emi <> 8979 then raise exception 'FAIL H: schedule not restored (EMI 3 = %)', v_emi; end if;
  -- Now EMI 2 frees cleanly: payment, interest and late fee go; row 2 is due again.
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000186403';
  if exists (select 1 from public.emi_payments where bank_txn_id = '11111111-0000-0000-0000-000000186403') then raise exception 'FAIL H: payment kept'; end if;
  if (select sum(amount) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000186401' and category = 'Interest') <> 1167 then
    raise exception 'FAIL H: EMI 2 interest kept';
  end if;
  if (select emi_payment_id from public.emi_schedule where purchase_id = (select v from r1864_ids where k = 'p') and seq = 2) is not null then
    raise exception 'FAIL H: row 2 still linked';
  end if;
  if public.emi_outstanding((select v from r1864_ids where k = 'p')) <> 92188 then raise exception 'FAIL H: outstanding'; end if;
  -- Down payment freed → a manual line comes back (money out unchanged).
  v_out := pg_temp.r1864_out();
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000186401';
  if pg_temp.r1864_out() <> v_out + 20500 then raise exception 'FAIL H: down payment manual line not restored'; end if;
  -- A manual EMI line cannot be freed by hand.
  begin
    update public.bank_transactions set matched_to_type = null
     where id = (select down_bank_txn_id from public.emi_purchases where id = (select v from r1864_ids where k = 'p'));
    raise exception 'FAIL H: a manual EMI line was freed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  -- Put the down payment back on the statement line for the rest.
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186401', (select v from r1864_ids where k = 'p'), 0);
end $$;

-- I. Paid by hand, then the statement line replaces it.
do $$
declare v_r jsonb; v_pay public.emi_payments; v_out integer;
begin
  v_r := public.pay_next_emi((select v from r1864_ids where k = 'p'), 'bbbbbbbb-0000-0000-0000-000000186401', '2026-12-05');
  if (v_r ->> 'seq')::integer <> 2 or (v_r ->> 'interest')::integer <> 1076 then raise exception 'FAIL I: pay_next_emi %', v_r; end if;
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
    ('11111111-0000-0000-0000-000000186404','dddddddd-0000-0000-0000-000000186401','bbbbbbbb-0000-0000-0000-000000186401','2026-12-05','NACH BAJAJ FINANCE',8979,0,'N3','csv_upload');
  v_out := pg_temp.r1864_out();
  if not exists (select 1 from public.emi_matches_for_bank_txn('11111111-0000-0000-0000-000000186404') m where m.kind = 'paid_by_hand' and m.seq = 2) then
    raise exception 'FAIL I: paid-by-hand EMI not suggested';
  end if;
  perform public.reconcile_bank_debit_to_emi('11111111-0000-0000-0000-000000186404', (select v from r1864_ids where k = 'p'), 2);
  if pg_temp.r1864_out() <> v_out - 8979 then raise exception 'FAIL I: manual EMI line not replaced (out %)', pg_temp.r1864_out(); end if;
  select * into v_pay from public.emi_payments where bank_txn_id = '11111111-0000-0000-0000-000000186404';
  if v_pay.principal_part <> 7903 then raise exception 'FAIL I: payment not moved'; end if;
end $$;

-- J. Foreclosure (₹84,285 owed + ₹1,000 charge) from a statement line closes the loan.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000186405','dddddddd-0000-0000-0000-000000186401','bbbbbbbb-0000-0000-0000-000000186401','2026-12-28','BAJAJ FINANCE FORECLOSURE',85285,0,'F1','csv_upload');
do $$
declare v_r jsonb;
begin
  v_r := public.prepay_emi_loan((select v from r1864_ids where k = 'p'), null, 0, 1000, null, null,
    '11111111-0000-0000-0000-000000186405', true, null);
  if (v_r ->> 'principal')::integer <> 84285 or (v_r ->> 'outstanding')::integer <> 0 then raise exception 'FAIL J: %', v_r; end if;
  if (select status from public.emi_purchases where id = (select v from r1864_ids where k = 'p')) <> 'closed' then raise exception 'FAIL J: not closed'; end if;
  if exists (select 1 from public.emi_schedule where purchase_id = (select v from r1864_ids where k = 'p') and emi_payment_id is null) then
    raise exception 'FAIL J: unpaid rows left';
  end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 0 then raise exception 'FAIL J: Balance Sheet loan not 0'; end if;
end $$;

select 'R-1864 emi asset loan: ALL PASS' as result;

rollback;
