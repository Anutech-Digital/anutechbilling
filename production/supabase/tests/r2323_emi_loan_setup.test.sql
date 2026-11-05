-- R-2323 (1 Nov 2026): "Set up this loan" from an EMI line — a loan the company TOOK, with no
-- asset, stored as an EMI loan (emi_purchases.kind = 'loan') so the R-1864 schedule / reconcile /
-- undo work on it. Migration 20261101*_r2323_emi_loan_setup.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The bike loan (staging, 31 Oct: "Bike EMI ₹19,054 monthly"): ₹2,50,000 still owed, 11% a year,
-- 14 EMIs left, the bank takes ₹19,054 (the standard EMI would be ₹19,109 — the bank's is kept;
-- the 14th, ₹19,873, clears what is left). Schedule from lib/accounting/loan-setup.ts.
--
-- Proves:
--   A. A sales login cannot set up a loan (42501).
--   B. Set up + reconcile THIS line in one step: a 'loan' (no asset in the register), 14 schedule
--      rows, EMI 1 = ₹16,762 principal + ₹2,292 interest (an Interest expense), the line matched
--      once ('emi'), no extra bank line (taken before these books → no money-in line).
--   C. Balance Sheet: the loan ₹2,33,238 is a liability; it is NOT counted as an asset.
--   D. The next ₹19,054 line is suggested as EMI 2 (exact) and splits 16,916 + 2,138.
--   E. Un-reconciling EMI 2 (the bank page's un-reconcile path) takes the payment and its
--      interest back; EMI 2 is due again; the loan is ₹2,33,238 again.
--   F. Refused, nothing written: a line that is not EMI 1, a schedule that does not repay the
--      loan, another company's account.
--   G. Money came into a bank account: ONE ₹1,00,000 money-in line (cash and loan both up);
--      that line cannot be un-matched on the bank page.


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
  ('dddddddd-0000-0000-0000-000000232301','R2323 Co','r2323@example.in','07','R2323'),
  ('dddddddd-0000-0000-0000-000000232302','R2323 Other','r2323b@example.in','07','R2323B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000232301','owner2323@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000232302','sales2323@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000232301','dddddddd-0000-0000-0000-000000232301','owner2323@example.in','Owner 2323','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000232302','dddddddd-0000-0000-0000-000000232301','sales2323@example.in','Sales 2323','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000232301','dddddddd-0000-0000-0000-000000232301','HDFC Current','HDFC', 500000, '2025-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000232302','dddddddd-0000-0000-0000-000000232302','Other bank','SBI', 0, '2025-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000232301','dddddddd-0000-0000-0000-000000232301','bbbbbbbb-0000-0000-0000-000000232301','2026-10-05','NACH DR HDFC BANK BIKE EMI',19054,0,'N1','csv_upload'),
  ('22222222-0000-0000-0000-000000232302','dddddddd-0000-0000-0000-000000232301','bbbbbbbb-0000-0000-0000-000000232301','2026-11-05','NACH DR HDFC BANK BIKE EMI',19054,0,'N2','csv_upload'),
  ('22222222-0000-0000-0000-000000232303','dddddddd-0000-0000-0000-000000232301','bbbbbbbb-0000-0000-0000-000000232301','2026-10-07','ECS TATA CAPITAL',19000,0,'N3','csv_upload');

create temp table r2323_sched as select '[{"seq":1,"due_on":"2026-10-05","emi":19054,"principal":16762,"interest":2292,"balance_after":233238},{"seq":2,"due_on":"2026-11-05","emi":19054,"principal":16916,"interest":2138,"balance_after":216322},{"seq":3,"due_on":"2026-12-05","emi":19054,"principal":17071,"interest":1983,"balance_after":199251},{"seq":4,"due_on":"2027-01-05","emi":19054,"principal":17228,"interest":1826,"balance_after":182023},{"seq":5,"due_on":"2027-02-05","emi":19054,"principal":17385,"interest":1669,"balance_after":164638},{"seq":6,"due_on":"2027-03-05","emi":19054,"principal":17545,"interest":1509,"balance_after":147093},{"seq":7,"due_on":"2027-04-05","emi":19054,"principal":17706,"interest":1348,"balance_after":129387},{"seq":8,"due_on":"2027-05-05","emi":19054,"principal":17868,"interest":1186,"balance_after":111519},{"seq":9,"due_on":"2027-06-05","emi":19054,"principal":18032,"interest":1022,"balance_after":93487},{"seq":10,"due_on":"2027-07-05","emi":19054,"principal":18197,"interest":857,"balance_after":75290},{"seq":11,"due_on":"2027-08-05","emi":19054,"principal":18364,"interest":690,"balance_after":56926},{"seq":12,"due_on":"2027-09-05","emi":19054,"principal":18532,"interest":522,"balance_after":38394},{"seq":13,"due_on":"2027-10-05","emi":19054,"principal":18702,"interest":352,"balance_after":19692},{"seq":14,"due_on":"2027-11-05","emi":19873,"principal":19692,"interest":181,"balance_after":0}]'::jsonb as s,
  '[{"seq":1,"due_on":"2026-10-01","emi":10558,"principal":9558,"interest":1000,"balance_after":90442},{"seq":2,"due_on":"2026-11-01","emi":10558,"principal":9654,"interest":904,"balance_after":80788},{"seq":3,"due_on":"2026-12-01","emi":10558,"principal":9750,"interest":808,"balance_after":71038},{"seq":4,"due_on":"2027-01-01","emi":10558,"principal":9848,"interest":710,"balance_after":61190},{"seq":5,"due_on":"2027-02-01","emi":10558,"principal":9946,"interest":612,"balance_after":51244},{"seq":6,"due_on":"2027-03-01","emi":10558,"principal":10046,"interest":512,"balance_after":41198},{"seq":7,"due_on":"2027-04-01","emi":10558,"principal":10146,"interest":412,"balance_after":31052},{"seq":8,"due_on":"2027-05-01","emi":10558,"principal":10247,"interest":311,"balance_after":20805},{"seq":9,"due_on":"2027-06-01","emi":10558,"principal":10350,"interest":208,"balance_after":10455},{"seq":10,"due_on":"2027-07-01","emi":10560,"principal":10455,"interest":105,"balance_after":0}]'::jsonb as t;
grant select on r2323_sched to public;
create temp table r2323_ids (k text primary key, v uuid);
grant all on r2323_ids to public;

create function pg_temp.r2323_bike(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('lender','HDFC Bank','lender_ref','BIKE','principal',250000,'interest_rate',11,
    'account_id',null,'received_on',null,'reconcile_txn_id','22222222-0000-0000-0000-000000232301',
    'schedule',(select s from r2323_sched)) || p_extra;
$f$;

-- ── A. A sales login is refused ──────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232302","role":"authenticated"}', true);
do $$ begin
  perform public.record_emi_loan_taken(pg_temp.r2323_bike());
  raise exception 'FAIL A: a sales login set up a loan';
exception when insufficient_privilege then
  if sqlerrm not like 'Only an owner, manager or accountant%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
end $$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232301","role":"authenticated"}', true);

-- F. Refused, nothing written.
do $$ begin
  -- the ₹19,000 Tata line is not the bike loan's ₹19,054 EMI 1
  perform public.record_emi_loan_taken(pg_temp.r2323_bike('{"reconcile_txn_id":"22222222-0000-0000-0000-000000232303"}'));
  raise exception 'FAIL F: a line that is not EMI 1 was reconciled';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'This line is not the scheduled EMI%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.record_emi_loan_taken(pg_temp.r2323_bike('{"principal":260000}'));
  raise exception 'FAIL F: a schedule that does not repay the loan was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'EMI 1: balance after should be%' and sqlerrm not like 'The schedule repays%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.record_emi_loan_taken(pg_temp.r2323_bike(
    '{"reconcile_txn_id":null,"account_id":"bbbbbbbb-0000-0000-0000-000000232302","received_on":"2026-09-01"}'));
  raise exception 'FAIL F: another company''s account was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'That bank / cash account is not in your company%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if exists (select 1 from public.emi_purchases where tenant_id = 'dddddddd-0000-0000-0000-000000232301') then
    raise exception 'FAIL F: a refused set-up left a loan behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000232301' and matched_to_type is not null) then
    raise exception 'FAIL F: a refused set-up matched a line';
  end if;
end $$;

-- B. Set up the bike loan and reconcile this line as EMI 1, one step.
do $$
declare v_r jsonb; v_p public.emi_purchases; v_pay public.emi_payments; v_line public.bank_transactions;
begin
  v_r := public.record_emi_loan_taken(pg_temp.r2323_bike());
  insert into r2323_ids values ('bike', (v_r ->> 'purchase_id')::uuid);
  select * into v_p from public.emi_purchases where id = (v_r ->> 'purchase_id')::uuid;
  if v_p.kind <> 'loan' or v_p.financed <> 250000 or v_p.down_payment <> 0 or v_p.lender <> 'HDFC Bank'
     or v_p.first_emi_on <> '2026-10-05' or v_p.emi_count <> 14 or v_p.emi_amount <> 19054 or v_p.status <> 'active' then
    raise exception 'FAIL B: loan row %', row_to_json(v_p);
  end if;
  if exists (select 1 from public.fixed_assets where emi_purchase_id = v_p.id) then raise exception 'FAIL B: a loan was put in the asset register'; end if;
  if (select count(*) from public.emi_schedule where purchase_id = v_p.id) <> 14 then raise exception 'FAIL B: schedule rows'; end if;
  if (v_r -> 'reconciled' ->> 'seq')::integer <> 1 then raise exception 'FAIL B: not reconciled as EMI 1: %', v_r; end if;
  select * into v_pay from public.emi_payments where purchase_id = v_p.id;
  if v_pay.principal_part <> 16762 or v_pay.interest_part <> 2292 or v_pay.schedule_seq <> 1
     or v_pay.bank_txn_id <> '22222222-0000-0000-0000-000000232301' then
    raise exception 'FAIL B: EMI 1 split %', row_to_json(v_pay);
  end if;
  if (select amount from public.expenses where id = v_pay.expense_id and category = 'Interest') <> 2292 then
    raise exception 'FAIL B: interest expense';
  end if;
  select * into v_line from public.bank_transactions where id = '22222222-0000-0000-0000-000000232301';
  if v_line.matched_to_type <> 'emi' or v_line.matched_to_id <> v_pay.id::text then raise exception 'FAIL B: line not matched to the EMI'; end if;
  if (select count(*) from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000232301') <> 3 then
    raise exception 'FAIL B: a bank line was added for a loan taken before these books';
  end if;
  if exists (select 1 from public.expenses where tenant_id = v_p.tenant_id and amount in (19054, 16762)) then
    raise exception 'FAIL B: the EMI / principal was booked as an expense';
  end if;
end $$;

-- C. Balance Sheet: a liability, not an asset.
do $$
declare v_bs record;
begin
  select * into v_bs from public.report_balance_sheet('2026-12-31');
  if v_bs.emi_loans_payable <> 233238 then raise exception 'FAIL C: loan on the Balance Sheet %', v_bs.emi_loans_payable; end if;
  if v_bs.emi_unregistered_cost <> 0 then raise exception 'FAIL C: the loan was counted as an asset (%)', v_bs.emi_unregistered_cost; end if;
end $$;

-- D. The next ₹19,054 line: suggested as EMI 2 and split by the schedule.
do $$
declare v_m record; v_r jsonb;
begin
  select * into v_m from public.emi_matches_for_bank_txn('22222222-0000-0000-0000-000000232302') m limit 1;
  if v_m.purchase_id is distinct from (select v from r2323_ids where k = 'bike') or v_m.seq <> 2
     or v_m.confidence <> 'exact' or v_m.kind <> 'instalment' then
    raise exception 'FAIL D: suggestion %', row_to_json(v_m);
  end if;
  v_r := public.reconcile_bank_debit_to_emi('22222222-0000-0000-0000-000000232302', (select v from r2323_ids where k = 'bike'), 2);
  if (v_r ->> 'principal')::integer <> 16916 or (v_r ->> 'interest')::integer <> 2138 or (v_r ->> 'outstanding')::integer <> 216322 then
    raise exception 'FAIL D: EMI 2 %', v_r;
  end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 216322 then raise exception 'FAIL D: Balance Sheet'; end if;
end $$;

-- E. Un-reconcile EMI 2 through the bank page's path.
do $$
begin
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000232302', false);
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000232302') is not null then
    raise exception 'FAIL E: line still matched';
  end if;
  if exists (select 1 from public.emi_payments where bank_txn_id = '22222222-0000-0000-0000-000000232302') then raise exception 'FAIL E: payment left'; end if;
  if (select count(*) from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000232301' and category = 'Interest') <> 1 then
    raise exception 'FAIL E: EMI 2 interest left behind';
  end if;
  if (select emi_payment_id from public.emi_schedule where purchase_id = (select v from r2323_ids where k = 'bike') and seq = 2) is not null then
    raise exception 'FAIL E: EMI 2 still paid';
  end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 233238 then raise exception 'FAIL E: Balance Sheet'; end if;
  if not exists (select 1 from public.emi_matches_for_bank_txn('22222222-0000-0000-0000-000000232302') m where m.seq = 2 and m.confidence = 'exact') then
    raise exception 'FAIL E: EMI 2 not suggested again';
  end if;
end $$;

-- G. Money came into the bank: one money-in line, matched to the loan, not un-matchable.
do $$
declare v_r jsonb; v_cash_before bigint; v_p public.emi_purchases; v_line public.bank_transactions;
begin
  v_cash_before := (select cash_and_bank from public.report_balance_sheet('2026-12-31'));
  v_r := public.record_emi_loan_taken(jsonb_build_object('lender','Tata Capital','principal',100000,'interest_rate',12,
    'account_id','bbbbbbbb-0000-0000-0000-000000232301','received_on','2026-09-01','reconcile_txn_id',null,
    'schedule',(select t from r2323_sched)));
  select * into v_p from public.emi_purchases where id = (v_r ->> 'purchase_id')::uuid;
  select * into v_line from public.bank_transactions where id = v_p.received_bank_txn_id;
  if v_line.credit <> 100000 or v_line.debit <> 0 or v_line.source <> 'manual' or v_line.txn_date <> '2026-09-01'
     or v_line.matched_to_type <> 'emi' or v_line.bank_account_id <> 'bbbbbbbb-0000-0000-0000-000000232301' then
    raise exception 'FAIL G: money-in line %', row_to_json(v_line);
  end if;
  if v_p.purchased_on <> '2026-09-01' then raise exception 'FAIL G: loan date %', v_p.purchased_on; end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) <> v_cash_before + 100000 then raise exception 'FAIL G: cash not up'; end if;
  if (select emi_loans_payable from public.report_balance_sheet('2026-12-31')) <> 333238 then raise exception 'FAIL G: loans'; end if;
  if (select emi_unregistered_cost from public.report_balance_sheet('2026-12-31')) <> 0 then raise exception 'FAIL G: counted as an asset'; end if;
  begin
    perform public.unreconcile_bank_receipt(v_line.id, false);
    raise exception 'FAIL G: the loan''s money-in line was un-matched';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

select 'R-2323 emi loan set-up: ALL PASS' as result;

rollback;
