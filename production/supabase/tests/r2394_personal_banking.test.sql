-- Regression test for R-2394 — migration 20261103012000_r2394_personal_banking.sql
--
-- WHAT THIS PROVES (Pardeep, 3 Nov: private banking like the business side, banks still assets)
--   1. A ₹50,000-opening savings statement of 10 lines imports once; line_no keeps the file
--      order; a second upload of the same file adds nothing.
--   2. Balance = opening + lines (personal_account_balances). A ₹5,000 LIC premium A had
--      already typed on Income & Expenses is counted twice until it is matched.
--   3. Reconcile with the vault meanings: income (salary source), expense + rule "SWIGGY →
--      Food / Dining" (the other SWIGGY line gets the suggestion, still unmatched), card
--      payment (creates the card's leg: owed ₹12,000 → 0), ATM cash (cash account +2,000),
--      transfer (creates the current account's leg), loan EMI (scheduled split 14,167 /
--      3,189 via personal_loan_record_payment — the bank line merges into the loan's ledger
--      rows, balance unchanged, re-import still skips it), byana (a new R-2386 advance entry
--      of ₹5,00,000), drawing, match (merges into the typed LIC entry).
--   4. After matching, the account balance equals the statement's last balance (₹6,37,874).
--   5. Refusals: expense on money IN; a typed entry is not a statement line; a matched line
--      must be undone first. Undo of the card payment removes the card leg (owed back to
--      ₹12,000); undo of a loan line is refused (Loans page).
--   6. Owner B in the SAME tenant and a staff user see ZERO of A's lines, cannot reconcile
--      A's line and cannot import into A's account.
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c4c4c4c4-0000-0000-0000-000000239401', 'r2394-owner-a@example.test'),
  ('c4c4c4c4-0000-0000-0000-000000239402', 'r2394-owner-b@example.test'),
  ('c4c4c4c4-0000-0000-0000-000000239403', 'r2394-staff@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c4c4c4c4-0000-0000-0000-0000002394f0', 'R2394 T', 'r2394@example.test', '07', 'R294');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c4c4c4c4-0000-0000-0000-000000239401', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'r2394-owner-a@example.test', 'R2394 Owner A', 'owner',   true),
  ('c4c4c4c4-0000-0000-0000-000000239402', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'r2394-owner-b@example.test', 'R2394 Owner B', 'owner',   true),
  ('c4c4c4c4-0000-0000-0000-000000239403', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'r2394-staff@example.test',   'R2394 Staff',   'support', true);

insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label, opening_balance, opening_as_of) values
  ('c4c4c4c4-0000-0000-0000-0000002394a1', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'c4c4c4c4-0000-0000-0000-000000239401', 'savings',     'A Savings', 50000, '2026-03-31'),
  ('c4c4c4c4-0000-0000-0000-0000002394a2', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'c4c4c4c4-0000-0000-0000-000000239401', 'credit_card', 'A Card',    12000, '2026-03-31'),
  ('c4c4c4c4-0000-0000-0000-0000002394a3', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'c4c4c4c4-0000-0000-0000-000000239401', 'cash',        'A Cash',        0, '2026-03-31'),
  ('c4c4c4c4-0000-0000-0000-0000002394a4', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'c4c4c4c4-0000-0000-0000-000000239401', 'current',     'A Current',     0, '2026-03-31'),
  ('c4c4c4c4-0000-0000-0000-0000002394b1', 'c4c4c4c4-0000-0000-0000-0000002394f0', 'c4c4c4c4-0000-0000-0000-000000239402', 'savings',     'B Savings', 10000, null);

set local role authenticated;

do $$
declare
  v_a    uuid := 'c4c4c4c4-0000-0000-0000-000000239401';
  v_b    uuid := 'c4c4c4c4-0000-0000-0000-000000239402';
  v_st   uuid := 'c4c4c4c4-0000-0000-0000-000000239403';
  v_t    uuid := 'c4c4c4c4-0000-0000-0000-0000002394f0';
  v_sav  uuid := 'c4c4c4c4-0000-0000-0000-0000002394a1';
  v_card uuid := 'c4c4c4c4-0000-0000-0000-0000002394a2';
  v_cash uuid := 'c4c4c4c4-0000-0000-0000-0000002394a3';
  v_cur  uuid := 'c4c4c4c4-0000-0000-0000-0000002394a4';
  v_home uuid;
  v_lic  uuid;
  v_batch jsonb;
  r      jsonb;
  n      integer;
  v_bal  bigint;
  v_id   uuid;
  v_kind text;
  v_cat  text;
  v_blocked boolean;
  v_who  text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  -- A already typed the LIC premium on Income & Expenses, on this account.
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, category, amount, occurred_on, account_id, note)
    values (v_t, v_a, 'expense', 'Insurance Premium', 5000, '2026-04-09', v_sav, 'LIC premium')
    returning id into v_lic;
  -- …and has a home loan (₹20 L, 8.5%, EMI ₹17,356) paid from savings.
  insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal,
                                     start_date, annual_rate, repay_type, tenure_months, emi_amount, account_id)
    values (v_t, v_a, 'taken', 'home', 'SBI Home Loan', 2000000, '2026-03-01', 8.5, 'emi', 240, 17356, v_sav)
    returning id into v_home;

  ------------------------------------------- 1. import
  v_batch := jsonb_build_object('account_id', v_sav, 'file_name', 'apr.csv', 'file_kind', 'csv',
    'statement_from', '2026-04-01', 'statement_to', '2026-04-09', 'rows', jsonb_build_array(
    jsonb_build_object('kind','salary','amount',85000,'occurred_on','2026-04-01','dedupe_hash','h01','raw_description','SALARY APR ACME','category','Salary','balance_after',135000),
    jsonb_build_object('kind','expense','amount',450,'occurred_on','2026-04-02','dedupe_hash','h02','raw_description','UPI-SWIGGY-ORDER 1','balance_after',134550),
    jsonb_build_object('kind','card_payment','amount',12000,'occurred_on','2026-04-03','dedupe_hash','h03','raw_description','CC PAYMENT XX1234','balance_after',122550),
    jsonb_build_object('kind','atm_cash','amount',2000,'occurred_on','2026-04-04','dedupe_hash','h04','raw_description','NWD ATM CASH','balance_after',120550),
    jsonb_build_object('kind','transfer_out','amount',10000,'occurred_on','2026-04-05','dedupe_hash','h05','raw_description','IMPS SELF','balance_after',110550),
    jsonb_build_object('kind','expense','amount',17356,'occurred_on','2026-04-05','dedupe_hash','h06','raw_description','SBI HOME LOAN EMI','balance_after',93194),
    jsonb_build_object('kind','other_income','amount',500000,'occurred_on','2026-04-06','dedupe_hash','h07','raw_description','NEFT BUYER ADVANCE','balance_after',593194),
    jsonb_build_object('kind','expense','amount',320,'occurred_on','2026-04-07','dedupe_hash','h08','raw_description','UPI-SWIGGY-ORDER 2','balance_after',592874),
    jsonb_build_object('kind','other_income','amount',50000,'occurred_on','2026-04-08','dedupe_hash','h09','raw_description','NEFT FROM MY COMPANY','balance_after',642874),
    jsonb_build_object('kind','expense','amount',5000,'occurred_on','2026-04-09','dedupe_hash','h10','raw_description','LIC OF INDIA PREMIUM','balance_after',637874)));
  r := public.personal_import_commit(v_batch);
  if (r->>'inserted')::int <> 10 then raise exception 'FAIL 1: inserted %', r; end if;
  select count(*) into n from public.personal_transactions where account_id = v_sav and source = 'import' and line_no between 1 and 10;
  if n <> 10 then raise exception 'FAIL 1: % lines carry line_no 1..10', n; end if;
  select line_no into n from public.personal_transactions where dedupe_hash = 'h06';
  if n <> 6 then raise exception 'FAIL 1: EMI line has line_no %, expected 6', n; end if;
  r := public.personal_import_commit(v_batch);
  if (r->>'inserted')::int <> 0 or (r->>'skipped')::int <> 10 then raise exception 'FAIL 1: re-import %', r; end if;

  ------------------------------------------- 2. balance before matching (LIC counted twice)
  select balance into v_bal from public.personal_account_balances where account_id = v_sav;
  if v_bal <> 632874 then raise exception 'FAIL 2: balance % before match, expected 632874', v_bal; end if;
  select count(*) into n from public.personal_transactions where account_id = v_sav and source = 'import' and reconciled_at is null;
  if n <> 10 then raise exception 'FAIL 2: % unmatched, expected 10', n; end if;

  ------------------------------------------- 3. reconcile
  select id into v_id from public.personal_transactions where dedupe_hash = 'h01';
  perform public.personal_bank_reconcile(v_id, 'income', jsonb_build_object('income_source', 'salary', 'party', 'ACME'));
  select kind into v_kind from public.personal_transactions where id = v_id and income_source = 'salary' and reconciled_at is not null;
  if v_kind is distinct from 'salary' then raise exception 'FAIL 3 income: kind %', v_kind; end if;

  -- expense + rule; the other SWIGGY line gets the suggestion
  select id into v_id from public.personal_transactions where dedupe_hash = 'h02';
  r := public.personal_bank_reconcile(v_id, 'expense', jsonb_build_object('category', 'Food / Dining', 'rule_text', 'SWIGGY'));
  if (r->>'suggested')::int <> 1 then raise exception 'FAIL 3 rule: suggested %', r; end if;
  select category into v_cat from public.personal_transactions where dedupe_hash = 'h08' and reconciled_at is null;
  if v_cat is distinct from 'Food / Dining' then raise exception 'FAIL 3 rule: other SWIGGY line category %', v_cat; end if;
  select count(*) into n from public.personal_category_rules where owner_user_id = v_a and match_text = 'SWIGGY' and category = 'Food / Dining';
  if n <> 1 then raise exception 'FAIL 3 rule: rule not saved'; end if;

  -- expense on money IN is refused
  select id into v_id from public.personal_transactions where dedupe_hash = 'h09';
  v_blocked := false;
  begin
    perform public.personal_bank_reconcile(v_id, 'expense', jsonb_build_object('category', 'Shopping'));
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: expense accepted on money in'; end if;
  perform public.personal_bank_reconcile(v_id, 'drawing', '{}'::jsonb);

  -- card payment → card owed 12,000 → 0
  select id into v_id from public.personal_transactions where dedupe_hash = 'h03';
  r := public.personal_bank_reconcile(v_id, 'card_payment', jsonb_build_object('other_account_id', v_card));
  select balance into v_bal from public.personal_account_balances where account_id = v_card;
  if v_bal <> 0 then raise exception 'FAIL 3 card: card owed % after payment, expected 0', v_bal; end if;

  -- ATM cash → cash account +2,000
  select id into v_id from public.personal_transactions where dedupe_hash = 'h04';
  perform public.personal_bank_reconcile(v_id, 'atm_cash', jsonb_build_object('other_account_id', v_cash));
  select balance into v_bal from public.personal_account_balances where account_id = v_cash;
  if v_bal <> 2000 then raise exception 'FAIL 3 atm: cash balance %', v_bal; end if;

  -- transfer → current +10,000, both legs paired
  select id into v_id from public.personal_transactions where dedupe_hash = 'h05';
  r := public.personal_bank_reconcile(v_id, 'transfer', jsonb_build_object('other_account_id', v_cur));
  select balance into v_bal from public.personal_account_balances where account_id = v_cur;
  if v_bal <> 10000 then raise exception 'FAIL 3 transfer: current balance %', v_bal; end if;
  select count(*) into n from public.personal_transactions x
   where x.id = (r->>'pair_tx_id')::uuid and x.pair_tx_id = v_id and x.kind = 'transfer_in' and x.auto_pair;
  if n <> 1 then raise exception 'FAIL 3 transfer: pair leg missing'; end if;

  -- loan EMI → scheduled split; line merges into the loan rows
  select id into v_id from public.personal_transactions where dedupe_hash = 'h06';
  r := public.personal_bank_reconcile(v_id, 'loan', jsonb_build_object('loan_id', v_home));
  select count(*) into n from public.personal_transactions where id = v_id;
  if n <> 0 then raise exception 'FAIL 3 loan: imported row still there'; end if;
  select count(*) into n from public.personal_transactions
   where account_id = v_sav and dedupe_hash = 'h06' and kind = 'transfer_out' and amount = 3189 and reconciled_at is not null;
  if n <> 1 then raise exception 'FAIL 3 loan: principal row does not carry the bank line'; end if;
  select count(*) into n from public.personal_transactions
   where account_id = v_sav and kind = 'expense' and category = 'Loan EMI' and amount = 14167 and reconciled_at is not null;
  if n <> 1 then raise exception 'FAIL 3 loan: interest row missing'; end if;
  select outstanding into v_bal from public.personal_loan_balances where loan_id = v_home;
  if v_bal <> 1996811 then raise exception 'FAIL 3 loan: outstanding %', v_bal; end if;

  -- byana → new advance entry of 5,00,000
  select id into v_id from public.personal_transactions where dedupe_hash = 'h07';
  perform public.personal_bank_reconcile(v_id, 'owe_hold', jsonb_build_object('hold_kind', 'advance_received', 'party', 'Plot buyer'));
  select count(*) into n from public.personal_owe_hold o
    join public.personal_transactions x on x.owe_hold_id = o.id
   where x.id = v_id and o.amount = 500000 and o.status = 'open' and o.account_id = v_sav and x.kind = 'transfer_in';
  if n <> 1 then raise exception 'FAIL 3 byana: owe/hold entry not linked'; end if;

  -- match → merges into the typed LIC entry
  select id into v_id from public.personal_transactions where dedupe_hash = 'h10';
  r := public.personal_bank_reconcile(v_id, 'match', jsonb_build_object('match_tx_id', v_lic));
  if (r->>'tx_id')::uuid <> v_lic then raise exception 'FAIL 3 match: %', r; end if;
  select count(*) into n from public.personal_transactions where id = v_lic and dedupe_hash = 'h10' and source = 'import' and reconciled_at is not null;
  if n <> 1 then raise exception 'FAIL 3 match: typed entry does not carry the bank line'; end if;

  ------------------------------------------- 4. balance = statement
  select balance into v_bal from public.personal_account_balances where account_id = v_sav;
  if v_bal <> 637874 then raise exception 'FAIL 4: balance % after matching, expected 637874 (statement)', v_bal; end if;
  select count(*) into n from public.personal_transactions where account_id = v_sav and source = 'import' and reconciled_at is null;
  if n <> 1 then raise exception 'FAIL 4: % unmatched, expected 1 (the second SWIGGY)', n; end if;
  r := public.personal_import_commit(v_batch);
  if (r->>'inserted')::int <> 0 then raise exception 'FAIL 4: re-import after matching added % lines', r->>'inserted'; end if;

  ------------------------------------------- 5. refusals and undo
  select id into v_id from public.personal_transactions where dedupe_hash = 'h01';
  v_blocked := false;
  begin
    perform public.personal_bank_reconcile(v_id, 'income', jsonb_build_object('income_source', 'other'));
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: a matched line was matched again'; end if;

  select id into v_id from public.personal_transactions where pair_tx_id is not null and auto_pair and account_id = v_cash;
  v_blocked := false;
  begin
    perform public.personal_bank_reconcile(v_id, 'expense', jsonb_build_object('category', 'Shopping'));
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: a typed entry was reconciled as a statement line'; end if;

  select id into v_id from public.personal_transactions where dedupe_hash = 'h03';
  perform public.personal_bank_unreconcile(v_id);
  select balance into v_bal from public.personal_account_balances where account_id = v_card;
  if v_bal <> 12000 then raise exception 'FAIL 5 undo: card owed % after undo, expected 12000', v_bal; end if;
  select count(*) into n from public.personal_transactions where id = v_id and reconciled_at is null and pair_tx_id is null;
  if n <> 1 then raise exception 'FAIL 5 undo: line still matched'; end if;

  select id into v_id from public.personal_transactions where dedupe_hash = 'h06';
  v_blocked := false;
  begin
    perform public.personal_bank_unreconcile(v_id);
  exception when invalid_parameter_value then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: undo of a loan line was not sent to the Loans page'; end if;

  ------------------------------------------- 6. B and staff see nothing of A's
  select id into v_id from public.personal_transactions where dedupe_hash = 'h08';
  foreach v_who in array array[v_b::text, v_st::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    select count(*) into n from public.personal_transactions where owner_user_id = v_a;
    if n <> 0 then raise exception 'FAIL 6: user % sees % of A''s lines', v_who, n; end if;
    select count(*) into n from public.personal_account_balances where owner_user_id = v_a;
    if n <> 0 then raise exception 'FAIL 6: user % sees A''s balances', v_who; end if;
    v_blocked := false;
    begin
      perform public.personal_bank_reconcile(v_id, 'expense', jsonb_build_object('category', 'Shopping'));
    exception when no_data_found then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 6: user % reconciled A''s line', v_who; end if;
    v_blocked := false;
    begin
      perform public.personal_import_commit(jsonb_build_object('account_id', v_sav, 'rows', jsonb_build_array(
        jsonb_build_object('kind','expense','amount',1,'occurred_on','2026-04-10','dedupe_hash','planted'))));
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 6: user % imported into A''s account', v_who; end if;
  end loop;

  raise notice 'R-2394 personal banking: all checks passed';
end $$;

rollback;
