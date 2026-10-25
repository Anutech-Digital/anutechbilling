-- Regression test: book_bank_txn_as_prepaid + consume_prepaid_fifo + the prepaid
-- branch of reconcile_bank_txn + the delete trigger (migration 20260925160000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/prepaid_from_bank.test.sql
--
-- What it proves:
--   1. A top-up line becomes an advance for exactly its amount, linked both ways.
--   2. One invoice larger than any single top-up is consumed oldest-first across
--      them; the slices add up to the invoice and its GST exactly.
--   3. R-1913 (B2): an invoice bigger than the open balance becomes ONE unpaid bill for the
--      full invoice with the whole balance applied (₹1 stays due); undone so 2 starts clean.
--   4. Un-reconciling a top-up whose advance was used is refused; an unused one is
--      removed with its advance.
--   5. Deleting a bank-funded advance frees its bank line.
--   6. Another company's user cannot book this company's line.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'PREPAID TEST A', 'pp-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', 'PREPAID TEST B', 'pp-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pp-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pp-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a2', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'pp-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b2', 'bbbbbbbb-0000-0000-0000-0000000000b2', 'pp-b-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba002', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b8001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000ba002', '2026-07-01', 'X/PAYUFACEBOOK', 5000, 0, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000b8002', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000ba002', '2026-07-10', 'Y/PAYUFACEBOOK', 5000, 0, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000b8003', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000ba002', '2026-07-20', 'Z/PAYUFACEBOOK', 5000, 0, 'manual');

set local role authenticated;

-- 6. Tenant B cannot book tenant A's line
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b2', 'role', 'authenticated')::text, true);
do $$ begin
  begin
    perform public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8001', 'Facebook');
    raise exception 'FAIL 6: tenant B booked tenant A''s line';
  exception when others then
    if sqlerrm not like 'Bank line not found%' then raise exception 'FAIL 6: wrong error: %', sqlerrm; end if;
  end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a2', 'role', 'authenticated')::text, true);

-- 1. Three top-ups become three linked advances
do $$
declare v_id uuid; v_adv public.prepaid_advances; v_txn public.bank_transactions;
begin
  v_id := public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8001', 'Facebook', 'Advertising');
  select * into v_adv from public.prepaid_advances where id = v_id;
  select * into v_txn from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b8001';
  if v_adv.total_amount <> 5000 or v_adv.consumed_amount <> 0 or v_adv.bank_txn_id <> v_txn.id or v_adv.paid_date <> '2026-07-01' then
    raise exception 'FAIL 1a: advance %', row_to_json(v_adv);
  end if;
  if v_txn.matched_to_type <> 'prepaid' or v_txn.matched_to_id <> v_id::text then
    raise exception 'FAIL 1b: line % / %', v_txn.matched_to_type, v_txn.matched_to_id;
  end if;
  perform public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8002', 'facebook ', 'Advertising');  -- case/space differ on purpose
  perform public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8003', 'Facebook', 'Advertising');
end $$;

-- 3. Invoice larger than the open balance (R-1913, B2): one unpaid bill, the balance applied, ₹1 due.
--    Checked inside a sub-block that is then undone, so step 2 starts from the same balances.
do $$
declare v_left int; v_n int; v_amt int; v_applied int; v_paid boolean;
begin
  begin
    v_left := public.consume_prepaid_fifo('Facebook', 15001, 0, '2026-07-31');
    if v_left <> -1 then raise exception 'FAIL 3: returned %, want -1 (₹1 still due)', v_left; end if;
    select count(*), max(amount), max(advance_applied), bool_or(paid) into v_n, v_amt, v_applied, v_paid
      from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a2';
    if v_n <> 1 or v_amt <> 15001 or v_applied <> 15000 or v_paid then
      raise exception 'FAIL 3b: rows % amount % applied % paid %', v_n, v_amt, v_applied, v_paid;
    end if;
    raise exception 'R1913_UNDO';
  exception when others then
    if sqlerrm <> 'R1913_UNDO' then raise; end if;
  end;
  if exists (select 1 from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 3c: the undone sub-block left expenses behind';
  end if;
end $$;

-- 2. ₹12,300 invoice with ₹1,876 GST spans the three top-ups, oldest first
do $$
declare v_left int; v_sum int; v_gst int; v_n int; v_c1 int; v_c2 int; v_c3 int;
begin
  v_left := public.consume_prepaid_fifo('FACEBOOK', 12300, 1876, '2026-07-31', 'INV-JUL');
  if v_left <> 2700 then raise exception 'FAIL 2a: balance left %, want 2700', v_left; end if;

  select sum(amount), sum(gst_paid), count(*) into v_sum, v_gst, v_n
    from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a2';
  if v_sum <> 12300 or v_gst <> 1876 or v_n <> 3 then
    raise exception 'FAIL 2b: slices sum % / GST % / count %', v_sum, v_gst, v_n;
  end if;

  select consumed_amount into v_c1 from public.prepaid_advances where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b8001';
  select consumed_amount into v_c2 from public.prepaid_advances where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b8002';
  select consumed_amount into v_c3 from public.prepaid_advances where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b8003';
  if v_c1 <> 5000 or v_c2 <> 5000 or v_c3 <> 2300 then
    raise exception 'FAIL 2c: not oldest-first — consumed %, %, %', v_c1, v_c2, v_c3;
  end if;
  if exists (select 1 from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' and category <> 'Advertising') then
    raise exception 'FAIL 2d: slice booked outside the advance''s category';
  end if;
end $$;

-- 4. Un-reconcile: refused when used
do $$ begin
  begin
    perform public.reconcile_bank_txn('aaaaaaaa-0000-0000-0000-0000000b8003', null, null, null);
    raise exception 'FAIL 4a: un-reconciled a partly used advance';
  exception when others then
    if sqlerrm not like 'This advance has ₹2300 already booked%' then raise exception 'FAIL 4a: wrong error: %', sqlerrm; end if;
  end;
end $$;

-- 4b/5. An unused advance: un-reconcile removes it; deleting one frees its line
do $$
declare v_id uuid;
begin
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
    ('aaaaaaaa-0000-0000-0000-0000000b8004', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000ba002', '2026-08-01', 'W/PAYUFACEBOOK', 3000, 0, 'manual'),
    ('aaaaaaaa-0000-0000-0000-0000000b8005', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000ba002', '2026-08-05', 'V/PAYUFACEBOOK', 2000, 0, 'manual');

  perform public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8004', 'Facebook');
  perform public.reconcile_bank_txn('aaaaaaaa-0000-0000-0000-0000000b8004', null, null, null);
  if exists (select 1 from public.prepaid_advances where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b8004') then
    raise exception 'FAIL 4b: unused advance survived un-reconcile';
  end if;

  v_id := public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000b8005', 'Facebook');
  delete from public.prepaid_advances where id = v_id;
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b8005') is not null then
    raise exception 'FAIL 5: deleting the advance left its bank line matched';
  end if;
end $$;

do $$ begin raise notice 'PASS: prepaid_from_bank'; end $$;
rollback;
