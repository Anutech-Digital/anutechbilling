-- R-2921 (18 Nov 2026): three follow-ups from the review of R-2920 (one bank line → receipts on two
-- or more loans given). Migration 20261118165842_r2921_loan_split_followups (on R-2570's
-- bank_line_bookings and R-2920's tg_loan_given_line_unmatched).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The owner's line: +₹3,50,000 from a borrower = ₹3,49,000 on his big loan + his separate ₹1,000 loan.
--
-- Proves:
--   A. Banking list (bank_line_bookings): the split line is ONE row with the WHOLE ₹3,50,000 and the
--      borrower — never ₹1,000 or ₹3,49,000 (was: one of the two receipts, whichever came first).
--   B. A line split across loans of TWO borrowers names both (A–Z), with the whole amount.
--   C. A line on one loan (the one-loan RPC) reads as before: its amount, its borrower.
--   B2. More than three borrowers on one line → the first two (A–Z) + "+N more".
--   D. Undo refused while a later receipt is on the books: the message NAMES the loan that blocks it
--      (borrower, amount lent, day given — not the other borrower on the line) and keeps the words
--      "later receipt(s) of this loan are on the books"; nothing is removed.
--   D2. Two loans of the SAME borrower on the line: the message tells them apart (₹1,000, 05 Jan 2026).
--   E. The undo trigger locks the line's loans (for update, in id order) BEFORE the later-receipt check.
--   F. After the later receipt is undone, the split line un-reconciles fully (R-2920 behaviour kept).

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
  ('dddddddd-0000-0000-0000-000000292101','R2921 Co','r2921@example.in','07','R2921');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000292101','owner2921@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000292101','dddddddd-0000-0000-0000-000000292101','owner2921@example.in','Owner 2921','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000292101','dddddddd-0000-0000-0000-000000292101','HDFC Current','HDFC', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000292101','dddddddd-0000-0000-0000-000000292101','bbbbbbbb-0000-0000-0000-000000292101','2026-02-21','NEFT CR KAPIL DEV',0,350000,'K1','csv_upload'),
  ('22222222-0000-0000-0000-000000292102','dddddddd-0000-0000-0000-000000292101','bbbbbbbb-0000-0000-0000-000000292101','2026-02-13','NEFT CR RAHUL AND ASHA',0,16000,'R1','csv_upload'),
  ('22222222-0000-0000-0000-000000292103','dddddddd-0000-0000-0000-000000292101','bbbbbbbb-0000-0000-0000-000000292101','2026-02-15','NEFT CR SUMAN RANI',0,2500,'S1','csv_upload'),
  ('22222222-0000-0000-0000-000000292104','dddddddd-0000-0000-0000-000000292101','bbbbbbbb-0000-0000-0000-000000292101','2026-03-13','NEFT CR RAHUL CHAWLA',0,5000,'R2','csv_upload'),
  ('22222222-0000-0000-0000-000000292105','dddddddd-0000-0000-0000-000000292101','bbbbbbbb-0000-0000-0000-000000292101','2026-02-20','CASH DEPOSIT FOUR PEOPLE',0,4000,'F1','csv_upload');
insert into public.loans_given (id, tenant_id, borrower_name, borrower_type, principal, given_on, interest_rate, repayment_plan, due_on, instalments, emi_amount, status, closed_on) values
  ('11111111-0000-0000-0000-000000292101','dddddddd-0000-0000-0000-000000292101','Kapil Dev','person',349000,'2025-12-15',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292102','dddddddd-0000-0000-0000-000000292101','Kapil Dev','person',1000,'2026-01-05',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292103','dddddddd-0000-0000-0000-000000292101','Rahul Chawla','person',100000,'2026-01-13',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292104','dddddddd-0000-0000-0000-000000292101','Asha Verma','person',50000,'2026-01-01',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292105','dddddddd-0000-0000-0000-000000292101','Suman Rani','person',20000,'2026-01-01',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292106','dddddddd-0000-0000-0000-000000292101','Zoya Khan','person',9000,'2026-01-02',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292107','dddddddd-0000-0000-0000-000000292101','Bina Das','person',9000,'2026-01-02',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292108','dddddddd-0000-0000-0000-000000292101','Mohan Lal','person',9000,'2026-01-02',0,'one_shot',null,null,null,'open',null),
  ('11111111-0000-0000-0000-000000292109','dddddddd-0000-0000-0000-000000292101','Charu Jain','person',9000,'2026-01-02',0,'one_shot',null,null,null,'open',null);

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000292101","role":"authenticated"}', true);

-- The ₹1,000 loan FIRST in the parts, so the line is matched to the ₹1,000 receipt.
select public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292101',
  '[{"loan_id":"11111111-0000-0000-0000-000000292102","amount":1000},{"loan_id":"11111111-0000-0000-0000-000000292101","amount":349000}]');
select public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292102',
  '[{"loan_id":"11111111-0000-0000-0000-000000292103","amount":10000},{"loan_id":"11111111-0000-0000-0000-000000292104","amount":6000}]');
select public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000292103', '11111111-0000-0000-0000-000000292105', 0);
select public.reconcile_bank_credit_to_loans_given('22222222-0000-0000-0000-000000292105',
  '[{"loan_id":"11111111-0000-0000-0000-000000292106","amount":1000},{"loan_id":"11111111-0000-0000-0000-000000292107","amount":1000},{"loan_id":"11111111-0000-0000-0000-000000292108","amount":1000},{"loan_id":"11111111-0000-0000-0000-000000292109","amount":1000}]');

-- ── A, B, C. What the Banking list reads ─────────────────────────────────────────────────
do $$
declare
  r record;
  v_acct constant uuid := 'bbbbbbbb-0000-0000-0000-000000292101';
begin
  if (select count(*) from public.bank_line_bookings(v_acct)) <> 4 then
    raise exception 'FAIL A: % rows for 4 booked lines', (select count(*) from public.bank_line_bookings(v_acct));
  end if;

  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = '22222222-0000-0000-0000-000000292105';
  if r.amount is distinct from 4000 or r.party is distinct from 'Bina Das, Charu Jain +2 more' then
    raise exception 'FAIL B2: the four-borrower line reads %', row_to_json(r);
  end if;

  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = '22222222-0000-0000-0000-000000292101';
  if r.source is distinct from 'loan_given_repayment' or r.amount is distinct from 350000 or r.party is distinct from 'Kapil Dev' then
    raise exception 'FAIL A: the ₹3,50,000 split line reads %', row_to_json(r);
  end if;

  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = '22222222-0000-0000-0000-000000292102';
  if r.source is distinct from 'loan_given_repayment' or r.amount is distinct from 16000
     or r.party is distinct from 'Asha Verma, Rahul Chawla' or r.sub is distinct from 'bank' then
    raise exception 'FAIL B: the two-borrower line reads %', row_to_json(r);
  end if;

  select * into r from public.bank_line_bookings(v_acct) b where b.txn_id = '22222222-0000-0000-0000-000000292103';
  if r.source is distinct from 'loan_given_repayment' or r.amount is distinct from 2500
     or r.party is distinct from 'Suman Rani' or r.sub is distinct from 'bank' then
    raise exception 'FAIL C: the one-loan line reads %', row_to_json(r);
  end if;
end $$;

-- ── D. Undo refused: the borrower is named ───────────────────────────────────────────────
do $$
begin
  -- a later receipt (13 Mar) on Rahul Chawla's loan
  perform public.reconcile_bank_credit_to_loan_given('22222222-0000-0000-0000-000000292104', '11111111-0000-0000-0000-000000292103', 0);
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292102', false);
    raise exception 'FAIL D: split line undone under a later receipt';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Loan to Rahul Chawla (₹100000, given 13 Jan 2026): 1 later receipt(s) of this loan are on the books%undo the latest receipt first%' then
      raise exception 'FAIL D: the refusal does not name the borrower: %', sqlerrm;
    end if;
    if sqlerrm like '%Asha Verma%' then raise exception 'FAIL D: the refusal names the wrong borrower: %', sqlerrm; end if;
  end;
  if (select count(*) from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292102') <> 2
     or (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000292102') is distinct from 'loan_given' then
    raise exception 'FAIL D: a refused undo removed something';
  end if;
end $$;

-- ── D2. Two loans of one borrower: the message says which ───────────────────────────────
do $$
begin
  -- a later receipt (13 Mar) on Kapil Dev's ₹1,000 loan (planted: the loan is closed, so no RPC takes it)
  insert into public.loan_repayments (tenant_id, loan_id, repaid_on, amount, principal_part, interest_part, mode)
  values ('dddddddd-0000-0000-0000-000000292101', '11111111-0000-0000-0000-000000292102', '2026-03-13', 1, 0, 1, 'cash');
  begin
    perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292101', false);
    raise exception 'FAIL D2: split line undone under a later receipt';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Loan to Kapil Dev (₹1000, given 05 Jan 2026): 1 later receipt(s) of this loan are on the books%' then
      raise exception 'FAIL D2: the refusal does not say which Kapil Dev loan: %', sqlerrm;
    end if;
  end;
  delete from public.loan_repayments where loan_id = '11111111-0000-0000-0000-000000292102' and repaid_on = '2026-03-13';
end $$;

-- ── E. The loans are locked before the later-receipt check ───────────────────────────────
do $$
declare
  v_src text := (select prosrc from pg_proc where oid = to_regprocedure('public.tg_loan_given_line_unmatched()'));
  v_lock integer := (regexp_instr(v_src, 'from public\.loans_given g\s+where g\.id in \(select r\.loan_id from public\.loan_repayments r where r\.bank_txn_id = old\.id\)\s+order by g\.id\s+for update'));
  v_check integer := strpos(v_src, 'r.repaid_on > v_rep.repaid_on');
begin
  if v_check = 0 then raise exception 'FAIL E: the later-receipt check is gone from the trigger'; end if;
  if v_lock = 0 then raise exception 'FAIL E: the undo trigger does not lock the line''s loans (order by id for update)'; end if;
  if v_lock > v_check then raise exception 'FAIL E: the loans are locked AFTER the later-receipt check'; end if;
end $$;

-- ── F. Undo still works once the later receipt is gone ───────────────────────────────────
do $$
begin
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292104', false);
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292102', false);
  if exists (select 1 from public.loan_repayments where bank_txn_id = '22222222-0000-0000-0000-000000292102')
     or (select matched_to_type from public.bank_transactions where id = '22222222-0000-0000-0000-000000292102') is not null then
    raise exception 'FAIL F: the split line is not fully undone';
  end if;
  if exists (select 1 from public.bank_line_bookings('bbbbbbbb-0000-0000-0000-000000292101') b where b.txn_id = '22222222-0000-0000-0000-000000292102') then
    raise exception 'FAIL F: an un-reconciled line still reads as booked';
  end if;
  perform public.unreconcile_bank_receipt('22222222-0000-0000-0000-000000292101', false);
  if (select count(*) from public.loans_given where id in ('11111111-0000-0000-0000-000000292101','11111111-0000-0000-0000-000000292102')
        and status = 'open' and closed_on is null) <> 2 then
    raise exception 'FAIL F: both loans are not open again';
  end if;
end $$;

select 'R-2921 loan split follow-ups: ALL PASS' as result;

rollback;
