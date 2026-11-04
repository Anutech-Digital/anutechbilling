-- R-2389 (2 Nov 2026): close_bank_account 403 "permission denied for function ist_today" on
-- staging — migration 20261102184319_r2389_ist_today_grant.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example: staging, Banking → "FD 1234 (broken)" at ₹0 (₹1,00,000 opening, broken on
-- 10 Apr 2026) → Close account. Staging has NO execute on ist_today() for authenticated (Cloud SQL
-- gives no default grants — R-401), local Supabase does. So the test first puts the database in
-- the staging shape (revoke from public / anon / authenticated), then:
--   0. after the migration, authenticated holds EXECUTE on the three helpers.
--   A. staging shape: the owner's Close account fails with "permission denied for function
--      ist_today" (42501) — the exact staging error.
--   B. the migration's grant applied again: the same Close works (inactive, closed_on saved),
--      and Reopen works.
--   C. indian_fiscal_year() with its ist_today() default and salary_expense_date() run as the
--      signed-in user.

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

-- 0. the migration granted all three
do $$
begin
  if not has_function_privilege('authenticated', 'public.ist_today()', 'execute') then
    raise exception 'FAIL 0: authenticated cannot EXECUTE ist_today()';
  end if;
  if not has_function_privilege('authenticated', 'public.indian_fiscal_year(date)', 'execute') then
    raise exception 'FAIL 0: authenticated cannot EXECUTE indian_fiscal_year(date)';
  end if;
  if not has_function_privilege('authenticated', 'public.salary_expense_date(text,date)', 'execute') then
    raise exception 'FAIL 0: authenticated cannot EXECUTE salary_expense_date(text,date)';
  end if;
  raise notice 'PASS 0: the three date helpers are granted to authenticated';
end $$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000238901','R2389 Co','r2389@example.in','07','R2389');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000238901','owner2389@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000238901','dddddddd-0000-0000-0000-000000238901','owner2389@example.in','Owner 2389','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000238901','dddddddd-0000-0000-0000-000000238901','FD 1234 (broken)','HDFC Bank','fixed_deposit', 100000, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000238901','dddddddd-0000-0000-0000-000000238901','bbbbbbbb-0000-0000-0000-000000238901','2026-04-10','FD PREMAT CLOSURE 1234',100000,0,'P1','csv_upload');

-- The staging shape: nothing grants ist_today() to the browser role.
revoke execute on function public.ist_today() from public, anon, authenticated;
do $$ begin
  if has_function_privilege('authenticated', 'public.ist_today()', 'execute') then
    raise exception 'SETUP: authenticated still has EXECUTE on ist_today() after the revoke';
  end if;
end $$;

-- A. staging shape → the owner's Close fails with the staging error
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238901","role":"authenticated"}', true);
do $$
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238901', '2026-04-10', 'FD broken');
  raise exception 'FAIL A: close worked without EXECUTE on ist_today() — the test did not reproduce staging';
exception when insufficient_privilege then
  if sqlerrm not like '%permission denied for function ist_today%' then
    raise exception 'FAIL A: wrong refusal: %', sqlerrm;
  end if;
  raise notice 'PASS A: staging shape reproduced — %', sqlerrm;
end $$;
reset role;

-- B. the migration's grant (same statements) → Close and Reopen work
grant execute on function public.ist_today() to authenticated, service_role;
grant execute on function public.indian_fiscal_year(date) to authenticated, service_role;
grant execute on function public.salary_expense_date(text, date) to authenticated, service_role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000238901","role":"authenticated"}', true);
do $$
declare v_acc public.bank_accounts;
begin
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238901', '2026-04-10', 'FD broken');
  select * into v_acc from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238901';
  if v_acc.is_active or v_acc.closed_on is distinct from date '2026-04-10' or v_acc.closed_note is distinct from 'FD broken' then
    raise exception 'FAIL B: not closed as asked: active=% on=% note=%', v_acc.is_active, v_acc.closed_on, v_acc.closed_note;
  end if;
  perform public.reopen_bank_account('bbbbbbbb-0000-0000-0000-000000238901');
  if not (select is_active from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238901') then
    raise exception 'FAIL B: reopen did not make it active';
  end if;
  -- close with no date: close_bank_account's own ist_today() default path
  perform public.close_bank_account('bbbbbbbb-0000-0000-0000-000000238901', null, null);
  if (select closed_on from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000238901') is distinct from public.ist_today() then
    raise exception 'FAIL B: close with no date did not stamp IST today';
  end if;
  raise notice 'PASS B: with the grant the owner closes and reopens the ₹0 FD';
end $$;

-- C. the other two helpers as the signed-in user
do $$
begin
  if public.indian_fiscal_year() not like 'FY____' then
    raise exception 'FAIL C: indian_fiscal_year() = %', public.indian_fiscal_year();
  end if;
  if public.salary_expense_date('2026-04', null) <> date '2026-04-30' then
    raise exception 'FAIL C: salary_expense_date(2026-04) = %', public.salary_expense_date('2026-04', null);
  end if;
  raise notice 'PASS C: indian_fiscal_year / salary_expense_date callable by authenticated';
end $$;

reset role;
select 'R-2389 ist_today grant: ALL PASS' as result;

rollback;
