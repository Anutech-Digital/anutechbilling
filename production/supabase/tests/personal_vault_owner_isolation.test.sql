-- Regression test for migration 20260819170000_owner_personal_vault.sql
--
-- WHAT THIS PROVES, AND WHY IT IS THE ONLY TEST THAT MATTERS HERE
--   The Private Vault holds one person's bank balances, household spending and net
--   worth. The page has a role check and a PIN, and **neither of those protects the
--   data** — a role check lives in React and a PIN is a screen lock. The only thing
--   standing between one director's net worth and another's curiosity is the RLS
--   policy `owner_user_id = auth.uid()`.
--
--   So the claim "zero data leaks to staff" is worth exactly as much as this file.
--
--   The case that would be missed by an ordinary tenant-isolation test is CASE 2: a
--   SECOND OWNER in the SAME TENANT. Every other table in this schema is deliberately
--   readable by the whole tenant, so the reflex when writing a policy here is
--   `tenant_id = current_tenant_id()` — which passes a tenant-isolation test and hands
--   Pardeep's bank balance to Deepak. Measured on production: ANUTECH has THREE users
--   with role = 'owner'.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. Owner A sees their own rows.                                    ← not over-blocked
--   2. Owner B, same tenant, ALSO role=owner, sees ZERO.               ← the headline
--   3. A support user sees ZERO.                                       ← staff
--   4. Owner B cannot INSERT into Owner A's vault.                     ← with_check
--   5. Owner B cannot UPDATE Owner A's holding.                        ← silent no-op
--   6. Owner B cannot DELETE Owner A's account.                        ← silent no-op
--   7. The PIN row is isolated the same way (filtered or no grant).    ← lock is private
--   8. Owner A can still write their own rows.                         ← feature works
--   9. personal_account_balances (R-2127) is private the same way.     ← computed view
--  10. Import batches, categories and category rules (R-2128) too.     ← import tables
--
-- ON ASSERTING "0 ROWS" — usually a weak assertion, correct here.
--   RLS does not raise on a filtered SELECT/UPDATE/DELETE; it silently narrows. So for
--   reads the count IS the observable, and for writes this file does something stronger
--   than counting affected rows: it switches BACK to the owner and re-reads the value,
--   proving the row is untouched rather than merely that the writer was told nothing.
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.
-- No real row is read into an assertion or written.

begin;

insert into auth.users (id, email) values
  ('c2c2c2c2-0000-0000-0000-0000000000a1', 'vault-owner-a@example.test'),
  ('c2c2c2c2-0000-0000-0000-0000000000a2', 'vault-owner-b@example.test'),
  ('c2c2c2c2-0000-0000-0000-0000000000a3', 'vault-support@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c2c2c2c2-0000-0000-0000-0000000000f0', 'VAULT T', 'vault@example.test', '07', 'VLT1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2c2c2c2-0000-0000-0000-0000000000a1', 'c2c2c2c2-0000-0000-0000-0000000000f0', 'vault-owner-a@example.test', 'Vault Owner A', 'owner',   true),
  -- SAME TENANT, SAME ROLE. This is the row that makes the test worth writing.
  ('c2c2c2c2-0000-0000-0000-0000000000a2', 'c2c2c2c2-0000-0000-0000-0000000000f0', 'vault-owner-b@example.test', 'Vault Owner B', 'owner',   true),
  ('c2c2c2c2-0000-0000-0000-0000000000a3', 'c2c2c2c2-0000-0000-0000-0000000000f0', 'vault-support@example.test','Vault Support', 'support', true);

-- Owner A's private data, inserted before RLS is switched on for the session so the
-- fixture itself is not what is under test.
insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label, balance) values
  ('c2c2c2c2-0000-0000-0000-0000000000b1', 'c2c2c2c2-0000-0000-0000-0000000000f0',
   'c2c2c2c2-0000-0000-0000-0000000000a1', 'savings', 'A HDFC Savings', 4200000);

insert into public.personal_holdings (id, tenant_id, owner_user_id, asset_class, name, invested, current_value) values
  ('c2c2c2c2-0000-0000-0000-0000000000b2', 'c2c2c2c2-0000-0000-0000-0000000000f0',
   'c2c2c2c2-0000-0000-0000-0000000000a1', 'real_estate', 'A Dwarka flat', 8000000, 12500000);

insert into public.personal_transactions (id, tenant_id, owner_user_id, kind, amount, occurred_on) values
  ('c2c2c2c2-0000-0000-0000-0000000000b3', 'c2c2c2c2-0000-0000-0000-0000000000f0',
   'c2c2c2c2-0000-0000-0000-0000000000a1', 'drawing', 350000, current_date);

insert into public.personal_vault_pin (user_id, tenant_id, pin_hash, pin_salt) values
  ('c2c2c2c2-0000-0000-0000-0000000000a1', 'c2c2c2c2-0000-0000-0000-0000000000f0', 'deadbeef', 'cafe');

-- R-2128: one import batch, one own category, one private rule for owner A.
insert into public.personal_import_batches (id, tenant_id, owner_user_id, account_id, file_name, inserted_count) values
  ('c2c2c2c2-0000-0000-0000-0000000000b4', 'c2c2c2c2-0000-0000-0000-0000000000f0',
   'c2c2c2c2-0000-0000-0000-0000000000a1', 'c2c2c2c2-0000-0000-0000-0000000000b1', 'a-hdfc.csv', 0);
insert into public.personal_categories (tenant_id, owner_user_id, name, direction) values
  ('c2c2c2c2-0000-0000-0000-0000000000f0', 'c2c2c2c2-0000-0000-0000-0000000000a1', 'A Pets', 'expense');
insert into public.personal_category_rules (tenant_id, owner_user_id, match_text, category) values
  ('c2c2c2c2-0000-0000-0000-0000000000f0', 'c2c2c2c2-0000-0000-0000-0000000000a1', 'clinic', 'Health');

-- `authenticated` is the role a real browser token arrives as, so RLS is genuinely
-- enforced from here on. A superuser connection bypasses RLS and would prove nothing.
set local role authenticated;

do $$
declare
  v_a       uuid := 'c2c2c2c2-0000-0000-0000-0000000000a1';
  v_b       uuid := 'c2c2c2c2-0000-0000-0000-0000000000a2';
  v_support uuid := 'c2c2c2c2-0000-0000-0000-0000000000a3';
  v_tenant  uuid := 'c2c2c2c2-0000-0000-0000-0000000000f0';
  n         integer;
  v_bal     bigint;
  v_val     bigint;
  v_blocked boolean;
  v_msg     text;
begin
  ---------------------------------------------------------------- 1. owner A sees their own
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  if auth.uid() <> v_a then
    raise exception 'SETUP FAIL: auth.uid() is % — the impersonation did not take', auth.uid();
  end if;

  select count(*) into n from public.personal_accounts;
  if n <> 1 then raise exception 'FAIL 1: owner A sees % of their own accounts, expected 1 — over-blocked', n; end if;

  select count(*) into n from public.personal_holdings;
  if n <> 1 then raise exception 'FAIL 1: owner A sees % of their own holdings, expected 1', n; end if;

  select count(*) into n from public.personal_transactions;
  if n <> 1 then raise exception 'FAIL 1: owner A sees % of their own transactions, expected 1', n; end if;

  select count(*) into n from public.personal_vault_pin;
  if n <> 1 then raise exception 'FAIL 1: owner A cannot see their own PIN row (got %)', n; end if;

  --------------------------------------------- 2. THE HEADLINE: a second OWNER sees nothing
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);

  select count(*) into n from public.personal_accounts;
  if n <> 0 then
    raise exception 'FAIL 2: a SECOND OWNER in the same tenant can read % personal account(s). The policy is tenant- or role-scoped instead of auth.uid()-scoped — this is the leak the whole feature exists to prevent.', n;
  end if;

  select count(*) into n from public.personal_holdings;
  if n <> 0 then raise exception 'FAIL 2: a second owner can read % holding(s) — net worth is visible to co-directors', n; end if;

  select count(*) into n from public.personal_transactions;
  if n <> 0 then raise exception 'FAIL 2: a second owner can read % transaction(s) — drawings and household spending are visible', n; end if;

  select count(*) into n from public.personal_vault_pin;
  if n <> 0 then raise exception 'FAIL 2: a second owner can read % PIN row(s)', n; end if;

  ---------------------------------------------------------------- 3. staff see nothing
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_support::text, 'role', 'authenticated')::text, true);

  select count(*) into n from public.personal_accounts;
  if n <> 0 then raise exception 'FAIL 3: a support user can read % personal account(s)', n; end if;
  select count(*) into n from public.personal_holdings;
  if n <> 0 then raise exception 'FAIL 3: a support user can read % holding(s)', n; end if;
  select count(*) into n from public.personal_transactions;
  if n <> 0 then raise exception 'FAIL 3: a support user can read % transaction(s)', n; end if;

  ------------------------------------------- 4. owner B cannot plant a row in A's vault
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);

  v_blocked := false;
  begin
    insert into public.personal_accounts (tenant_id, owner_user_id, kind, label, balance)
      values (v_tenant, v_a, 'savings', 'planted by B', 1);
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 4: owner B inserted a row owned by owner A — with_check is missing or wrong';
  end if;
  if v_msg not like '%row-level security%' then
    raise exception 'FAIL 4: blocked, but not by RLS: %', v_msg;
  end if;

  ------------------------------------------- 5. owner B cannot change A's holding value
  update public.personal_holdings set current_value = 1 where id = 'c2c2c2c2-0000-0000-0000-0000000000b2';

  -- Read it back AS OWNER A. "0 rows affected" would also be true if the id were wrong;
  -- the value being untouched is the assertion that cannot pass for the wrong reason.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select current_value into v_val from public.personal_holdings where id = 'c2c2c2c2-0000-0000-0000-0000000000b2';
  if v_val <> 12500000 then
    raise exception 'FAIL 5: owner B changed owner A''s holding value to % — the UPDATE policy is not auth.uid()-scoped', v_val;
  end if;

  ------------------------------------------- 6. owner B cannot delete A's account
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  delete from public.personal_accounts where id = 'c2c2c2c2-0000-0000-0000-0000000000b1';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_accounts where id = 'c2c2c2c2-0000-0000-0000-0000000000b1';
  if n <> 1 then
    raise exception 'FAIL 6: owner B deleted owner A''s account — the DELETE policy is not auth.uid()-scoped';
  end if;

  ------------------------------------------- 7. owner B cannot overwrite A's PIN
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  -- Two correct outcomes: RLS silently filters the row (old grants), or the request role
  -- has no UPDATE on the table at all (GP-02b / R-2112 moves PIN writes server-side and
  -- revokes it). Either way the assertion below — A's hash untouched — is what counts.
  begin
    update public.personal_vault_pin set pin_hash = 'hijacked' where user_id = v_a;
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_vault_pin where user_id = v_a and pin_hash = 'deadbeef';
  if n <> 1 then
    raise exception 'FAIL 7: owner B rewrote owner A''s PIN hash — anyone could replace the lock';
  end if;

  ------------------------------------------- 8. and the feature still works for its owner
  begin
    insert into public.personal_accounts (tenant_id, owner_user_id, kind, label, balance)
      values (v_tenant, v_a, 'credit_card', 'A ICICI Card', 80000);
  exception when others then
    raise exception 'FAIL 8: owner A cannot write their OWN row — the policy is over-tight and the feature is unusable: %', sqlerrm;
  end;

  select count(*) into n from public.personal_accounts;
  if n <> 2 then raise exception 'FAIL 8: owner A should now see 2 accounts, sees %', n; end if;

  select balance into v_bal from public.personal_accounts where label = 'A ICICI Card';
  if v_bal <> 80000 then raise exception 'FAIL 8: card balance stored as % — expected 80000 whole rupees', v_bal; end if;

  ------------------------------------------- 9. the computed balances view (R-2127) is private too
  select count(*) into n from public.personal_account_balances;
  if n <> 2 then raise exception 'FAIL 9: owner A should see their 2 balance rows, sees %', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_account_balances;
  if n <> 0 then
    raise exception 'FAIL 9: a second owner reads % row(s) of personal_account_balances — the view must be security_invoker so the owner_user_id = auth.uid() policy applies', n;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_support::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_account_balances;
  if n <> 0 then raise exception 'FAIL 9: a support user reads % balance row(s)', n; end if;

  ------------------------------------------- 10. import tables (R-2128) are private the same way
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_import_batches;
  if n <> 1 then raise exception 'FAIL 10: owner A should see their 1 import batch, sees %', n; end if;
  select count(*) into n from public.personal_category_rules;
  if n <> 1 then raise exception 'FAIL 10: owner A should see their 1 category rule, sees %', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_import_batches;
  if n <> 0 then raise exception 'FAIL 10: a second owner reads % import batch(es)', n; end if;
  select count(*) into n from public.personal_categories;
  if n <> 0 then raise exception 'FAIL 10: a second owner reads % personal categor(ies)', n; end if;
  select count(*) into n from public.personal_category_rules;
  if n <> 0 then raise exception 'FAIL 10: a second owner reads % private category rule(s)', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_support::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_category_rules;
  if n <> 0 then raise exception 'FAIL 10: a support user reads % private category rule(s)', n; end if;
  select count(*) into n from public.personal_categories;
  if n <> 0 then raise exception 'FAIL 10: a support user reads % personal categor(ies)', n; end if;

  raise notice 'PASS — all 10 cases';
end $$;

-- Single visible result, so a green run is unmistakable.
select 'PASS' as personal_vault_owner_isolation;

rollback;
