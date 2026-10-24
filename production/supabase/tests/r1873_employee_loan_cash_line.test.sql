-- R-1873 — a deleted employee loan/advance takes its cash line with it, so every reader agrees
-- (migration 20261024200000_r1873_employee_loan_cash_line.sql).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1873_employee_loan_cash_line.test.sql
--
-- Pardeep's steps (staging, 24 Oct): ₹2,000 to Prashant from Petty Cash, twice; delete one.
-- The readers, each read the way its screen reads it:
--   Payments Made  = money-out (debit) lines of the account, transfers left out (queries/payments-made.ts)
--   Petty Cash     = opening balance + credits − debits of the account
--   Loans register = employee_loans rows (principal − repayments)
--   Balance Sheet  = report_balance_sheet(): employee_loans and cash_and_bank
-- What it proves:
--   1. give ×2, delete one → Payments Made 1 row of ₹2,000; Petty Cash −₹2,000; register 1 loan
--      of ₹2,000; Balance Sheet employee loans ₹2,000 and cash −₹2,000 — and no "Correction" line.
--   2. The loan stores its line (bank_txn_id) and that line is ₹2,000 out of Petty Cash.
--   3. Edit ₹2,000 → ₹2,500 and Petty Cash → Bank: the same line changes; still 1 row; readers agree.
--   4. The line cannot be deleted / changed on its own (guard) — refused with the next step.
--   5. A line re-booked on Banking as something else → loan delete refused with the next step
--      (hint = the line on Banking); nothing changes.
--   6. A loan made the old way (no bank_txn_id) → delete removes its own line, no correction.
--   7. Another company's owner cannot delete it; a sales user is refused (42501).
--   8. MUTATION CHECK: with the pre-R-1873 delete body, step 1 goes RED (2 rows in Payments Made).
--   9. Old orphans (Pardeep's staging data): the owner — and only the owner, only his company —
--      sees exactly the left-over payout + correction pair; a reconciled line is not offered and
--      its removal is refused; removing the pair leaves the balance unchanged and Payments Made =
--      register. MUTATION CHECK 9g: without the "an old loan still needs this payout" limit, a
--      needed payout is offered.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1873000-0000-0000-0000-0000000000a1'::uuid, 'T-R1873 A', 'r1873-a@example.in', '07', 'TRA'),
  ('c1873000-0000-0000-0000-0000000000b1'::uuid, 'T-R1873 B', 'r1873-b@example.in', '07', 'TRB');

insert into auth.users (id, email) values
  ('c1873000-0000-0000-0000-00000000a0a1', 'r1873-owner-a@example.test'),
  ('c1873000-0000-0000-0000-00000000a0a2', 'r1873-sales-a@example.test'),
  ('c1873000-0000-0000-0000-00000000b0b1', 'r1873-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1873000-0000-0000-0000-00000000a0a1', 'c1873000-0000-0000-0000-0000000000a1', 'r1873-owner-a@example.in', 'owner', 'Owner A'),
  ('c1873000-0000-0000-0000-00000000a0a2', 'c1873000-0000-0000-0000-0000000000a1', 'r1873-sales-a@example.in', 'sales', 'Sales A'),
  ('c1873000-0000-0000-0000-00000000b0b1', 'c1873000-0000-0000-0000-0000000000b1', 'r1873-owner-b@example.in', 'owner', 'Owner B');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, is_active) values
  ('c1873000-0000-0000-0000-0000000ca5a1', 'c1873000-0000-0000-0000-0000000000a1', 'Petty Cash', 'Cash', 'cash', 0, true),
  ('c1873000-0000-0000-0000-0000000ba4a1', 'c1873000-0000-0000-0000-0000000000a1', 'T-Bank', 'T-Bank', 'current', 0, true);

-- The readers, as their screens read them.
create function pg_temp.paid_rows(p_acct uuid) returns int language sql as $f$
  select count(*)::int from public.bank_transactions
   where bank_account_id = p_acct and debit > 0 and matched_to_type is distinct from 'transfer' $f$;
create function pg_temp.paid_sum(p_acct uuid) returns bigint language sql as $f$
  select coalesce(sum(debit), 0)::bigint from public.bank_transactions
   where bank_account_id = p_acct and debit > 0 and matched_to_type is distinct from 'transfer' $f$;
create function pg_temp.balance(p_acct uuid) returns bigint language sql as $f$
  select (select coalesce(opening_balance, 0) from public.bank_accounts where id = p_acct)
       + coalesce((select sum(credit - debit) from public.bank_transactions where bank_account_id = p_acct), 0) $f$;
create function pg_temp.register(p_tenant uuid) returns bigint language sql as $f$
  select coalesce(sum(principal), 0)::bigint from public.employee_loans where tenant_id = p_tenant $f$;

grant execute on function pg_temp.paid_rows(uuid), pg_temp.paid_sum(uuid), pg_temp.balance(uuid), pg_temp.register(uuid) to authenticated;

set local role authenticated;

do $$
declare
  c_pc   constant uuid := 'c1873000-0000-0000-0000-0000000ca5a1';
  c_bank constant uuid := 'c1873000-0000-0000-0000-0000000ba4a1';
  c_a    constant uuid := 'c1873000-0000-0000-0000-0000000000a1';
  v_l1 uuid; v_l2 uuid; v_line uuid; v_n int; v_ok boolean; v_bs record; v_hint text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

  -- 1. Pardeep's steps
  v_l1 := public.disburse_employee_loan('Prashant', 2000, '2026-10-24', c_pc, 'loan', null);
  v_l2 := public.disburse_employee_loan('Prashant', 2000, '2026-10-24', c_pc, 'loan', null);
  if pg_temp.paid_rows(c_pc) <> 2 or pg_temp.balance(c_pc) <> -4000 then
    raise exception 'FAIL 1a: after two gives Payments Made % rows, Petty Cash %', pg_temp.paid_rows(c_pc), pg_temp.balance(c_pc);
  end if;

  perform public.delete_employee_loan(v_l2);

  if pg_temp.paid_rows(c_pc) <> 1 then
    raise exception 'FAIL 1b: Payments Made lists % rows after deleting one of two loans (expected 1)', pg_temp.paid_rows(c_pc);
  end if;
  if pg_temp.paid_sum(c_pc) <> 2000 then raise exception 'FAIL 1c: Payments Made total % (expected 2000)', pg_temp.paid_sum(c_pc); end if;
  if pg_temp.balance(c_pc) <> -2000 then raise exception 'FAIL 1d: Petty Cash % (expected -2000)', pg_temp.balance(c_pc); end if;
  if pg_temp.register(c_a) <> 2000 then raise exception 'FAIL 1e: register % (expected 2000)', pg_temp.register(c_a); end if;
  select * into v_bs from public.report_balance_sheet('2026-10-31');
  if v_bs.employee_loans <> 2000 then raise exception 'FAIL 1f: Balance Sheet employee loans % (expected 2000)', v_bs.employee_loans; end if;
  if v_bs.cash_and_bank <> -2000 then raise exception 'FAIL 1g: Balance Sheet cash % (expected -2000)', v_bs.cash_and_bank; end if;
  -- every reader agrees: money out = loans outstanding = −cash
  if not (pg_temp.paid_sum(c_pc) = pg_temp.register(c_a) and pg_temp.register(c_a) = v_bs.employee_loans
          and -pg_temp.balance(c_pc) = v_bs.employee_loans) then
    raise exception 'FAIL 1h: readers disagree';
  end if;
  select count(*) into v_n from public.bank_transactions where tenant_id = c_a and description like 'Correction:%';
  if v_n <> 0 then raise exception 'FAIL 1i: % correction line(s) written', v_n; end if;

  -- 2. the link
  select bank_txn_id into v_line from public.employee_loans where id = v_l1;
  select count(*) into v_n from public.bank_transactions where id = v_line and bank_account_id = c_pc and debit = 2000;
  if v_n <> 1 then raise exception 'FAIL 2: loan not linked to its ₹2,000 Petty Cash line'; end if;

  -- 3. edit amount and account → same line changes
  perform public.edit_employee_loan(v_l1, 'Prashant', 2500, '2026-10-24', c_bank, 'loan', null);
  if pg_temp.paid_rows(c_pc) <> 0 or pg_temp.paid_rows(c_bank) <> 1 or pg_temp.paid_sum(c_bank) <> 2500 then
    raise exception 'FAIL 3a: after edit Petty Cash % rows, Bank % rows / %', pg_temp.paid_rows(c_pc), pg_temp.paid_rows(c_bank), pg_temp.paid_sum(c_bank);
  end if;
  if pg_temp.balance(c_pc) <> 0 or pg_temp.balance(c_bank) <> -2500 then raise exception 'FAIL 3b: balances % / %', pg_temp.balance(c_pc), pg_temp.balance(c_bank); end if;
  select count(*) into v_n from public.employee_loans where id = v_l1 and bank_txn_id = v_line;
  if v_n <> 1 then raise exception 'FAIL 3c: edit changed the link'; end if;
  select * into v_bs from public.report_balance_sheet('2026-10-31');
  if v_bs.employee_loans <> 2500 or v_bs.cash_and_bank <> -2500 then raise exception 'FAIL 3d: BS % / %', v_bs.employee_loans, v_bs.cash_and_bank; end if;

  -- 4. the line alone cannot be deleted or changed
  v_ok := false;
  begin delete from public.bank_transactions where id = v_line;
  exception when foreign_key_violation then v_ok := sqlerrm like '%Prashant%';
  end;
  if not v_ok then raise exception 'FAIL 4a: the loan''s line could be deleted on its own'; end if;
  v_ok := false;
  begin update public.bank_transactions set debit = 100 where id = v_line;
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL 4b: the loan''s line amount could be changed on its own'; end if;

  -- 5. re-booked on Banking → delete refused with the next step
  update public.bank_transactions set matched_to_type = 'expense', matched_to_id = 'x' where id = v_line;
  v_ok := false;
  begin perform public.delete_employee_loan(v_l1);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_ok := sqlerrm like '%booked as "expense"%' and v_hint like '/accounting/banking/%?focus=' || v_line;
  end;
  if not v_ok then raise exception 'FAIL 5a: delete of a loan whose line was re-booked was not refused with the Banking link'; end if;
  select count(*) into v_n from public.employee_loans where id = v_l1;
  if v_n <> 1 or pg_temp.paid_rows(c_bank) <> 1 then raise exception 'FAIL 5b: refused delete changed something'; end if;
  update public.bank_transactions set matched_to_type = 'manual', matched_to_id = null where id = v_line;

  -- 7. sales user refused; another company cannot delete
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a2', 'role', 'authenticated')::text, true);
  v_ok := false;
  begin perform public.delete_employee_loan(v_l1);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL 7a: sales user could delete a loan'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  v_ok := false;
  begin perform public.delete_employee_loan(v_l1);
  exception when others then v_ok := sqlerrm = 'Loan not found';
  end;
  if not v_ok then raise exception 'FAIL 7b: another company reached the loan'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

  -- delete the edited loan → the bank is back to 0, nothing left anywhere
  perform public.delete_employee_loan(v_l1);
  if pg_temp.paid_rows(c_bank) <> 0 or pg_temp.balance(c_bank) <> 0 or pg_temp.register(c_a) <> 0 then
    raise exception 'FAIL 3e: after deleting the edited loan Bank % rows / %, register %', pg_temp.paid_rows(c_bank), pg_temp.balance(c_bank), pg_temp.register(c_a);
  end if;
end $$;

reset role;

-- 6. a loan made the old way (before R-1873: no bank_txn_id) — its own line goes with it
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind)
values ('c1873000-0000-0000-0000-00000001e9a1', 'c1873000-0000-0000-0000-0000000000a1', 'Ravi', 3000, '2026-10-20', 'c1873000-0000-0000-0000-0000000ca5a1', 'loan');
insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
values ('c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-20', 'Loan/advance to Ravi', 3000, 0, 'manual', 'manual', 'manual');

set local role authenticated;
do $$
declare c_pc constant uuid := 'c1873000-0000-0000-0000-0000000ca5a1'; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  perform public.delete_employee_loan('c1873000-0000-0000-0000-00000001e9a1');
  select count(*) into v_n from public.bank_transactions where bank_account_id = c_pc;
  if v_n <> 0 or pg_temp.balance(c_pc) <> 0 then
    raise exception 'FAIL 6: old-style loan delete left % line(s), Petty Cash %', v_n, pg_temp.balance(c_pc);
  end if;
end $$;
reset role;

-- 9. Pardeep's staging data as it is today (made by the OLD delete): 2 payouts, 1 correction,
--    1 old-style loan. The owner sees exactly one left-over pair and removes it himself; the
--    balance does not move, Payments Made drops to 1 row. Plus one inconsistent key (1 payout,
--    1 correction, 1 old loan that still needs that payout) that must NOT be offered.
insert into public.employee_loans (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind) values
  ('c1873000-0000-0000-0000-0000000000a1', 'Prashant', 2000, '2026-10-24', 'c1873000-0000-0000-0000-0000000ca5a1', 'loan'),
  ('c1873000-0000-0000-0000-0000000000a1', 'Mohan',    700,  '2026-10-22', 'c1873000-0000-0000-0000-0000000ca5a1', 'loan');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence) values
  ('c1873000-0000-0000-0000-00000000d001', 'c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-24', 'Loan/advance to Prashant', 2000, 0, 'manual', 'manual', 'manual'),
  ('c1873000-0000-0000-0000-00000000d002', 'c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-24', 'Loan/advance to Prashant', 2000, 0, 'manual', 'manual', 'manual'),
  ('c1873000-0000-0000-0000-00000000c001', 'c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-24', 'Correction: reversed loan/advance to Prashant', 0, 2000, 'manual', 'manual', 'manual'),
  ('c1873000-0000-0000-0000-00000000d003', 'c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-22', 'Loan/advance to Mohan', 700, 0, 'manual', 'manual', 'manual'),
  ('c1873000-0000-0000-0000-00000000c003', 'c1873000-0000-0000-0000-0000000000a1', 'c1873000-0000-0000-0000-0000000ca5a1', '2026-10-23', 'Correction: reversed loan/advance to Mohan', 0, 700, 'manual', 'manual', 'manual');

set local role authenticated;
do $$
declare c_pc constant uuid := 'c1873000-0000-0000-0000-0000000ca5a1'; v_n int; v_ok boolean; v_bal bigint; v_pay uuid; v_cor uuid;
begin
  -- 9a. a sales user cannot see or remove
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a2', 'role', 'authenticated')::text, true);
  v_ok := false;
  begin perform * from public.employee_loan_ghost_pairs();
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'FAIL 9a: sales user saw left-over pairs'; end if;
  v_ok := false;
  begin perform public.remove_employee_loan_ghost_pair('c1873000-0000-0000-0000-00000000d001', 'c1873000-0000-0000-0000-00000000c001');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'FAIL 9a: sales user removed a pair'; end if;

  -- 9b. another company sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.employee_loan_ghost_pairs();
  if v_n <> 0 then raise exception 'FAIL 9b: another company sees % pair(s)', v_n; end if;

  -- 9c. the owner: exactly one pair (Prashant), Mohan's payout is still needed by his loan
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.employee_loan_ghost_pairs();
  if v_n <> 1 then raise exception 'FAIL 9c: % pair(s) offered (expected 1 — Prashant only)', v_n; end if;
  select payout_id, correction_id into v_pay, v_cor from public.employee_loan_ghost_pairs() where person = 'Prashant' and amount = 2000;
  if v_cor <> 'c1873000-0000-0000-0000-00000000c001' then raise exception 'FAIL 9c: wrong correction line offered'; end if;

  -- 9d. a reconciled correction → not offered, and removing it is refused
  update public.bank_transactions set matched_to_type = 'payment', matched_to_id = 'p1' where id = v_cor;
  select count(*) into v_n from public.employee_loan_ghost_pairs();
  if v_n <> 0 then raise exception 'FAIL 9d: a reconciled line was offered'; end if;
  v_ok := false;
  begin perform public.remove_employee_loan_ghost_pair(v_pay, v_cor);
  exception when others then v_ok := sqlerrm like '%no longer a left-over pair%'; end;
  if not v_ok then raise exception 'FAIL 9d: removing a reconciled pair was not refused'; end if;
  update public.bank_transactions set matched_to_type = 'manual', matched_to_id = null where id = v_cor;

  -- 9e. remove it: balance unchanged, Payments Made 2 → 1 for Prashant, readers agree
  v_bal := pg_temp.balance(c_pc);
  perform public.remove_employee_loan_ghost_pair(v_pay, v_cor);
  if pg_temp.balance(c_pc) <> v_bal then raise exception 'FAIL 9e: balance moved % → %', v_bal, pg_temp.balance(c_pc); end if;
  select count(*) into v_n from public.bank_transactions where bank_account_id = c_pc and description = 'Loan/advance to Prashant';
  if v_n <> 1 then raise exception 'FAIL 9e: % Prashant payout rows left (expected 1)', v_n; end if;
  if pg_temp.paid_sum(c_pc) <> pg_temp.register('c1873000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 9e: Payments Made % vs register %', pg_temp.paid_sum(c_pc), pg_temp.register('c1873000-0000-0000-0000-0000000000a1');
  end if;
  -- the remaining old loan still deletes cleanly with its own payout
  select count(*) into v_n from public.employee_loan_ghost_pairs();
  if v_n <> 0 then raise exception 'FAIL 9f: % pair(s) still offered after removal', v_n; end if;
end $$;
reset role;

-- 9g. MUTATION CHECK — without the "a loan still needs this payout" limit, Mohan's line is offered.
do $$
declare v_src text; v_n int;
begin
  select pg_get_functiondef('public.employee_loan_ghost_pairs()'::regprocedure) into v_src;
  if position('pc.n - coalesce(lg.n, 0)' in v_src) = 0 then raise exception 'FAIL 9g: limit text not found'; end if;
  execute replace(v_src, 'pc.n - coalesce(lg.n, 0)', 'pc.n');
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.employee_loan_ghost_pairs() where person = 'Mohan';
  execute 'reset role';
  if v_n <> 1 then raise exception 'FAIL 9g: mutation check — without the limit Mohan''s needed payout should be offered (got %)', v_n; end if;
  raise notice 'mutation check: without the loan-still-needs-it limit, a payout an old loan needs is offered for removal';
end $$;

-- 8. MUTATION CHECK — the pre-R-1873 delete (correction credit, debit kept) goes RED on step 1.
do $$
declare
  c_pc constant uuid := 'c1873000-0000-0000-0000-0000000ba4a1';   -- T-Bank: empty again after step 3e
  v_l uuid;
begin
  execute $m$
    create or replace function public.delete_employee_loan(p_loan_id uuid) returns void
    language plpgsql security definer set search_path to 'public' as $b$
    declare v_loan public.employee_loans;
    begin
      select * into v_loan from public.employee_loans where id = p_loan_id;
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values (v_loan.tenant_id, v_loan.bank_account_id, current_date, 'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
      update public.employee_loans set bank_txn_id = null where id = p_loan_id;
      delete from public.employee_loans where id = p_loan_id;
    end $b$ $m$;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1873000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  perform public.disburse_employee_loan('Prashant', 2000, '2026-10-24', c_pc, 'loan', null);
  v_l := public.disburse_employee_loan('Prashant', 2000, '2026-10-24', c_pc, 'loan', null);
  perform public.delete_employee_loan(v_l);
  if pg_temp.paid_rows(c_pc) <> 2 or pg_temp.balance(c_pc) <> -2000 then
    raise exception 'FAIL 8: mutation check — the old delete should leave 2 Payments Made rows with Petty Cash -2000 (got % / %)',
      pg_temp.paid_rows(c_pc), pg_temp.balance(c_pc);
  end if;
  raise notice 'mutation check: with the old delete, Payments Made shows % rows while Petty Cash is % (Pardeep''s bug)',
    pg_temp.paid_rows(c_pc), pg_temp.balance(c_pc);
end $$;

rollback;
