-- Regression test for R-2387 — migration 20261102175100_r2387_personal_income_source.sql
--
-- WHAT THIS PROVES
--   1. Every one of the 10 income sources saves on its own kind (rent → other_income,
--      salary → salary, refund → refund …), with party and repeat_monthly.
--   2. An unknown source is refused by personal_transactions_income_source_check.
--   3. A source on the WRONG kind is refused (rent on 'salary', salary on 'expense') — the
--      source cannot drift from the kind that drives the balance.
--   4. A party longer than 120 characters is refused.
--   5. Owner B (same tenant, ALSO role owner) sees ZERO of owner A's income rows, and
--      cannot insert a row stamped as A — the owner RLS covers the new columns too.
--   6. Owner A, through RLS, sees all of their own rows.
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2c2c2c2-0000-0000-0000-000000238701', 'r2387-owner-a@example.test'),
  ('c2c2c2c2-0000-0000-0000-000000238702', 'r2387-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c2c2c2c2-0000-0000-0000-0000002387f0', 'R2387 T', 'r2387@example.test', '07', 'R238');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2c2c2c2-0000-0000-0000-000000238701', 'c2c2c2c2-0000-0000-0000-0000002387f0', 'r2387-owner-a@example.test', 'R2387 Owner A', 'owner', true),
  ('c2c2c2c2-0000-0000-0000-000000238702', 'c2c2c2c2-0000-0000-0000-0000002387f0', 'r2387-owner-b@example.test', 'R2387 Owner B', 'owner', true);

do $$
declare
  v_t uuid := 'c2c2c2c2-0000-0000-0000-0000002387f0';
  v_a uuid := 'c2c2c2c2-0000-0000-0000-000000238701';
  v_blocked boolean;
  v_msg text;
  n int;
begin
  ------------------------------------------- 1. all ten sources on their own kind
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, income_source, amount, occurred_on, party, repeat_monthly) values
    (v_t, v_a, 'salary',       'salary',        90000, date '2026-10-01', 'Acme Pvt Ltd', true),
    (v_t, v_a, 'other_income', 'rent',          20000, date '2026-10-05', 'Tenant Sharma', true),
    (v_t, v_a, 'interest',     'interest',       1200, date '2026-10-06', 'SBI', false),
    (v_t, v_a, 'dividend',     'dividend',       3000, date '2026-10-07', null, false),
    (v_t, v_a, 'other_income', 'business',      15000, date '2026-10-08', 'Freelance client', false),
    (v_t, v_a, 'other_income', 'agriculture',    8000, date '2026-10-09', null, false),
    (v_t, v_a, 'other_income', 'capital_gains', 50000, date '2026-10-10', null, false),
    (v_t, v_a, 'other_income', 'gift',          10000, date '2026-10-11', 'Father', false),
    (v_t, v_a, 'refund',       'refund',          500, date '2026-10-12', 'Amazon', false),
    (v_t, v_a, 'other_income', 'other',           700, date '2026-10-13', null, false);

  select count(*) into n from public.personal_transactions where owner_user_id = v_a and income_source is not null;
  if n <> 10 then raise exception 'FAIL 1: expected 10 income rows, got %', n; end if;

  ------------------------------------------- 2. unknown source refused
  v_blocked := false;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, income_source, amount, occurred_on)
      values (v_t, v_a, 'other_income', 'lottery', 1, current_date);
  exception when check_violation then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then raise exception 'FAIL 2: an unknown income source was accepted'; end if;
  if v_msg not like '%personal_transactions_income_source_check%' then
    raise exception 'FAIL 2: blocked, but not by the income source CHECK: %', v_msg;
  end if;

  ------------------------------------------- 3. source on the wrong kind refused
  v_blocked := false; v_msg := null;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, income_source, amount, occurred_on)
      values (v_t, v_a, 'salary', 'rent', 1, current_date);
  exception when check_violation then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked or v_msg not like '%personal_transactions_income_source_check%' then
    raise exception 'FAIL 3a: rent saved on kind salary (%)', coalesce(v_msg, 'no error');
  end if;

  v_blocked := false; v_msg := null;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, income_source, amount, occurred_on)
      values (v_t, v_a, 'expense', 'salary', 1, current_date);
  exception when check_violation then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked or v_msg not like '%personal_transactions_income_source_check%' then
    raise exception 'FAIL 3b: an income source saved on an expense (%)', coalesce(v_msg, 'no error');
  end if;

  ------------------------------------------- 4. party too long refused
  v_blocked := false; v_msg := null;
  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, party)
      values (v_t, v_a, 'expense', 1, current_date, repeat('x', 121));
  exception when check_violation then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked or v_msg not like '%personal_transactions_party_len_check%' then
    raise exception 'FAIL 4: a 121-character party was accepted (%)', coalesce(v_msg, 'no error');
  end if;
end $$;

------------------------------------------- 5. owner B, same tenant, sees none and cannot stamp A
set local role authenticated;

do $$
declare n int; v_blocked boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2c2c2c2-0000-0000-0000-000000238702', 'role', 'authenticated')::text, true);

  select count(*) into n from public.personal_transactions where income_source is not null;
  if n <> 0 then raise exception 'FAIL 5a: owner B read % of owner A''s income rows', n; end if;

  begin
    insert into public.personal_transactions (tenant_id, owner_user_id, kind, income_source, amount, occurred_on)
      values ('c2c2c2c2-0000-0000-0000-0000002387f0', 'c2c2c2c2-0000-0000-0000-000000238701', 'other_income', 'rent', 1, current_date);
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5b: owner B saved an income row into owner A''s vault'; end if;
end $$;

------------------------------------------- 6. owner A sees all ten
do $$
declare n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2c2c2c2-0000-0000-0000-000000238701', 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_transactions where income_source is not null;
  if n <> 10 then raise exception 'FAIL 6: owner A sees % of their own 10 income rows', n; end if;
end $$;

rollback;
