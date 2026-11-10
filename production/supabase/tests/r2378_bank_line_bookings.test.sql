-- R-2378: a bank line booked as a loan / advance (book_bank_advance) or director's loan (book_bank_credit)
-- is stored as matched_to_type = 'manual'; bank_line_bookings() must return its real booking, while a
-- plain "Mark reconciled manually" line returns nothing. Also: RLS — another tenant sees nothing.
-- Self-asserting; ROLLS BACK. Red without migration 20261107151806_r2378_bank_line_bookings.sql.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2378_bank_line_bookings.test.sql

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000023a1', 'R2378 TEST', 'r2378@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000023a2', 'R2378 OTHER', 'r2378b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000023b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2378-user@example.in'),
  ('aaaaaaaa-0000-0000-0000-0000000023b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2378-other@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000000023b1', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'r2378-user@example.in', 'owner'),
  ('aaaaaaaa-0000-0000-0000-0000000023b2', 'aaaaaaaa-0000-0000-0000-0000000023a2', 'r2378-other@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000023c1', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'Test OD', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000023d1', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-10-01', 'NEFT BAJAJ FINANCE LOAN', 0, 500000, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000023d2', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-10-05', 'ACH TATA CAPITAL EMI', 25000, 0, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000023d3', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-10-06', 'IMPS RAVI', 10000, 0, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000023d4', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-10-07', 'NEFT DIRECTOR', 0, 300000, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-0000000023d5', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-10-08', 'RTGS FAILED', 0, 7000, 'csv_upload');

-- A staff loan from before R-1873 (no bank_txn_id) and its hand-entered lines, as the old RPCs wrote them.
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000023e1', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'Asha', 15000, '2026-09-01', 'aaaaaaaa-0000-0000-0000-0000000023c1', 'loan');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence) values
  ('aaaaaaaa-0000-0000-0000-0000000023d6', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-09-01', 'Loan/advance to Asha', 15000, 0, 'manual', 'manual', 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000023d7', 'aaaaaaaa-0000-0000-0000-0000000023a1', 'aaaaaaaa-0000-0000-0000-0000000023c1', '2026-09-10', 'Correction: reversed loan/advance to Asha', 0, 15000, 'manual', 'manual', 'manual');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000023b1', 'role', 'authenticated')::text, true);

do $$
declare r record; n int;
begin
  perform public.book_bank_advance('aaaaaaaa-0000-0000-0000-0000000023d1', 'Bajaj Finance', 'received', null);
  perform public.book_bank_advance('aaaaaaaa-0000-0000-0000-0000000023d2', 'Tata Capital', 'received', null);
  perform public.book_bank_advance('aaaaaaaa-0000-0000-0000-0000000023d3', 'Ravi', 'given', null);
  perform public.book_bank_credit('aaaaaaaa-0000-0000-0000-0000000023d4', 'director_loan', 'Loan from Pardeep', null);
  perform public.reconcile_bank_txn_manual('aaaaaaaa-0000-0000-0000-0000000023d5', 'Returned by the bank, no entry');

  /* R-2570: book_bank_advance / book_bank_credit now store their own type ('bs_item' + the row id);
     the two old staff-loan lines and the real manual one stay 'manual'. */
  if (select count(*) from public.bank_transactions where bank_account_id = 'aaaaaaaa-0000-0000-0000-0000000023c1' and matched_to_type = 'manual') <> 3
     or (select count(*) from public.bank_transactions where bank_account_id = 'aaaaaaaa-0000-0000-0000-0000000023c1' and matched_to_type = 'bs_item') <> 4 then
    raise exception 'FAIL 0: expected 3 manual + 4 bs_item lines';
  end if;

  select count(*) into n from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1');
  if n <> 6 then raise exception 'FAIL 1: expected 6 booked lines, got %', n; end if;

  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d6';
  if r.source <> 'employee_loan' or r.party <> 'Asha' then raise exception 'FAIL 8: legacy staff loan line read %', row_to_json(r); end if;
  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d7';
  if r.source <> 'employee_loan_reversal' or r.party <> 'Asha' then raise exception 'FAIL 9: correction line read %', row_to_json(r); end if;

  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d1';
  if r.source <> 'bs_item' or r.sub <> 'liability' or r.party <> 'Loan received · Bajaj Finance' or r.amount <> 500000 then
    raise exception 'FAIL 2: Bajaj line read %', row_to_json(r);
  end if;
  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d2';
  if r.sub <> 'liability' or r.party <> 'Loan repaid · Tata Capital' or r.amount <> -25000 then
    raise exception 'FAIL 3: Tata line read %', row_to_json(r);
  end if;
  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d3';
  if r.sub <> 'asset' or r.amount <> 10000 then raise exception 'FAIL 4: advance line read %', row_to_json(r); end if;
  select * into r from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d4';
  if r.sub <> 'liability' or r.party <> 'Loan from Pardeep' then raise exception 'FAIL 5: director loan read %', row_to_json(r); end if;
  if exists (select 1 from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1') where txn_id = 'aaaaaaaa-0000-0000-0000-0000000023d5') then
    raise exception 'FAIL 6: a real manual (no entry) line must return nothing';
  end if;
end $$;

-- Another tenant sees nothing of this account (security invoker → RLS).
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000023b2', 'role', 'authenticated')::text, true);
do $$
begin
  if exists (select 1 from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1')) then
    raise exception 'FAIL 7: another tenant can read this account''s bookings';
  end if;
end $$;

do $$ begin raise notice 'PASS: r2378_bank_line_bookings'; end $$;
rollback;
