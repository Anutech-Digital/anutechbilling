-- R-2346 (1 Nov 2026): the Loans given page's own "Record repayment" (record_loan_repayment, R-544)
-- books the interest part as income — other_incomes head 'interest' = P&L "Interest received" —
-- exactly like a bank-line receipt does (R-2340), and the repayment can be undone the same way.
-- Migration 20261101115000_r2346_loan_repayment_interest_income (on top of R-544 20261010140000,
-- R-2095 other_incomes and R-2340 20261101100517).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: ₹50,000 lent to Suresh on 15 Sep 2026 at 12% a year; on 15 Oct he pays ₹10,500 —
-- ₹500 interest + ₹10,000 of the loan.
--
-- Proves:
--   A. The repayment's ₹500 interest is a P&L "Interest received" line (report_pnl_other_income,
--      October) — before R-2346 it reached no P&L line. Balanced: cash in ₹10,500 = asset down
--      ₹10,000 + income ₹500. The cash-in line reads 'loan_given' (→ the repayment), so Banking
--      labels it "Loan given".
--   B. An interest-free loan, or a repayment with no interest part, books no income row.
--   C. Undo = Un-reconcile the cash-in line: the latest repayment first (an earlier one is refused);
--      the repayment, its interest income AND the line the page added all go; the asset and the cash
--      are back where they were; a closed loan re-opens.
--   D. Refusals unchanged: a sales user; more than is owed.

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
  ('dddddddd-0000-0000-0000-000000234601','R2346 Co','r2346@example.in','07','R2346');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000234601','owner2346@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000234602','sales2346@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000234601','dddddddd-0000-0000-0000-000000234601','owner2346@example.in','Owner 2346','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000234602','dddddddd-0000-0000-0000-000000234601','sales2346@example.in','Sales 2346','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000234601','dddddddd-0000-0000-0000-000000234601','HDFC Current','HDFC', 500000, '2025-04-01');

create temp table r2346_ids (k text primary key, v uuid);
grant all on r2346_ids to public;
create temp table r2346_vals (k text primary key, v bigint);
grant all on r2346_vals to public;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234601","role":"authenticated"}', true);

-- ── A. Interest part → P&L Interest received ────────────────────────────────────────────
do $$
declare v_loan uuid; v_rep uuid; r public.loan_repayments; v_line public.bank_transactions; v_inc public.other_incomes;
begin
  v_loan := public.give_loan('Suresh', 'person', 50000, '2026-09-15', 'bbbbbbbb-0000-0000-0000-000000234601', 12);
  insert into r2346_ids values ('suresh', v_loan);
  insert into r2346_vals values
    ('cash0',  (select cash_and_bank from public.report_balance_sheet('2026-12-31'))),
    ('lines0', (select count(*) from public.bank_transactions where tenant_id = 'dddddddd-0000-0000-0000-000000234601'));

  v_rep := public.record_loan_repayment(v_loan, '2026-10-15', 10500, 500, 'bbbbbbbb-0000-0000-0000-000000234601', 'bank', 'UTR123');
  insert into r2346_ids values ('rep1', v_rep);
  select * into r from public.loan_repayments where id = v_rep;
  if r.amount <> 10500 or r.principal_part <> 10000 or r.interest_part <> 500 or r.bank_txn_id is null then
    raise exception 'FAIL A: repayment %', row_to_json(r);
  end if;
  select * into v_line from public.bank_transactions where id = r.bank_txn_id;
  if v_line.credit <> 10500 or v_line.debit <> 0 or v_line.source <> 'manual' then
    raise exception 'FAIL A: cash-in line %', row_to_json(v_line);
  end if;
  if v_line.matched_to_type is distinct from 'loan_given' or v_line.matched_to_id is distinct from v_rep::text then
    raise exception 'FAIL A: line reads % → % (want loan_given → the repayment)', v_line.matched_to_type, v_line.matched_to_id;
  end if;
  select * into v_inc from public.other_incomes where bank_txn_id = v_line.id;
  if not found then raise exception 'FAIL A: no interest income booked for the repayment'; end if;
  if v_inc.amount <> 500 or v_inc.head <> 'interest' or v_inc.income_date <> '2026-10-15'
     or v_inc.tenant_id <> 'dddddddd-0000-0000-0000-000000234601' then
    raise exception 'FAIL A: income row %', row_to_json(v_inc);
  end if;
  if (select coalesce(sum(amount), 0) from public.report_pnl_other_income('2026-10-01', '2026-10-31') where head = 'interest') <> 500 then
    raise exception 'FAIL A: P&L interest received is not ₹500';
  end if;
  if public.loans_given_asset() <> 40000 then raise exception 'FAIL A: asset % (want 40000)', public.loans_given_asset(); end if;
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) - (select v from r2346_vals where k = 'cash0') <> 10500 then
    raise exception 'FAIL A: cash did not go up by ₹10,500';
  end if;
  -- Balanced: money in = principal back + interest income.
  if v_line.credit <> (50000 - public.loans_given_asset()) + v_inc.amount then raise exception 'FAIL A: not balanced'; end if;
end $$;

-- ── B. No interest → no income row ───────────────────────────────────────────────────────
do $$
declare v_free uuid; v_rep uuid; v_rep2 uuid;
begin
  v_free := public.give_loan('Mohan', 'person', 20000, '2026-09-01', 'bbbbbbbb-0000-0000-0000-000000234601', 0);
  -- interest-free: an interest part handed in is ignored (R-544 rule), nothing is income
  v_rep := public.record_loan_repayment(v_free, '2026-10-01', 5000, 300, 'bbbbbbbb-0000-0000-0000-000000234601');
  if (select interest_part from public.loan_repayments where id = v_rep) <> 0 then raise exception 'FAIL B: interest on an interest-free loan'; end if;
  if exists (select 1 from public.other_incomes o join public.loan_repayments r on r.bank_txn_id = o.bank_txn_id where r.id = v_rep) then
    raise exception 'FAIL B: income booked on an interest-free loan';
  end if;
  -- interest loan, a principal-only repayment
  v_rep2 := public.record_loan_repayment((select v from r2346_ids where k = 'suresh'), '2026-10-20', 1000, 0, 'bbbbbbbb-0000-0000-0000-000000234601');
  if exists (select 1 from public.other_incomes o join public.loan_repayments r on r.bank_txn_id = o.bank_txn_id where r.id = v_rep2) then
    raise exception 'FAIL B: income booked for a ₹0 interest part';
  end if;
  insert into r2346_ids values ('rep2', v_rep2), ('mohan', v_free);
  if (select coalesce(sum(amount), 0) from public.report_pnl_other_income('2026-10-01', '2026-10-31') where head = 'interest') <> 500 then
    raise exception 'FAIL B: P&L interest moved';
  end if;
end $$;

-- ── C. Undo = Un-reconcile the line; latest first ────────────────────────────────────────
do $$
declare v_loan uuid := (select v from r2346_ids where k = 'suresh');
        v_l1 uuid := (select bank_txn_id from public.loan_repayments where id = (select v from r2346_ids where k = 'rep1'));
        v_l2 uuid := (select bank_txn_id from public.loan_repayments where id = (select v from r2346_ids where k = 'rep2'));
        v_last uuid; v_l3 uuid;
begin
  begin
    perform public.unreconcile_bank_receipt(v_l1, false);
    raise exception 'FAIL C: repayment 1 undone while repayment 2 is on the books';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%later receipt%undo%first%' then raise exception 'FAIL C: wrong refusal: %', sqlerrm; end if;
  end;
  perform public.unreconcile_bank_receipt(v_l2, false);
  perform public.unreconcile_bank_receipt(v_l1, false);
  if exists (select 1 from public.loan_repayments where loan_id = v_loan) then raise exception 'FAIL C: repayments left'; end if;
  if exists (select 1 from public.other_incomes where bank_txn_id in (v_l1, v_l2)) then raise exception 'FAIL C: interest income left'; end if;
  if exists (select 1 from public.bank_transactions where id in (v_l1, v_l2)) then
    raise exception 'FAIL C: the cash-in line the page added is still in the bank (money counted with no repayment)';
  end if;
  if (select coalesce(sum(amount), 0) from public.report_pnl_other_income('2026-10-01', '2026-10-31') where head = 'interest') <> 0 then
    raise exception 'FAIL C: P&L interest not back to ₹0';
  end if;
  if public.loans_given_asset() <> 50000 + 15000 then raise exception 'FAIL C: asset %', public.loans_given_asset(); end if;
  -- since cash0: Mohan lent ₹20,000 out, his ₹5,000 repayment is still on the books → cash0 − 15,000
  if (select cash_and_bank from public.report_balance_sheet('2026-12-31')) - (select v from r2346_vals where k = 'cash0') <> -15000 then
    raise exception 'FAIL C: cash not back';
  end if;

  -- the closing repayment, then undo re-opens the loan
  v_last := public.record_loan_repayment(v_loan, '2026-11-15', 50500, 500, 'bbbbbbbb-0000-0000-0000-000000234601');
  if (select status from public.loans_given where id = v_loan) <> 'closed' then raise exception 'FAIL C: loan not closed'; end if;
  v_l3 := (select bank_txn_id from public.loan_repayments where id = v_last);
  perform public.unreconcile_bank_receipt(v_l3, false);
  if (select status from public.loans_given where id = v_loan) <> 'open' then raise exception 'FAIL C: loan not re-opened'; end if;
  if exists (select 1 from public.other_incomes where bank_txn_id = v_l3) then raise exception 'FAIL C: income of the closing repayment left'; end if;
end $$;

-- ── D. Refusals unchanged ────────────────────────────────────────────────────────────────
do $$
begin
  begin
    perform public.record_loan_repayment((select v from r2346_ids where k = 'suresh'), '2026-10-15', 60000, 0, 'bbbbbbbb-0000-0000-0000-000000234601');
    raise exception 'FAIL D: more than owed accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'That is more than is owed%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000234602","role":"authenticated"}', true);
do $$
begin
  perform public.record_loan_repayment((select v from r2346_ids where k = 'suresh'), '2026-10-15', 1000, 0, 'bbbbbbbb-0000-0000-0000-000000234601');
  raise exception 'FAIL D: sales user accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Only the owner or the accountant%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;

select 'R-2346 loan repayment interest → P&L: ALL PASS' as result;

rollback;
