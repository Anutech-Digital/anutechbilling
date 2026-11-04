-- Regression test for R-2388 — migration 20261102194900_r2388_personal_loans.sql
--
-- WHAT THIS PROVES (Pardeep's examples: home loan ₹20 L at 8.5% for 240 months; ₹1 L lent to
-- a brother)
--   1. Owner A adds the home loan (EMI ₹17,356) paid from her savings, and a ₹1,00,000 loan
--      given to her brother at 12% (interest-only).
--   2. Schedule maths: "Mark paid" with no split = the reducing-balance split — interest
--      ₹14,167 (₹20,00,000 × 8.5% / 12), principal ₹3,189. Outstanding ₹19,96,811. The second
--      EMI's interest is on the NEW outstanding (₹14,144).
--   3. Ledger: the interest is an expense "Loan EMI"; the principal is a transfer_out (not
--      spend), both on the linked account.
--   4. A prepayment of ₹1,00,000 lowers the outstanding; principal above the outstanding is
--      refused.
--   5. Given loan: interest received = kind interest, income_source interest; principal back =
--      transfer_in (not income). Repaying all of it closes the loan; undo re-opens it.
--   6. Net worth = assets + given outstanding − card dues − taken outstanding.
--   7. Refusals: a closed loan takes no payment; EMI type without tenure/EMI; a given loan
--      of kind 'home'; an EMI on a given loan.
--   8. Owner B in the SAME tenant and a staff user see ZERO of A's loans / payments / balances,
--      cannot pay A's loan through the RPC, and cannot plant a loan in A's name.
--   9. A cannot link a loan to B's account (owner-safe composite FK).
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c3c3c3c3-0000-0000-0000-000000238801', 'r2388-owner-a@example.test'),
  ('c3c3c3c3-0000-0000-0000-000000238802', 'r2388-owner-b@example.test'),
  ('c3c3c3c3-0000-0000-0000-000000238803', 'r2388-staff@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c3c3c3c3-0000-0000-0000-0000002388f0', 'R2388 T', 'r2388@example.test', '07', 'R288');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c3c3c3c3-0000-0000-0000-000000238801', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'r2388-owner-a@example.test', 'R2388 Owner A', 'owner',   true),
  ('c3c3c3c3-0000-0000-0000-000000238802', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'r2388-owner-b@example.test', 'R2388 Owner B', 'owner',   true),
  ('c3c3c3c3-0000-0000-0000-000000238803', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'r2388-staff@example.test',   'R2388 Staff',   'support', true);

insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label, balance) values
  ('c3c3c3c3-0000-0000-0000-0000002388a1', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'c3c3c3c3-0000-0000-0000-000000238801', 'savings',     'A Savings', 500000),
  ('c3c3c3c3-0000-0000-0000-0000002388a2', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'c3c3c3c3-0000-0000-0000-000000238801', 'credit_card', 'A Card',     50000),
  ('c3c3c3c3-0000-0000-0000-0000002388b1', 'c3c3c3c3-0000-0000-0000-0000002388f0', 'c3c3c3c3-0000-0000-0000-000000238802', 'savings',     'B Savings',  10000);

set local role authenticated;

do $$
declare
  v_a    uuid := 'c3c3c3c3-0000-0000-0000-000000238801';
  v_b    uuid := 'c3c3c3c3-0000-0000-0000-000000238802';
  v_st   uuid := 'c3c3c3c3-0000-0000-0000-000000238803';
  v_t    uuid := 'c3c3c3c3-0000-0000-0000-0000002388f0';
  v_sav  uuid := 'c3c3c3c3-0000-0000-0000-0000002388a1';
  v_bsv  uuid := 'c3c3c3c3-0000-0000-0000-0000002388b1';
  v_home uuid;
  v_bro  uuid;
  r      jsonb;
  v_last uuid;
  v_out  bigint;
  v_net  bigint;
  n      integer;
  v_blocked boolean;
  v_kind text;
  v_cat  text;
  v_src  text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  ------------------------------------------- 1. A adds the two loans
  insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal,
                                     start_date, annual_rate, repay_type, tenure_months, emi_amount, account_id)
    values (v_t, v_a, 'taken', 'home', 'SBI Home Loan', 2000000, '2026-04-01', 8.5, 'emi', 240, 17356, v_sav)
    returning id into v_home;
  insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal,
                                     start_date, annual_rate, repay_type, account_id)
    values (v_t, v_a, 'given', 'person', 'Brother', 100000, '2026-04-01', 12, 'interest_only', v_sav)
    returning id into v_bro;

  ------------------------------------------- 2. scheduled split (reducing balance)
  r := public.personal_loan_record_payment(v_home, 'emi', '2026-05-01');
  if (r->>'interest_part')::bigint <> 14167 or (r->>'principal_part')::bigint <> 3189 then
    raise exception 'FAIL 2: first EMI split %, expected interest 14167 / principal 3189', r;
  end if;
  if (r->>'outstanding')::bigint <> 1996811 then raise exception 'FAIL 2: outstanding % after EMI 1', r; end if;
  r := public.personal_loan_record_payment(v_home, 'emi', '2026-06-01');
  -- 1996811 × 8.5 / 1200 = 14144.08 → 14144
  if (r->>'interest_part')::bigint <> 14144 or (r->>'principal_part')::bigint <> 3212 then
    raise exception 'FAIL 2: second EMI split %, expected interest 14144 / principal 3212', r;
  end if;
  select outstanding, emi_paid_count, interest_paid into v_out, n, v_net
    from public.personal_loan_balances where loan_id = v_home;
  if v_out <> 1993599 or n <> 2 or v_net <> 28311 then
    raise exception 'FAIL 2: balances view outstanding % / emis % / interest %', v_out, n, v_net;
  end if;

  ------------------------------------------- 3. ledger entries
  select count(*) into n from public.personal_transactions
   where kind = 'expense' and category = 'Loan EMI' and account_id = v_sav and amount in (14167, 14144);
  if n <> 2 then raise exception 'FAIL 3: % interest expense rows, expected 2', n; end if;
  select count(*) into n from public.personal_transactions
   where kind = 'transfer_out' and category = 'Loan repayment' and account_id = v_sav and amount in (3189, 3212);
  if n <> 2 then raise exception 'FAIL 3: % principal transfer_out rows, expected 2', n; end if;

  ------------------------------------------- 4. prepayment; too much principal refused
  r := public.personal_loan_record_payment(v_home, 'prepayment', '2026-06-15', 100000, 0);
  if (r->>'outstanding')::bigint <> 1893599 then raise exception 'FAIL 4: outstanding % after prepayment', r; end if;
  v_blocked := false;
  begin
    perform public.personal_loan_record_payment(v_home, 'prepayment', '2026-06-16', 5000000, 0);
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a principal above the outstanding was accepted'; end if;

  ------------------------------------------- 5. given loan: interest + repayment, close, undo
  r := public.personal_loan_record_payment(v_bro, 'interest', '2026-05-01');
  if (r->>'interest_part')::bigint <> 1000 or (r->>'principal_part')::bigint <> 0 then
    raise exception 'FAIL 5: interest received %, expected 1000', r;
  end if;
  select kind, income_source into v_kind, v_src from public.personal_transactions
   where id = (select interest_tx_id from public.personal_loan_payments where id = (r->>'payment_id')::uuid);
  if v_kind <> 'interest' or v_src <> 'interest' then
    raise exception 'FAIL 5: interest received booked as % / %', v_kind, v_src;
  end if;
  r := public.personal_loan_record_payment(v_bro, 'repayment', '2026-06-01', 40000, 0);
  select kind, category into v_kind, v_cat from public.personal_transactions
   where id = (select principal_tx_id from public.personal_loan_payments where id = (r->>'payment_id')::uuid);
  if v_kind <> 'transfer_in' or v_cat <> 'Loan repayment received' then
    raise exception 'FAIL 5: principal back booked as % / %', v_kind, v_cat;
  end if;

  ------------------------------------------- 6. net worth
  -- assets 5,00,000 + given 60,000 − card 50,000 − taken 18,93,599 = −13,83,599
  select coalesce(sum(balance) filter (where kind <> 'credit_card'), 0)
       - coalesce(sum(balance) filter (where kind = 'credit_card'), 0)
       + (select coalesce(sum(outstanding), 0) from public.personal_loan_balances where status = 'open' and direction = 'given')
       - (select coalesce(sum(outstanding), 0) from public.personal_loan_balances where status = 'open' and direction = 'taken')
    into v_net
    from public.personal_accounts where is_active;
  if v_net <> -1383599 then raise exception 'FAIL 6: net worth %, expected -1383599', v_net; end if;

  r := public.personal_loan_record_payment(v_bro, 'repayment', '2026-07-01', 60000, 0);
  v_last := (r->>'payment_id')::uuid;
  if not (r->>'closed')::boolean then raise exception 'FAIL 5: fully repaid loan not closed: %', r; end if;
  select count(*) into n from public.personal_loans where id = v_bro and status = 'closed' and closed_on = '2026-07-01';
  if n <> 1 then raise exception 'FAIL 5: loan not closed on the repayment day'; end if;

  ------------------------------------------- 7. refusals
  v_blocked := false;
  begin
    perform public.personal_loan_record_payment(v_bro, 'interest', '2026-07-02');
  exception when raise_exception then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 7: a closed loan took a payment'; end if;

  r := public.personal_loan_undo_payment(v_last);
  if not (r->>'reopened')::boolean then raise exception 'FAIL 5: undo did not re-open: %', r; end if;
  select count(*) into n from public.personal_transactions where category = 'Loan repayment received';
  if n <> 1 then raise exception 'FAIL 5: undo left % repayment rows, expected 1', n; end if;
  select outstanding into v_out from public.personal_loan_balances where loan_id = v_bro and status = 'open';
  if v_out <> 60000 then raise exception 'FAIL 5: outstanding % after undo, expected 60000', v_out; end if;

  v_blocked := false;
  begin
    perform public.personal_loan_record_payment(v_bro, 'emi', '2026-07-02');
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 7: an EMI on a given loan was accepted'; end if;

  v_blocked := false;
  begin
    insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, repay_type)
      values (v_t, v_a, 'taken', 'car', 'X', 500000, 'emi');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 7: an EMI loan without tenure / EMI was accepted'; end if;

  v_blocked := false;
  begin
    insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, repay_type)
      values (v_t, v_a, 'given', 'home', 'X', 500000, 'no_interest');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 7: a given loan of kind home was accepted'; end if;

  ------------------------------------------- 9. A cannot link to B's account
  v_blocked := false;
  begin
    insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, repay_type, account_id)
      values (v_t, v_a, 'given', 'person', 'X', 1000, 'no_interest', v_bsv);
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 9: a loan was linked to another person''s account'; end if;

  ------------------------------------------- 8. owner B and staff see nothing of A's
  foreach v_kind in array array[v_b::text, v_st::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_kind, 'role', 'authenticated')::text, true);
    select count(*) into n from public.personal_loans;
    if n <> 0 then raise exception 'FAIL 8: user % sees % of A''s loans', v_kind, n; end if;
    select count(*) into n from public.personal_loan_payments;
    if n <> 0 then raise exception 'FAIL 8: user % sees % of A''s payments', v_kind, n; end if;
    select count(*) into n from public.personal_loan_balances;
    if n <> 0 then raise exception 'FAIL 8: user % sees % of A''s loan balances', v_kind, n; end if;
    v_blocked := false;
    begin
      perform public.personal_loan_record_payment(v_home, 'emi', '2026-07-01');
    exception when no_data_found then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 8: user % paid A''s EMI', v_kind; end if;
    update public.personal_loans set principal = 1 where id = v_home;
    delete from public.personal_loans where id = v_bro;
    v_blocked := false;
    begin
      insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, repay_type)
        values (v_t, v_a, 'given', 'person', 'Planted', 10, 'no_interest');
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 8: user % planted a loan in A''s name', v_kind; end if;
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_loans where (id = v_home and principal = 2000000) or id = v_bro;
  if n <> 2 then raise exception 'FAIL 8: B / staff update or delete reached A''s loans'; end if;

  raise notice 'R-2388 personal_loans: all checks passed';
end $$;

rollback;
