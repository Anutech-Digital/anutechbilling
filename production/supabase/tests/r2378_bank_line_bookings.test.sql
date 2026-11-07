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

  if (select count(*) from public.bank_transactions where bank_account_id = 'aaaaaaaa-0000-0000-0000-0000000023c1' and matched_to_type = 'manual') <> 5 then
    raise exception 'FAIL 0: the five lines should all be manual';
  end if;

  select count(*) into n from public.bank_line_bookings('aaaaaaaa-0000-0000-0000-0000000023c1');
  if n <> 4 then raise exception 'FAIL 1: expected 4 booked lines, got %', n; end if;

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
