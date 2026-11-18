-- R-2920 (18 Nov 2026): one money-in bank line → receipts on TWO OR MORE loans given
-- (reconcile_bank_credit_to_loans_given), and Un-reconcile of that line removes all of them.
-- Migration 20261118102112_r2920_loan_receipt_split (on R-544 loans_given, R-2340 receipt + undo
-- trigger, R-2346, R-2570).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The owner's line: +₹3,50,000 on 21 Feb 2026 from a borrower with ₹3,49,000 left on a ₹9,99,000
-- loan and a separate ₹1,000 loan.
--
-- Proves:
--   A. A sales user is refused.
--   B. Refusals write NOTHING: parts ≠ the line, a part over what the loan owes (also when an earlier
--      part was fine), the same loan twice, a ₹0 part, no parts, another company's loan, a closed
--      loan, a line before the loan was given, another company's line.
--   C. ₹3,49,000 + ₹1,000 → two receipts on the ONE line, both loans closed on the line's date, line
--      matched once ('loan_given' → the first receipt), no new bank line, no interest income, asset
--      down by ₹3,50,000.
--   C2. Interest: an EMI part (interest worked out here) + a 10% one-shot part (interest handed in)
--      → ONE other_incomes row for the line with both interests.
--   D. The same line again (repeat click) → refused.
--   E. Undo is all-or-nothing: refused while a later receipt of one of the loans is on the books —
--      both receipts and the interest income stay.
--   F. Undo: Un-reconcile removes every receipt of the line and its interest income, re-opens the
--      loans, frees the line; an earlier receipt of the same loan on another line stays.

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
  ('dddddddd-0000-0000-0000-000000292001','R2920 Co','r2920@example.in','07','R2920'),
  ('dddddddd-0000-0000-0000-000000292002','R2920 Other','r2920b@example.in','07','R2920B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000292001','owner2920@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000292002','sales2920@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292001','owner2920@example.in','Owner 2920','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000292002','dddddddd-0000-0000-0000-000000292001','sales2920@example.in','Sales 2920','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292001','HDFC Current','HDFC', 0),
  ('bbbbbbbb-0000-0000-0000-000000292002','dddddddd-0000-0000-0000-000000292002','Other bank','SBI', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292001','bbbbbbbb-0000-0000-0000-000000292001','2026-01-10','NEFT CR KAPIL DEV',0,650000,'K0','csv_upload'),
  ('22222222-0000-0000-0000-000000292002','dddddddd-0000-0000-0000-000000292001','bbbbbbbb-0000-0000-0000-000000292001','2026-02-21','NEFT CR KAPIL DEV',0,350000,'K1','csv_upload'),
  ('22222222-0000-0000-0000-000000292003','dddddddd-0000-0000-0000-000000292001','bbbbbbbb-0000-0000-0000-000000292001','2026-02-13','NEFT CR RAHUL CHAWLA',0,16200,'R1','csv_upload'),
  ('22222222-0000-0000-0000-000000292004','dddddddd-0000-0000-0000-000000292002','bbbbbbbb-0000-0000-0000-000000292002','2026-02-21','NEFT CR OTHER',0,1000,'Z1','csv_upload'),
  ('22222222-0000-0000-0000-000000292005','dddddddd-0000-0000-0000-000000292001','bbbbbbbb-0000-0000-0000-000000292001','2026-03-13','NEFT CR RAHUL CHAWLA',0,5000,'R2','csv_upload'),
  ('22222222-0000-0000-0000-000000292006','dddddddd-0000-0000-0000-000000292001','bbbbbbbb-0000-0000-0000-000000292001','2025-12-01','NEFT CR EARLY',0,1000,'E1','csv_upload');
insert into public.loans_given (id, tenant_id, borrower_name, borrower_type, principal, given_on, interest_rate, repayment_plan, due_on, instalments, emi_amount, status, closed_on) values
  ('11111111-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292001','Kapil Dev','person',999000,'2025-12-15',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292002','dddddddd-0000-0000-0000-000000292001','Kapil Dev','person',1000,'2026-01-05',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292003','dddddddd-0000-0000-0000-000000292001','Rahul Chawla','person',100000,'2026-01-13',12,'emi','2026-02-13',12,10000,'open',null),
  ('11111111-0000-0000-0000-000000292004','dddddddd-0000-0000-0000-000000292001','Rahul Chawla','person',50000,'2026-01-01',10,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292005','dddddddd-0000-0000-0000-000000292002','Other Borrower','person',5000,'2026-01-01',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292006','dddddddd-0000-0000-0000-000000292001','Old Closed','person',1000,'2025-06-01',0,'one_shot',null,null,null,'closed','2025-07-01');

create temp table r2920_n (k text primary key, v bigint);
grant all on r2920_n to public;

-- ── A. Sales user ────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000292002","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292002',
      '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":1000}]');
    raise exception 'FAIL A (sales): accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL A (sales): wrong refusal: %', sqlerrm; end if;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000292001","role":"authenticated"}', true);

-- The big loan already had ₹6,50,000 back on an earlier line (the one-loan RPC, unchanged) → ₹3,49,000 left.
select public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000292001', '11111111-0000-0000-0000-000000292001', 0);
insert into r2920_n values ('asset0', public.loans_given_asset());

-- ── B. Refusals, nothing written ─────────────────────────────────────────────────────────
do $$
declare v_case record;
begin
  for v_case in
    select * from (values
      ('parts less than the line', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":500}]'::jsonb,
        'The parts add up to ₹349500 but this line is ₹350000%'),
      ('parts more than the line', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":1001}]'::jsonb,
        'The parts add up to ₹350001 but this line is ₹350000%'),
      ('one loan, over what it owes', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":350000}]'::jsonb,
        'For Kapil Dev, ₹350000 is more than is owed: ₹349000 of the loan is left%'),
      ('second part over, first fine', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":348000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":2000}]'::jsonb,
        'For Kapil Dev, ₹2000 is more than is owed: ₹1000 of the loan is left%'),
      ('same loan twice', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292001","amount":1000}]'::jsonb,
        'The same loan is ticked twice%'),
      ('a zero part', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":350000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":0}]'::jsonb,
        'Enter a whole-rupee amount%'),
      ('a negative part', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":351000},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":-1000}]'::jsonb,
        'Enter a whole-rupee amount%'),
      ('no parts', '22222222-0000-0000-0000-000000292002'::uuid, '[]'::jsonb, 'Tick at least one loan%'),
      ('another company''s loan', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292005","amount":1000}]'::jsonb,
        'Loan not found in your company%'),
      ('a closed loan', '22222222-0000-0000-0000-000000292002'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000},{"loan_id":"11111111-0000-0000-0000-000000292006","amount":1000}]'::jsonb,
        'The loan to Old Closed is already fully repaid and closed%'),
      ('line before the loan was given', '22222222-0000-0000-0000-000000292006'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292002","amount":1000}]'::jsonb,
        'This line (01 Dec 2025) is before the loan to Kapil Dev was given%'),
      ('another company''s line', '22222222-0000-0000-0000-000000292004'::uuid,
        '[{"loan_id":"11111111-0000-0000-0000-000000292002","amount":1000}]'::jsonb,
        'Bank line not found in your company%')
    ) as c(name, txn, parts, msg)
  loop
    begin
      perform public.reconcile_bank_credit_to_loans_given(v_case.txn, v_case.parts);
      raise exception 'FAIL B (%): accepted', v_case.name;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL B (%): wrong refusal: %', v_case.name, sqlerrm; end if;
    end;
  end loop;
  if (select count(*) from public.loan_repayments where tenant_id in ('dddddddd-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292002')) <> 1 then
    raise exception 'FAIL B: a refused call left a receipt behind';
  end if;
  if exists (select 1 from public.bank_transactions where tenant_id in ('dddddddd-0000-0000-0000-000000292001','dddddddd-0000-0000-0000-000000292002')
              and id <> '22222222-0000-0000-0000-000000292001' and matched_to_type is not null) then
    raise exception 'FAIL B: a refused call matched a line';
  end if;
  if exists (select 1 from public.loans_given where id in ('11111111-0000-0000-0000-000000292001','11111111-0000-0000-0000-000000292002') and status <> 'open') then
    raise exception 'FAIL B: a refused call closed a loan';
  end if;
  if public.loans_given_asset() <> (select v from r2920_n where k = 'asset0') then raise exception 'FAIL B: asset moved'; end if;
end $$;

-- ── C. ₹3,50,000 → ₹3,49,000 + ₹1,000 on the two loans ───────────────────────────────────
do $$
declare
  v_res jsonb; v_t public.bank_transactions; v_first uuid;
begin
  v_res := public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292002',
    '[{"loan_id":"11111111-0000-0000-0000-000000292001","amount":349000,"interest_part":0},{"loan_id":"11111111-0000-0000-0000-000000292002","amount":1000,"interest_part":null}]');
  if (v_res ->> 'loans')::int <> 2 or (v_res ->> 'principal')::int <> 350000 or (v_res ->> 'interest')::int <> 0
     or jsonb_array_length(v_res -> 'receipts') <> 2
     or (v_res -> 'receipts' -> 0 ->> 'seq')::int <> 2 or (v_res -> 'receipts' -> 1 ->> 'seq')::int <> 1
     or not (v_res -> 'receipts' -> 0 ->> 'closes')::boolean or not (v_res -> 'receipts' -> 1 ->> 'closes')::boolean then
    raise exception 'FAIL C: wrong result: %', v_res;
  end if;
  if (select count(*) from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292002') <> 2 then
    raise exception 'FAIL C: not two receipts on the line';
  end if;
  if not exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292002'
                  and loan_id = '11111111-0000-0000-0000-000000292001' and amount = 349000 and principal_part = 349000 and interest_part = 0 and repaid_on = '2026-02-21')
     or not exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292002'
                  and loan_id = '11111111-0000-0000-0000-000000292002' and amount = 1000 and principal_part = 1000 and interest_part = 0 and repaid_on = '2026-02-21') then
    raise exception 'FAIL C: wrong receipt rows';
  end if;
  if (select count(*) from public.loans_given where id in ('11111111-0000-0000-0000-000000292001','11111111-0000-0000-0000-000000292002')
        and status = 'closed' and closed_on = '2026-02-21') <> 2 then
    raise exception 'FAIL C: both loans are not closed on the line''s date';
  end if;
  v_first := (v_res -> 'receipts' -> 0 ->> 'repayment_id')::uuid;
  select * into v_t from public.bank_transactions where id = '22222222-0000-0000-0000-000000292002';
  if v_t.matched_to_type is distinct from 'loan_given' or v_t.matched_to_id is distinct from v_first::text then
    raise exception 'FAIL C: line not matched to the first receipt: % %', v_t.matched_to_type, v_t.matched_to_id;
  end if;
  if exists (select 1 from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292002') then
    raise exception 'FAIL C: interest income booked on interest-free loans';
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000292001') <> 5 then
    raise exception 'FAIL C: a new bank line was added';
  end if;
  if public.loans_given_asset() <> (select v from r2920_n where k = 'asset0') - 350000 then
    raise exception 'FAIL C: asset % not down by 350000 from %', public.loans_given_asset(), (select v from r2920_n where k = 'asset0');
  end if;
end $$;

-- ── C2. Interest: EMI part + 10% one-shot part → ONE interest row for the line ────────────
do $$
declare v_res jsonb;
begin
  v_res := public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292003',
    '[{"loan_id":"11111111-0000-0000-0000-000000292003","amount":10000},{"loan_id":"11111111-0000-0000-0000-000000292004","amount":6200,"interest_part":200}]');
  -- EMI: interest = round(1,00,000 × 12 / 1200) = ₹1,000, whatever the browser sends.
  if not exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292003'
                  and loan_id = '11111111-0000-0000-0000-000000292003' and amount = 10000 and principal_part = 9000 and interest_part = 1000)
     or not exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292003'
                  and loan_id = '11111111-0000-0000-0000-000000292004' and amount = 6200 and principal_part = 6000 and interest_part = 200) then
    raise exception 'FAIL C2: wrong split: %', v_res;
  end if;
  if (select count(*) from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292003') <> 1
     or (select amount from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292003') <> 1200
     or (select head from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292003') <> 'interest' then
    raise exception 'FAIL C2: interest income is not one ₹1,200 row';
  end if;
  if (v_res ->> 'interest')::int <> 1200 or (v_res ->> 'principal')::int <> 15000 then raise exception 'FAIL C2: wrong totals: %', v_res; end if;
  if (select count(*) from public.loans_given where id in ('11111111-0000-0000-0000-000000292003','11111111-0000-0000-0000-000000292004') and status = 'open') <> 2 then
    raise exception 'FAIL C2: a part-repaid loan closed';
  end if;
end $$;

-- ── D. Repeat click ──────────────────────────────────────────────────────────────────────
do $$
begin
  begin
    perform public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292002',
      '[{"loan_id":"11111111-0000-0000-0000-000000292003","amount":350000}]');
    raise exception 'FAIL D: accepted twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'This line is already reconciled%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- ── E. Undo is all-or-nothing ────────────────────────────────────────────────────────────
do $$
begin
  -- a later receipt (13 Mar) on the EMI loan, by the one-loan RPC
  perform public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000292005', '11111111-0000-0000-0000-000000292003', null);
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292003', false);
    raise exception 'FAIL E: split line undone under a later receipt';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%later receipt(s) of this loan are on the books%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if (select count(*) from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292003') <> 2
     or (select count(*) from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292003') <> 1
     or (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000292003') is distinct from 'loan_given' then
    raise exception 'FAIL E: a refused undo removed something';
  end if;
end $$;

-- ── F. Undo ──────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292005', false);
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292003', false);
  if exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292003')
     or exists (select 1 from public.other_incomes where bank_txn_id = '22222222-0000-0000-0000-000000292003')
     or (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000292003') is not null then
    raise exception 'FAIL F: interest split line not fully undone';
  end if;

  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292002', false);
  if exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292002') then
    raise exception 'FAIL F: a receipt of the split line is still there';
  end if;
  if (select count(*) from public.loans_given where id in ('11111111-0000-0000-0000-000000292001','11111111-0000-0000-0000-000000292002')
        and status = 'open' and closed_on is null) <> 2 then
    raise exception 'FAIL F: both loans are not open again';
  end if;
  if (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000292002') is not null then
    raise exception 'FAIL F: line not freed';
  end if;
  -- the earlier ₹6,50,000 receipt (another line) is untouched
  if (select count(*) from public.loan_repayments where loan_id = '11111111-0000-0000-0000-000000292001' and amount = 650000) <> 1 then
    raise exception 'FAIL F: the earlier receipt was removed too';
  end if;
  if public.loans_given_asset() <> (select v from r2920_n where k = 'asset0') then
    raise exception 'FAIL F: asset % not back to %', public.loans_given_asset(), (select v from r2920_n where k = 'asset0');
  end if;
  if (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000292001') <> 5 then
    raise exception 'FAIL F: a statement line was deleted';
  end if;
end $$;

select 'R-2920 loan receipt split: ALL PASS' as result;

rollback;
