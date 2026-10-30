-- Regression test for R-2127 (GP-12a) — migration 20261030021200_gp12a_personal_ledger.sql
--
-- WHAT THIS PROVES
--   1. A transaction owned by user A that points at user B's account is refused by the
--      composite FK (account_id, owner_user_id) → personal_accounts(id, owner_user_id).
--      RLS alone does not stop this: a service-role import (or a superuser script) runs
--      without RLS, and the old single-column FK accepted ANY account id.
--   2. personal_account_balances.balance = opening_balance + credits - debits.
--   3. card_payment, transfers and ATM cash move the balance but are NOT spend.
--   4. Old rows (drawing / dividend / expense ...) still pass the widened kind CHECK, and
--      an unknown kind is still refused.
--   5. A credit card's balance is what is OWED (positive), same convention as
--      personal_accounts.balance: charges raise it, payments and refunds lower it.
--   6. The dedupe key refuses the same statement line twice for one account.
--   7. Owner B (same tenant, also owner) sees 0 rows of A's balances view.
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2c2c2c2-0000-0000-0000-000000012a01', 'gp12a-owner-a@example.test'),
  ('c2c2c2c2-0000-0000-0000-000000012a02', 'gp12a-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c2c2c2c2-0000-0000-0000-000000012af0', 'GP12A T', 'gp12a@example.test', '07', 'GP12');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2c2c2c2-0000-0000-0000-000000012a01', 'c2c2c2c2-0000-0000-0000-000000012af0', 'gp12a-owner-a@example.test', 'GP12A Owner A', 'owner', true),
  ('c2c2c2c2-0000-0000-0000-000000012a02', 'c2c2c2c2-0000-0000-0000-000000012af0', 'gp12a-owner-b@example.test', 'GP12A Owner B', 'owner', true);

-- A: savings (opening 10,000) and a credit card (opening owed 2,000). B: one savings.
insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label, opening_balance) values
  ('c2c2c2c2-0000-0000-0000-000000012ab1', 'c2c2c2c2-0000-0000-0000-000000012af0', 'c2c2c2c2-0000-0000-0000-000000012a01', 'savings',     'A Savings', 10000),
  ('c2c2c2c2-0000-0000-0000-000000012ab2', 'c2c2c2c2-0000-0000-0000-000000012af0', 'c2c2c2c2-0000-0000-0000-000000012a01', 'credit_card', 'A Card',     2000),
  ('c2c2c2c2-0000-0000-0000-000000012bb1', 'c2c2c2c2-0000-0000-0000-000000012af0', 'c2c2c2c2-0000-0000-0000-000000012a02', 'savings',     'B Savings',  500);

do $$
declare
  v_t   uuid := 'c2c2c2c2-0000-0000-0000-000000012af0';
  v_a   uuid := 'c2c2c2c2-0000-0000-0000-000000012a01';
  v_b   uuid := 'c2c2c2c2-0000-0000-0000-000000012a02';
  v_sav uuid := 'c2c2c2c2-0000-0000-0000-000000012ab1';
  v_cc  uuid := 'c2c2c2c2-0000-0000-0000-000000012ab2';
  v_bsv uuid := 'c2c2c2c2-0000-0000-0000-000000012bb1';
  v_blocked boolean;
  v_msg text;
  r record;
begin
  ------------------------------------------- 1. cross-owner txn refused by the composite FK
  v_blocked := false;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, account_id)
      values (v_t, v_a, 'expense', 100, current_date, v_bsv);   -- A's row, B's account
  exception when foreign_key_violation then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 1: owner A''s transaction was saved against owner B''s account — the composite FK (account_id, owner_user_id) is missing';
  end if;
  if v_msg not like '%personal_transactions_account_owner_fkey%' then
    raise exception 'FAIL 1: blocked, but not by the composite FK: %', v_msg;
  end if;

  ------------------------------------------- 4. old kinds still pass, unknown kind still refused
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, account_id) values
    (v_t, v_a, 'drawing',  3000, current_date, v_sav),   -- credit
    (v_t, v_a, 'dividend', 1000, current_date, v_sav),   -- credit
    (v_t, v_a, 'expense',   400, current_date, v_sav),   -- debit, spend
    (v_t, v_a, 'expense',   600, current_date, v_sav),   -- debit, spend
    (v_t, v_a, 'refund',    100, current_date, v_sav),   -- credit, lowers spend
    (v_t, v_a, 'transfer_in',  700, current_date, v_sav),-- credit, not spend
    (v_t, v_a, 'transfer_out', 200, current_date, v_sav),-- debit, not spend
    (v_t, v_a, 'atm_cash',     500, current_date, v_sav),-- debit, not spend
    (v_t, v_a, 'card_payment', 1500, current_date, v_sav),-- debit from savings, not spend
    -- the card: owed opening 2,000; +900 charge, -1,500 payment, -50 refund → owed 1,350
    (v_t, v_a, 'expense',       900, current_date, v_cc),
    (v_t, v_a, 'card_payment', 1500, current_date, v_cc),
    (v_t, v_a, 'refund',         50, current_date, v_cc);

  v_blocked := false;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, account_id)
      values (v_t, v_a, 'lottery', 1, current_date, v_sav);
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: an unknown kind was accepted — the CHECK was dropped, not widened'; end if;

  ------------------------------------------- 6. same statement line twice → refused
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, account_id, source, dedupe_hash, raw_description, reference, balance_after)
    values (v_t, v_a, 'expense', 1, current_date, v_cc, 'import', 'h-1', 'UPI/SWIGGY', 'UTR1', 0);
  v_blocked := false;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, account_id, source, dedupe_hash)
      values (v_t, v_a, 'expense', 1, current_date, v_cc, 'import', 'h-1');
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: the same statement line (dedupe_hash) was imported twice into one account'; end if;
  delete from public.personal_transactions where dedupe_hash = 'h-1';

  ------------------------------------------- 2/3. savings: balance = opening + credits - debits
  -- credits 3000+1000+100+700 = 4800; debits 400+600+200+500+1500 = 3200
  select * into r from public.personal_account_balances where account_id = v_sav;
  if r.credits <> 4800 or r.debits <> 3200 then
    raise exception 'FAIL 2: savings credits/debits = %/% , expected 4800/3200', r.credits, r.debits;
  end if;
  if r.balance <> 10000 + 4800 - 3200 then
    raise exception 'FAIL 2: savings balance = %, expected opening + credits - debits = 11600', r.balance;
  end if;
  if r.spend <> 900 then
    raise exception 'FAIL 3: savings spend = %, expected 900 (expenses 1000 - refund 100; card_payment, transfers and ATM cash are not spend)', r.spend;
  end if;

  ------------------------------------------- 5. credit card: balance is what is owed
  select * into r from public.personal_account_balances where account_id = v_cc;
  if r.balance <> 1350 then
    raise exception 'FAIL 5: card owed = %, expected 2000 + 900 - 1500 - 50 = 1350', r.balance;
  end if;
  if r.spend <> 850 then
    raise exception 'FAIL 5: card spend = %, expected 850 (card_payment is not spend)', r.spend;
  end if;

  ------------------------------------------- an account with no rows still shows its opening
  select * into r from public.personal_account_balances where account_id = v_bsv;
  if r.balance is distinct from 500::bigint then
    raise exception 'FAIL 2: an account with no transactions shows %, expected its opening 500', r.balance;
  end if;
end $$;

------------------------------------------- 7. the view runs as the caller: B sees none of A's
set local role authenticated;
do $$
declare n integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2c2c2c2-0000-0000-0000-000000012a02', 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_account_balances
   where owner_user_id = 'c2c2c2c2-0000-0000-0000-000000012a01';
  if n <> 0 then
    raise exception 'FAIL 7: owner B reads % of owner A''s balance rows — the view is not security_invoker', n;
  end if;
  select count(*) into n from public.personal_account_balances;
  if n <> 1 then raise exception 'FAIL 7: owner B should see exactly their own 1 account, sees %', n; end if;
end $$;

select 'PASS' as gp12a_personal_ledger;

rollback;
