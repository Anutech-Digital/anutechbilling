-- R-2935 (staging 18 Nov 2026, Excel HDFC 4523): HDFC pays a closed FD on three bank lines —
--   "FD REDEEM PRINCIPAL" +₹10,00,000 (own transfer), "FD REDEEM INTEREST" +₹8,014 (gross interest)
--   and "FD REDEEM TAX" −₹801 (TDS the bank cut). The tax line had no way to be booked.
--   Migration 20261118233537_r2935_interest_tds_bank_line. Self-asserting, ONE transaction, rolled back.
--
--   A. Owner's lines: principal = own transfer from the FD (FD balance 0); the interest line books
--      as plain interest ₹8,014 with the FD named and principal 0 (no "FD closed") — P&L ₹8,014,
--      the FD balance is not touched (principal is never income).
--   B. bank_interest_without_tds(tax line) offers that interest; book_bank_debit_as_interest_tds →
--      tds_receivable ₹801 (194A, gross 8,014, net 7,213, 10%), line matched 'tds_receivable',
--      income still ₹8,014; balanced: Δbank(+8,014 −801) + ΔTDS(801) = Δincome(8,014).
--   C. Un-reconcile the tax line → TDS row gone, the interest row plain again (and offered again).
--   D. Booked again; un-reconcile the INTEREST line → income row, TDS row gone, tax line free.
--   E. Refusals: money-in line; already reconciled; interest that already has TDS; loan interest
--      (source null); TDS ≥ interest; a signed-in user cannot set the type by hand (reconcile_bank_txn).
--   F. A TDS row claimed in the ITR refuses both undo paths.
--   G. Deleting the tax line (statement import undone) cleans up the same way.
--   H. Tenant isolation: another company cannot book the line, is offered nothing.
--   I. The TDS row removed on the TDS page first → un-reconciling the tax line still makes the
--      interest row plain; a line pointed by hand at ANOTHER TDS row never deletes that row.

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
  ('dddddddd-0000-0000-0000-000000293501','R2935 FD Co','r2935fd@example.in','07','R35F'),
  ('dddddddd-0000-0000-0000-000000293502','R2935 Other Co','r2935oth@example.in','07','R35O');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000293501','owner2935@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000293502','owner2935b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000293501','dddddddd-0000-0000-0000-000000293501','owner2935@example.in','Owner FD','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000293502','dddddddd-0000-0000-0000-000000293502','owner2935b@example.in','Owner Other','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000293501','dddddddd-0000-0000-0000-000000293501','HDFC 4523','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000293502','dddddddd-0000-0000-0000-000000293501','HDFC FD 50301205948354','HDFC','fixed_deposit', 1000000);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000293501','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-21','FD REDEEM PRINCIPAL -50301205948354/1',0,1000000,null,'manual'),
  ('11111111-0000-0000-0000-000000293502','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-21','FD REDEEM INTEREST -50301205948354/1',0,8014,null,'manual'),
  ('11111111-0000-0000-0000-000000293503','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-21','FD REDEEM TAX - 50301205948354/1',801,0,null,'manual'),
  -- a second, unrelated interest and an oversized "TDS" line for the refusals
  ('11111111-0000-0000-0000-000000293504','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-22','SB INT CREDIT',0,500,null,'manual'),
  ('11111111-0000-0000-0000-000000293505','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-22','TDS ON INT',500,0,null,'manual'),
  ('11111111-0000-0000-0000-000000293506','dddddddd-0000-0000-0000-000000293501','bbbbbbbb-0000-0000-0000-000000293501','2025-11-22','TDS ON INT',50,0,null,'manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000293501","role":"authenticated"}', true);

create function pg_temp.bal(acc uuid) returns bigint language sql as $f$
  select (select opening_balance from public.bank_accounts where id = acc)
       + coalesce((select sum(credit - debit) from public.bank_transactions where bank_account_id = acc), 0)
$f$;
create function pg_temp.tds() returns bigint language sql as $f$
  select coalesce(sum(tds_amount), 0) from public.tds_receivable
   where tenant_id = 'dddddddd-0000-0000-0000-000000293501' and status in ('pending_cert','cert_received','verified_26as')
$f$;
create function pg_temp.inc() returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.other_incomes where tenant_id = 'dddddddd-0000-0000-0000-000000293501'
$f$;

do $$
declare
  r jsonb; ok boolean; v_inc uuid; v_inc2 uuid; v_tds_id text; n integer;
begin
  -- A: principal = own transfer from the FD; interest = plain interest, FD named, principal 0
  perform public.reconcile_bank_txn_as_transfer('11111111-0000-0000-0000-000000293501', 'bbbbbbbb-0000-0000-0000-000000293502');
  if pg_temp.bal('bbbbbbbb-0000-0000-0000-000000293502') <> 0 then
    raise exception 'FAIL A: FD balance is % not 0 after the principal transfer', pg_temp.bal('bbbbbbbb-0000-0000-0000-000000293502'); end if;
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000293502', 'fd',
         'bbbbbbbb-0000-0000-0000-000000293502', 0, 8014, 0, null);
  v_inc := (r->>'other_income_id')::uuid;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000293502') <> 'other_income' then
    raise exception 'FAIL A: interest line not reconciled'; end if;
  if (select amount from public.report_pnl_other_income('2025-11-21', '2025-11-21') where head = 'interest') is distinct from 8014 then
    raise exception 'FAIL A: P&L interest is not ₹8,014'; end if;
  if pg_temp.inc() <> 8014 then raise exception 'FAIL A: income % — the principal must never be income', pg_temp.inc(); end if;
  if pg_temp.bal('bbbbbbbb-0000-0000-0000-000000293502') <> 0 then raise exception 'FAIL A: interest booking moved the FD balance'; end if;
  raise notice 'A PASS: principal = transfer (FD 0), interest ₹8,014 booked with FD closed NOT ticked';

  -- B: the tax line
  select count(*) into n from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293503');
  if n <> 1 or (select id from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293503')) <> v_inc then
    raise exception 'FAIL B: the interest is not offered for the tax line (% rows)', n; end if;
  r := public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293503', v_inc);
  v_tds_id := r->>'tds_receivable_id';
  if not exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000293503'
                    and matched_to_type = 'tds_receivable' and matched_to_id = v_tds_id and matched_at is not null) then
    raise exception 'FAIL B: tax line not reconciled as tds_receivable'; end if;
  if not exists (select 1 from public.tds_receivable where id = v_tds_id and tds_amount = 801 and gross_amount = 8014
                    and net_paid = 7213 and section = '194A' and rate_pct = 10.00 and fiscal_year = public.indian_fiscal_year('2025-11-21'::date)
                    and customer_name = 'HDFC' and status = 'pending_cert') then
    raise exception 'FAIL B: TDS receivable row wrong (%)', (select row_to_json(t) from public.tds_receivable t where id = v_tds_id); end if;
  if not exists (select 1 from public.other_incomes where id = v_inc and amount = 8014 and tds_amount = 801
                    and tds_receivable_id = v_tds_id and tds_txn_id = '11111111-0000-0000-0000-000000293503') then
    raise exception 'FAIL B: interest row does not carry its TDS'; end if;
  if (select amount from public.report_pnl_other_income('2025-11-21', '2025-11-21') where head = 'interest') is distinct from 8014 then
    raise exception 'FAIL B: P&L interest changed — it was credited gross'; end if;
  -- Dr bank (8,014 − 801) + Dr TDS 801 = Cr interest 8,014  (the principal line nets to 0 against the FD)
  if (pg_temp.bal('bbbbbbbb-0000-0000-0000-000000293501') - 1000000 - 500 + 500 + 50) + pg_temp.tds() <> pg_temp.inc() then
    raise exception 'FAIL B: not balanced'; end if;
  if exists (select 1 from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293506') where id = v_inc) then
    raise exception 'FAIL B: an interest that has its TDS is offered again'; end if;
  raise notice 'B PASS: tax line → TDS receivable ₹801 (194A, 10%% of ₹8,014), income unchanged, balanced';

  -- E (while booked): refusals
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293503', v_inc);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL E: an already reconciled line was booked again'; end if;
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293506', v_inc);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL E: a second TDS line taken on the same interest'; end if;
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293504', v_inc);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: a money-in line taken as TDS'; end if;
  ok := false;
  begin perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293506', 'tds_receivable', v_tds_id, 'manual');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL E: a signed-in user set tds_receivable by hand'; end if;

  -- C: un-reconcile the tax line
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293503', null, null, null);
  if exists (select 1 from public.tds_receivable where id = v_tds_id) then raise exception 'FAIL C: TDS row kept'; end if;
  if not exists (select 1 from public.other_incomes where id = v_inc and amount = 8014 and tds_amount = 0
                    and tds_receivable_id is null and tds_txn_id is null) then
    raise exception 'FAIL C: interest row not plain again'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000293502') <> 'other_income' then
    raise exception 'FAIL C: the interest line lost its match'; end if;
  if pg_temp.tds() <> 0 or pg_temp.inc() <> 8014 then raise exception 'FAIL C: totals wrong'; end if;
  if (select count(*) from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293503')) <> 1 then
    raise exception 'FAIL C: the interest is not offered again'; end if;
  raise notice 'C PASS: un-reconciling the tax line removes the TDS row only';

  -- E (more): savings interest ₹500 — TDS ₹500 is the whole interest; loan interest has no bank TDS
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000293504', 'savings', null, 0, 500, 0, null);
  v_inc2 := (r->>'other_income_id')::uuid;
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293505', v_inc2);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: TDS as big as the interest taken'; end if;
  if exists (select 1 from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293505') where id = v_inc2) then
    raise exception 'FAIL E: an interest no bigger than the line is offered'; end if;
  update public.other_incomes set source = null where id = v_inc2;   -- as a loan-interest row (R-2346) is
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293506', v_inc2);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL E: loan interest taken for a bank TDS line'; end if;
  ok := false;
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293506', gen_random_uuid());
  exception when no_data_found then ok := true; end;
  if not ok then raise exception 'FAIL E: an unknown interest row taken'; end if;
  raise notice 'E PASS: refusals';

  -- D: booked again; un-reconcile the INTEREST line
  r := public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293503', v_inc);
  v_tds_id := r->>'tds_receivable_id';
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293502', null, null, null);
  if exists (select 1 from public.other_incomes where id = v_inc) then raise exception 'FAIL D: income row kept'; end if;
  if exists (select 1 from public.tds_receivable where id = v_tds_id) then raise exception 'FAIL D: TDS row kept'; end if;
  if not exists (select 1 from public.bank_transactions where id = '11111111-0000-0000-0000-000000293503'
                    and matched_to_type is null and matched_to_id is null) then
    raise exception 'FAIL D: tax line not freed'; end if;
  raise notice 'D PASS: un-reconciling the interest line frees the tax line and removes the TDS row';

  -- F: claimed in the ITR → neither side can be undone
  r := public.book_bank_credit_as_interest('11111111-0000-0000-0000-000000293502', 'fd',
         'bbbbbbbb-0000-0000-0000-000000293502', 0, 8014, 0, null);
  v_inc := (r->>'other_income_id')::uuid;
  r := public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293503', v_inc);
  v_tds_id := r->>'tds_receivable_id';
  update public.tds_receivable set claimed_in_itr = true where id = v_tds_id;
  ok := false;
  begin perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293503', null, null, null);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL F: tax line undone though the TDS is claimed'; end if;
  ok := false;
  begin perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293502', null, null, null);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL F: interest line undone though the TDS is claimed'; end if;
  if not exists (select 1 from public.tds_receivable where id = v_tds_id) then raise exception 'FAIL F: claimed TDS row lost'; end if;
  update public.tds_receivable set claimed_in_itr = false where id = v_tds_id;
  raise notice 'F PASS: a TDS claimed in the ITR is not undone';

  -- I: the TDS row is removed first (TDS receivable page), then the tax line is un-reconciled
  delete from public.tds_receivable where id = v_tds_id;
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000293503', null, null, null);
  if not exists (select 1 from public.other_incomes where id = v_inc and tds_amount = 0 and tds_txn_id is null and tds_receivable_id is null) then
    raise exception 'FAIL I: interest row still says it has TDS after the TDS row and the line match are gone'; end if;
  if (select count(*) from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293503')) <> 1 then
    raise exception 'FAIL I: the interest is not offered again'; end if;
  -- a customer's TDS row (not made by this flow): a line pointed at it by hand must not delete it on un-match
  insert into public.tds_receivable (id, tenant_id, customer_name, section, rate_pct, gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes)
    values ('TDS-R2935-OTHER', 'dddddddd-0000-0000-0000-000000293501', 'Some Customer', '194J', 10, 1000, 100, 900, public.indian_fiscal_year('2025-11-21'::date), '2025-11-21', 'pending_cert', 'customer TDS');
  update public.bank_transactions set matched_to_type = 'tds_receivable', matched_to_id = 'TDS-R2935-OTHER' where id = '11111111-0000-0000-0000-000000293506';
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000293506';
  if not exists (select 1 from public.tds_receivable where id = 'TDS-R2935-OTHER') then
    raise exception 'FAIL I: un-matching a line deleted a TDS row this flow did not make'; end if;
  delete from public.tds_receivable where id = 'TDS-R2935-OTHER';
  raise notice 'I PASS: undo is clean after the TDS row was removed by hand; foreign TDS rows are never deleted';
  r := public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293503', v_inc);
  v_tds_id := r->>'tds_receivable_id';

  -- G: the tax line itself deleted
  delete from public.bank_transactions where id = '11111111-0000-0000-0000-000000293503';
  if exists (select 1 from public.tds_receivable where id = v_tds_id) then raise exception 'FAIL G: TDS row kept after its line was deleted'; end if;
  if not exists (select 1 from public.other_incomes where id = v_inc and tds_amount = 0 and tds_txn_id is null and tds_receivable_id is null) then
    raise exception 'FAIL G: interest row still points at the deleted line'; end if;
  raise notice 'G PASS: deleting the tax line cleans up';
end $$;

-- H: another company
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000293502","role":"authenticated"}', true);
do $$
declare ok boolean := false; v_inc uuid;
begin
  select id into v_inc from public.other_incomes where bank_txn_id = '11111111-0000-0000-0000-000000293502';
  begin perform public.book_bank_debit_as_interest_tds('11111111-0000-0000-0000-000000293506', v_inc);
  exception when sqlstate '42501' then ok := true; end;
  if not ok then raise exception 'FAIL H: another company booked this line'; end if;
  if exists (select 1 from public.bank_interest_without_tds('11111111-0000-0000-0000-000000293506')) then
    raise exception 'FAIL H: another company is offered this company''s interest'; end if;
  raise notice 'H PASS: tenant isolation';
end $$;

select 'R-2935 interest TDS on its own bank line: ALL PASS' as result;

rollback;
